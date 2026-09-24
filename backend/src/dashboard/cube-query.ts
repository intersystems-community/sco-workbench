// backend/src/dashboard/cube-query.ts
import type { ChartData, ChartDataSource, CubeQuerySpec, CubeShapeLevel, CubeShapeReader, CubeMemberReader, DimensionKind } from './chart-data.js';
import type { RawMdxResult, DeepSeeClient } from '../iris/deepsee-client.js';
import { QueryError, NotFoundError, ValidationError } from '../iris/iris-error.js';
import { humanizeLabel } from './humanize-label.js';
import { memberRef } from './member-ref.js';

export const DEFAULT_TOP_N = 50;
export const MAX_TOP_N = 500;

/** Series-axis ceiling for a second-dimension split. The Okabe-Ito palette holds 8
 *  colour-vision-safe hues and a stacked chart past ~8 segments is illegible. */
export const MAX_SERIES = 8;

/**
 * A synthetic measure emitted ON 0 alongside the real measures so a single
 * mdxExecute call carries BOTH the (bounded) rows and the true member count.
 * `%DISTINCT([dim].MEMBERS)` returns the same count on every row (it is a
 * dimension-wide aggregate); the normalizer reads it once as `meta.total` and
 * drops the column from the series. This is how a top-N cap becomes a visible,
 * never-silent truncation without a second round trip. Shape confirmed by the
 * live Task-4 capture (backend/test/unit/fixtures/mdx-result.sample.json).
 */
const TOTAL_MEMBER = '%chartTotal';
const SERIES_TOTAL_MEMBER = '%chartSeriesTotal';

/** Nearest-name suggestions for a rejected identifier (as D1's count route does). */
function candidates(name: string, pool: string[]): string[] {
  const lc = name.toLowerCase();
  return pool.filter((p) => p.toLowerCase().includes(lc) || lc.includes(p.toLowerCase())).slice(0, 5);
}

// (1) Structural collapse — pure. Carries the dim NAME + the assignment's raw `level?` per slot;
//     no shape lookups (unknown names/levels are validated in query()).
interface RoleCollapse {
  cube: string; measures: string[];
  rowDimension?: { name: string; level?: string };
  seriesDimension?: { name: string; level?: string };
  filters: { name: string; level?: string; member: string }[];
  topN?: number;
}
// (2) Shape-resolved shape composeMdx/extractCells/normalize consume — each channel carries the
//     RESOLVED level spec (for the MDX), the dim NAME (crossjoin dimName attribution), and the
//     level LABEL (titling). `levelSpec` is undefined only for a degraded dim with no levels.
interface ResolvedLevel { dim: string; levelSpec?: string; label: string }
interface CollapsedQuery {
  cube: string; measures: string[];
  rowLevel?: ResolvedLevel;
  seriesLevel?: ResolvedLevel;
  filters: { dim: string; levelSpec?: string; member: string }[];
  topN?: number;
}

/**
 * Collapse the general role list to the role slots, rejecting role conflicts the collapse
 * would otherwise mask (B-CUBE-14): >1 category, >1 series, a dimension in two roles / filtered
 * twice, a filter missing its member. Pure — validates structure only; unknown NAMES/LEVELS are
 * validated against the shape in query(), members via the member reader. The raw `level?` rides
 * through per slot to be resolved once names are known.
 */
function collapse(spec: CubeQuerySpec): RoleCollapse {
  const seen = new Set<string>();
  let rowDimension: { name: string; level?: string } | undefined;
  let seriesDimension: { name: string; level?: string } | undefined;
  const filters: { name: string; level?: string; member: string }[] = [];
  for (const d of spec.dimensions ?? []) {
    if (seen.has(d.name)) throw new ValidationError(`Dimension '${d.name}' is assigned more than one role.`);
    seen.add(d.name);
    if (d.role === 'category') {
      if (rowDimension) throw new ValidationError('A chart can have at most one category dimension.');
      rowDimension = { name: d.name, level: d.level };
    } else if (d.role === 'series') {
      if (seriesDimension) throw new ValidationError('A chart can have at most one series dimension.');
      seriesDimension = { name: d.name, level: d.level };
    } else {
      if (!d.member) throw new ValidationError(`Filter on '${d.name}' requires a member.`);
      filters.push({ name: d.name, level: d.level, member: d.member });
    }
  }
  return { cube: spec.cube, measures: spec.measures, rowDimension, seriesDimension, filters, topN: spec.topN };
}

export class CubeQueryRunner implements ChartDataSource {
  constructor(
    private readonly shapeReader: CubeShapeReader,
    private readonly deepsee: Pick<DeepSeeClient, 'mdxExecute'>,
    private readonly memberReader?: CubeMemberReader,
    private readonly opts: { defaultTopN?: number; maxTopN?: number } = {},
  ) {}

  async query(spec: CubeQuerySpec): Promise<ChartData> {
    const shape = await this.shapeReader.shape(spec.cube);
    const r = collapse(spec);

    // Deferred combo (#4): the crossjoin path is single-measure by construction, so 2+ measures
    // WITH a series split would silently drop measures. Reject loudly (mirrors the builder block).
    if (r.measures.length > 1 && r.seriesDimension) {
      throw new ValidationError('Multiple measures with a series split is not supported yet. Remove the split or use a single measure.');
    }

    // ── Injection closed by construction: validate every name against the shape ──
    const measureNames = new Set(shape.measures.map((m) => m.name));
    for (const m of r.measures) {
      if (m === '%COUNT') continue; // cube-implicit row count — resolved in MDX as [Measures].[%COUNT]
      if (!measureNames.has(m)) {
        throw new NotFoundError(`Measure '${m}' is not in cube '${spec.cube}'.`, {
          details: { candidates: candidates(m, [...measureNames]) },
        });
      }
    }
    const dimNames = shape.dimensions.map((d) => d.name);
    const requireDim = (name: string) => {
      const dim = shape.dimensions.find((d) => d.name === name);
      if (!dim) throw new NotFoundError(`Dimension '${name}' is not in cube '${spec.cube}'.`, {
        details: { candidates: candidates(name, dimNames) },
      });
      return dim;
    };
    // Resolve a channel's chosen LEVEL against the dimension (B-CUBE-15): explicit `level` must be
    // one of the dimension's levels[].spec (unknown → NotFoundError, candidates = its level specs);
    // absent → the first level; `[]` levels → undefined spec ([dim].MEMBERS fallback downstream).
    // Returns { dim, levelSpec?, label } — label = the chosen level's caption || humanized name.
    const resolveLevel = (name: string): ResolvedLevel => {
      const dim = requireDim(name);
      const chosen = spec.dimensions?.find((d) => d.name === name)?.level;
      let level: CubeShapeLevel | undefined;
      if (chosen) {
        level = dim.levels.find((l) => l.spec === chosen);
        if (!level) throw new NotFoundError(`Level '${chosen}' is not in dimension '${name}' of cube '${spec.cube}'.`, {
          details: { candidates: candidates(chosen, dim.levels.map((l) => l.spec)) },
        });
      } else {
        level = dim.levels[0];
      }
      return { dim: name, levelSpec: level?.spec, label: level ? (level.caption || humanizeLabel(level.name)) : humanizeLabel(name) };
    };

    let dimKind: DimensionKind = 'scalar';
    const rowLevel = r.rowDimension ? resolveLevel(r.rowDimension.name) : undefined;
    if (r.rowDimension) dimKind = requireDim(r.rowDimension.name).kind;
    const seriesLevel = r.seriesDimension ? resolveLevel(r.seriesDimension.name) : undefined;
    const filters = r.filters.map((f) => {
      const rl = resolveLevel(f.name);      // validates the filter DIMENSION + its level
      return { dim: f.name, levelSpec: rl.levelSpec, member: f.member };
    });

    // Filter MEMBER validation (B-CUBE-09): each filter member must be a real member of its chosen
    // LEVEL — an unknown one is a NotFoundError with candidates, never reaching MDX. The member
    // reader enumerates the SAME level the WHERE tuple will use (its `level` arg = the resolved spec).
    for (const f of filters) {
      if (!this.memberReader) throw new ValidationError('Filters are not supported by this runner (no member reader configured).');
      const members = await this.memberReader.members(spec.cube, f.dim, f.levelSpec);
      if (!members.some((m) => m.name === f.member)) {
        throw new NotFoundError(`Member '${f.member}' is not in dimension '${f.dim}' of cube '${spec.cube}'.`, {
          details: { candidates: candidates(f.member, members.map((m) => m.name)) },
        });
      }
    }

    // Human titling labels. valueLabel is measures[0] as before; the axis labels now follow the
    // chosen LEVEL (B-CUBE-15): "…by Customer Name", not "…by Customer". §4.1 handles per-series names.
    const firstMeasure = shape.measures.find((m) => m.name === r.measures[0]);
    const labels = {
      valueLabel: firstMeasure?.caption || humanizeLabel(firstMeasure?.name || r.measures[0] || ''),
      categoryLabel: rowLevel?.label,
      seriesDimensionName: seriesLevel?.label,
    };
    // Per-series measure labels (§4.1 / B-CUBE-04a): aligned to r.measures, an authored caption or
    // the humanized name — the same rule valueLabel uses, applied to every measure series.
    const measureLabels = r.measures.map((name) => {
      // §192: the cube-implicit %COUNT size source is named "Count" (not the humanized
      // "%COUNT") so a bubble's sizeLabel reads cleanly. %COUNT is not in shape.measures.
      if (name === '%COUNT') return 'Count';
      const m = shape.measures.find((x) => x.name === name);
      return m?.caption || humanizeLabel(m?.name || name);
    });

    const q: CollapsedQuery = { cube: r.cube, measures: r.measures, rowLevel, seriesLevel, filters, topN: r.topN };
    const topN = Math.min(q.topN ?? this.opts.defaultTopN ?? DEFAULT_TOP_N, this.opts.maxTopN ?? MAX_TOP_N);

    // ── Compose MDX from validated identifiers ONLY (never interpolate raw input) ──
    const mdx = composeMdx(q, topN);

    const raw = await this.deepsee.mdxExecute(mdx);
    if (raw.Info?.Error) {
      throw new QueryError(`The cube query was rejected: ${String(raw.Info.Error)}`, {
        details: { mdx, upstream: raw.Info.Error },
      });
    }
    return normalize(raw, q, dimKind, topN, labels, measureLabels);
  }
}

/**
 * The member set enumerated ON 1 for a resolved channel. Prefers the CHOSEN level's
 * `${levelSpec}.MEMBERS` (single level: no [All], no mixed hierarchy levels — the D2
 * additivity fix) and falls back to `[dim].MEMBERS` for a degraded channel with no level.
 */
function memberSet(level: ResolvedLevel): string {
  return level.levelSpec ? `${level.levelSpec}.MEMBERS` : `[${level.dim}].MEMBERS`;
}

/**
 * Build the MDX from shape-confirmed, level-resolved identifiers. Every interpolated token is a
 * bracketed identifier the shape validated — the raw spec strings never reach the query text.
 * Shape (measures ON 0, TOPCOUNT dimension members ON 1, synthetic total member) fixed by the
 * Task-4 capture. Dimension members are enumerated at the CHOSEN LEVEL (see memberSet) so a SUM
 * measure stays additive.
 */
function composeMdx(spec: CollapsedQuery, topN: number): string {
  // A validated WHERE slicer, orthogonal to the axes and appended to FROM on EVERY branch
  // (B-CUBE-06). Empty when no filters — keeping the no-filter MDX byte-identical. Each ref
  // is a shape/level-resolved, bracket-escaped identifier (see memberRef): the raw
  // spec strings never reach the query text.
  const where = spec.filters.length
    ? ` WHERE (${spec.filters.map((f) => memberRef(f, 'name')).join(',')})`
    : '';
  const from = `FROM [${spec.cube}]${where}`;
  const measures = spec.measures.map((m) => `[Measures].[${m}]`);
  if (!spec.rowLevel) {
    // Scalar: measures only, no rows, no total column.
    return `SELECT {${measures.join(',')}} ON 0 ${from}`;
  }
  const rowSet = memberSet(spec.rowLevel);
  const orderBy = `[Measures].[${spec.measures[0]}]`;
  if (spec.seriesLevel) {
    // Homogeneous series: ONE measure, split by a second dimension via CROSSJOIN. Both
    // synthetic totals ride ON 0 so a single call carries the bounded rows + both true
    // member counts. Every interpolated token is a shape-validated bracketed identifier.
    const seriesSet = memberSet(spec.seriesLevel);
    const one = `[Measures].[${spec.measures[0]}]`;
    const cols = [one, `[Measures].[${TOTAL_MEMBER}]`, `[Measures].[${SERIES_TOTAL_MEMBER}]`].join(',');
    return (
      `WITH MEMBER [Measures].[${TOTAL_MEMBER}] AS '%DISTINCT(${rowSet})' ` +
      `MEMBER [Measures].[${SERIES_TOTAL_MEMBER}] AS '%DISTINCT(${seriesSet})' ` +
      `SELECT {${cols}} ON 0,` +
      `NON EMPTY CROSSJOIN(TOPCOUNT(${rowSet},${topN},${orderBy}),` +
      `TOPCOUNT(${seriesSet},${MAX_SERIES},${orderBy})) ON 1 ` +
      from
    );
  }
  const cols = [...measures, `[Measures].[${TOTAL_MEMBER}]`].join(',');
  return (
    `WITH MEMBER [Measures].[${TOTAL_MEMBER}] AS '%DISTINCT(${rowSet})' ` +
    `SELECT {${cols}} ON 0,` +
    `TOPCOUNT(${rowSet},${topN},${orderBy}) ON 1 ` +
    from
  );
}

/** Normalize the recorded MDX envelope into ChartData. Walk fixed by the capture. */
function normalize(
  raw: RawMdxResult,
  spec: CollapsedQuery,
  dimKind: DimensionKind,
  _topN: number,
  labels: { valueLabel?: string; categoryLabel?: string; seriesDimensionName?: string },
  measureLabels: string[],
): ChartData {
  const { categories, series, total, seriesTotal, points } = extractCells(raw, spec, measureLabels);
  const shown = categories.length;
  const seriesShown = series.length;
  return {
    categories,
    series,
    meta: {
      truncated: typeof total === 'number' ? total > shown : false,
      shown,
      total,
      dimensionKind: spec.rowLevel ? dimKind : 'scalar',
      ...(labels.valueLabel ? { valueLabel: labels.valueLabel } : {}),
      ...(labels.categoryLabel ? { categoryLabel: labels.categoryLabel } : {}),
      ...(spec.seriesLevel ? {
        seriesDimensionName: labels.seriesDimensionName,
        seriesShown,
        seriesTotal: typeof seriesTotal === 'number' ? seriesTotal : seriesShown,
        seriesTruncated: typeof seriesTotal === 'number' ? seriesTotal > seriesShown : false,
      } : {}),
    },
    ...(points ? { points } : {}),
  };
}

/**
 * Walk the recorded envelope: Axis_1 (Result.Axes[0]) carries the measure/column
 * members, Axis_2 (Result.Axes[1]) the row-dimension members, and CellData is a
 * flat ROW-MAJOR list (cell index = row * colCount + col). The synthetic total
 * column is read once and excluded from the series. A missing/NULL/empty cell
 * becomes `null`, never `0`. Returns categories + series + the true member total.
 * When ≥2 measures over categories (no series split), also returns points for bubble.
 */
function extractCells(
  raw: RawMdxResult,
  spec: CollapsedQuery,
  measureLabels: string[],
): { categories: string[]; series: { name: string; data: (number | null)[] }[]; total?: number; seriesTotal?: number; points?: { x: number; y: number; size: number | null; label: string }[] } {
  const axes = raw.Result?.Axes ?? [];
  const colAxis = axes[0];
  const rowAxis = axes[1];
  const cells = raw.Result?.CellData ?? [];

  const colMembers = (colAxis?.Tuples ?? []).map((t) => t.Members?.[0]?.Name ?? '');
  const colCount = colMembers.length || 1;
  const totalColIdx = colMembers.findIndex((n) => n === TOTAL_MEMBER);
  const seriesTotalColIdx = colMembers.findIndex((n) => n === SERIES_TOTAL_MEMBER);
  const dataColIdxs = colMembers.map((_, i) => i).filter((i) => i !== totalColIdx && i !== seriesTotalColIdx);

  const cellValue = (i: number): number | null => {
    const c = cells[i];
    if (!c) return null;
    const v = c.ValueLogical;
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };

  const rowTuples = rowAxis?.Tuples ?? [];
  const isCrossjoin = !!spec.seriesLevel && rowTuples.some((t) => (t.Members?.length ?? 0) >= 2);
  if (isCrossjoin) {
    // A CROSSJOIN row tuple carries two members: one for the row (category) dimension
    // and one for the series dimension. IRIS returns them in the REVERSE of the
    // CROSSJOIN() argument order, so their POSITION is not a reliable row-vs-series
    // signal (composeMdx emits CROSSJOIN(rowSet,seriesSet) → Members come back
    // [seriesMember, rowMember]). Attribute each member by its self-describing
    // MemberInfo.dimName instead: dimName === the row dimension → the category axis,
    // === the series dimension → the series axis. Fall back to the legacy positional
    // read ([0]=row, [1]=series) only when MemberInfo is absent (older/degraded
    // envelopes) so nothing regresses for a source that does not supply it.
    // The dimension NAME is unchanged by the level choice (a level lives under its
    // dimension), so MemberInfo.dimName still matches spec.rowLevel/seriesLevel.dim.
    // There is ONE data column (the single measure).
    const measureCol = dataColIdxs[0] ?? 0;
    const rowDim = spec.rowLevel?.dim;
    const seriesDim = spec.seriesLevel?.dim;
    /** [rowMemberName, seriesMemberName] for a tuple, resolved by dimName when present. */
    const split = (t: { Members?: Array<{ Name?: string }>; MemberInfo?: Array<{ dimName?: string }> }): [string, string] => {
      const info = t.MemberInfo;
      if (info && info.length === (t.Members?.length ?? 0)) {
        const rowIdx = info.findIndex((mi) => mi.dimName === rowDim);
        const serIdx = info.findIndex((mi) => mi.dimName === seriesDim);
        if (rowIdx >= 0 && serIdx >= 0) {
          return [t.Members?.[rowIdx]?.Name ?? '', t.Members?.[serIdx]?.Name ?? ''];
        }
      }
      // Positional fallback: legacy assumption [row, series].
      return [t.Members?.[0]?.Name ?? '', t.Members?.[1]?.Name ?? ''];
    };
    const categories: string[] = [];
    const seriesNames: string[] = [];
    for (const t of rowTuples) {
      const [row, ser] = split(t);
      if (!categories.includes(row)) categories.push(row);
      if (!seriesNames.includes(ser)) seriesNames.push(ser);
    }
    const cellAt = (rowIdx: number) => cellValue(rowIdx * colCount + measureCol);
    const byKey = new Map<string, number | null>();
    rowTuples.forEach((t, i) => {
      const [row, ser] = split(t);
      byKey.set(`${row}\u0000${ser}`, cellAt(i));
    });
    const series = seriesNames.map((s) => ({
      name: s,
      data: categories.map((c) => byKey.get(`${c}\u0000${s}`) ?? null),
    }));
    const rowTotal = totalColIdx >= 0 ? cellValue(totalColIdx) : null;
    const seriesTotal = seriesTotalColIdx >= 0 ? cellValue(seriesTotalColIdx) : null;
    return { categories, series, total: rowTotal ?? undefined, seriesTotal: seriesTotal ?? undefined };
  }
  if (rowTuples.length > 0) {
    const categories = rowTuples.map((t) => t.Members?.[0]?.Name ?? '');
    const series = dataColIdxs.map((colIdx, seriesIdx) => ({
      name: measureLabels[seriesIdx] ?? colMembers[colIdx] ?? '',
      data: rowTuples.map((_, rowIdx) => cellValue(rowIdx * colCount + colIdx)),
    }));
    // The synthetic total repeats on every row; read row 0's cell (index = totalColIdx).
    let total: number | undefined;
    if (totalColIdx >= 0) {
      const t = cellValue(totalColIdx);
      if (t !== null) total = t;
    }
    // Bubble projection: when ≥2 measures over categories (no series split), populate points
    // where x=measure0, y=measure1, size=measure2-or-null, label=category. Drop any point whose
    // x OR y is null (a gap is no point).
    const points = series.length >= 2
      ? categories
          .map((c, rowIdx) => ({
            x: series[0]!.data[rowIdx] ?? null,
            y: series[1]!.data[rowIdx] ?? null,
            size: series.length >= 3 ? (series[2]!.data[rowIdx] ?? null) : null,
            label: c,
          }))
          .filter((pt): pt is { x: number; y: number; size: number | null; label: string } => pt.x != null && pt.y != null)
      : undefined;
    return points && points.length > 0
      ? { categories, series, total, points }
      : { categories, series, total };
  }

  // Scalar (no row axis): one cell per measure column, single implicit row.
  const categories = dataColIdxs.map((i) => colMembers[i] ?? '');
  const series = [
    {
      name: spec.measures[0] ?? colMembers[0] ?? 'value',
      data: dataColIdxs.map((colIdx) => cellValue(colIdx)),
    },
  ];
  return { categories, series };
}
