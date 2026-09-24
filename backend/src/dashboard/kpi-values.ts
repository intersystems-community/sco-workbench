// backend/src/dashboard/kpi-values.ts
import type { ChartData, CubeShapeReader, DimensionKind, KpiQuerySpec } from './chart-data.js';
import type { KpiValueClient, RawKpiValuesBody } from '../iris/kpi-value-client.js';
import { classifyKpiValue } from '../iris/kpi-value-client.js';
import type { KpiRestClient } from '../iris/kpi-rest-client.js';
import type { KpiDefinition, KpiDimension } from '../kpi/kpi-definition.model.js';
import { QueryError, NotFoundError, IrisHttpError } from '../iris/iris-error.js';
import { humanizeLabel } from './humanize-label.js';

/** Nearest-name suggestions for a rejected identifier (as cube-query does). */
function candidates(name: string, pool: string[]): string[] {
  const lc = name.toLowerCase();
  return pool.filter((p) => p.toLowerCase().includes(lc) || lc.includes(p.toLowerCase())).slice(0, 5);
}

/** The first MDX segment of a `cubeDimension` (`[carrier].[H1].[name]` → `carrier`),
 *  which is what `CubeShape.dimensions[].name` carries. Null when not bracketed. */
function mdxDim(cubeDimension: string | undefined): string | null {
  if (!cubeDimension) return null;
  const m = cubeDimension.match(/\[([^\]]*)\]/);
  return m ? m[1]! : null;
}

/**
 * Derive a bullet's reference marker + quality bands from a KPI's two thresholds.
 * The KPI model has NO polarity field, so polarity is DERIVED from the thresholds:
 *   - warning > watching ⇒ lower-is-better (late orders): danger is the HIGH end,
 *     bands ascend ok → watching → warning.
 *   - warning < watching ⇒ higher-is-better (fill rate): danger is the LOW end,
 *     the kind order FLIPS (warning → watching → ok) while `to` STAYS ascending.
 * Both thresholds are required and must be unequal; otherwise polarity is
 * indeterminate and we draw NO bullet (return null). `target` is the watching
 * threshold — the nearer, more informative reference line (plan decision).
 */
export function deriveBands(
  watching: number | undefined,
  warning: number | undefined,
): { target: number; bands: NonNullable<ChartData['meta']['bands']> } | null {
  if (watching == null || warning == null || watching === warning) return null;
  const target = watching;
  if (warning > watching) {
    // lower-is-better
    return { target, bands: [
      { to: watching, kind: 'ok' },
      { to: warning, kind: 'watching' },
      { to: Infinity, kind: 'warning' },
    ] };
  }
  // higher-is-better: flip the kinds, keep `to` ascending
  return { target, bands: [
    { to: warning, kind: 'warning' },
    { to: watching, kind: 'watching' },
    { to: Infinity, kind: 'ok' },
  ] };
}

/**
 * Which quality band a scalar value falls in, given the bands `deriveBands` produced.
 * `deriveBands` already encodes polarity into the band ORDER (ascending `to`, correct
 * `kind` per band), so this is a polarity-agnostic "first band whose `to` the value does
 * not exceed" walk. A `to` of `null` (the wire form of the terminal band) or `Infinity`
 * (server-side) is unbounded. Returns null for a null value or absent bands.
 */
export function statusOf(
  value: number | null | undefined,
  bands: { to: number | null; kind: 'ok' | 'watching' | 'warning' }[] | undefined,
): 'ok' | 'watching' | 'warning' | null {
  if (value == null || !bands?.length) return null;
  for (const b of bands) if (b.to == null || value <= b.to) return b.kind;
  return bands[bands.length - 1]!.kind; // defensive: above all finite bounds → terminal band
}

/**
 * Reads a KPI's value(s) and normalizes them into the SAME `ChartData` a cube query
 * produces, so Layers 1/2 and the renderer serve KPI charts with zero source-specific
 * code. Sibling of `CubeQueryRunner`. The value client returns `{ status, body }`
 * verbatim (a 500/404 is a domain signal, not an exception), and THIS core decides the
 * typed error — the same split `DeepSeeClient.mdxExecute` + `CubeQueryRunner` use.
 */
export class KpiValueReader {
  constructor(
    private readonly client: KpiValueClient,
    private readonly defs: Pick<KpiRestClient, 'get'>,
    private readonly shapeReader: CubeShapeReader,
  ) {}

  async values(spec: KpiQuerySpec): Promise<ChartData> {
    // Read the definition on BOTH paths so a KPI is titled consistently across its
    // gauge (scalar) and breakdown (expanded) views (D3-PLAN-03). The def is titling
    // metadata: a failed read degrades to the humanized name, it never fails the chart.
    const def = await this.defs.get(spec.kpi).catch(() => null);
    // The value-axis / series label: def.label when present, else the humanized KPI name —
    // the SAME resolution on both paths, so 'On-Hand' titles the gauge AND the breakdown.
    const seriesLabel = def?.label || humanizeLabel(spec.kpi);
    let dimKind: DimensionKind = 'scalar';
    let categoryLabel: string | undefined;

    // ── Bad expandDimension is silently swallowed by IRIS (HTTP 200 → scalar), so
    //    validate it against the KPI's own kpiDimensions BEFORE the call. ──
    if (spec.expandDimension) {
      if (!def) throw new NotFoundError(`KPI '${spec.kpi}' was not found.`);
      const dims = def.deepseeKpiSpec?.kpiDimensions ?? [];
      const match = dims.find((d) => d.name === spec.expandDimension);
      if (!match) {
        throw new NotFoundError(`Dimension '${spec.expandDimension}' is not a breakdown of KPI '${spec.kpi}'.`, {
          details: { candidates: candidates(spec.expandDimension, dims.map((d) => d.name)) },
        });
      }
      categoryLabel = match.label || humanizeLabel(match.name);
      dimKind = await this.backingDimensionKind(def, match);
    }

    const { status, body } = await this.client.values(spec.kpi, spec.expandDimension);

    // Route the completed exchange through the SHARED classifier (B-11) so this reader and
    // KpiHealthReader cannot fork on "what is a value error". Each non-ok kind maps to the SAME
    // typed throw as before — behavior-preserving:
    //   query    → SC-2643 un-evaluatable KPI: HTTP 500 carrying an IRIS error in EITHER envelope —
    //              `{ Status:"Error", Message:"ERROR #NNNN…" }` or the %Status-style
    //              `{ errors:[{ code, error }], summary }`. Detected on the (status, error-present)
    //              PAIR, never on an <INVALID OREF> substring: the live instance emitted only the
    //              first envelope on 2026-08-23 and only the second on 2026-09-10, so keying on one
    //              shape silently reclassified every bad-MDX KPI as a 502 gateway fault (see
    //              `irisErrorText` in iris/kpi-value-client.ts). Message stays cause-agnostic.
    //   notfound → values/{missing} → 404 with body.Status==="Error"; the sibling listings endpoint
    //              returns 200 with the SAME body, so it keys on body.Status, not the HTTP code alone.
    //   http     → any other non-200 / non-array values (protocol/HTTP fault).
    const cls = classifyKpiValue(status, body);
    switch (cls.kind) {
      case 'query':
        throw new QueryError(
          `KPI '${spec.kpi}' could not be evaluated (its query may be invalid, or its measure/cube may not be queryable).`,
          { details: { upstream: cls.message } },
        );
      case 'notfound':
        throw new NotFoundError(`KPI '${spec.kpi}' was not found.`, { details: { upstream: cls.message } });
      case 'http':
        throw new IrisHttpError(cls.status, `Unexpected KPI values response (HTTP ${cls.status}).`, { details: { body } });
    }

    const chart = normalize(body, { seriesLabel, categoryLabel, dimKind });
    // Bullet side-channel: scalar path only, and only when the definition read succeeded
    // and yields a determinate polarity. Purely additive metadata; never fails the read.
    if (!spec.expandDimension && def) {
      const bullet = deriveBands(def.watchingThreshold, def.warningThreshold);
      if (bullet) {
        chart.meta.target = bullet.target;
        chart.meta.bands = bullet.bands;
      }
    }
    // A percentage KPI's values are percentages regardless of expand — a truthful statement about the
    // value axis. The ring GEOMETRY is gated by the gauge type (single value only), but the unit is
    // carried on both paths so a breakdown chart also knows its axis is a percentage. Additive-optional.
    if (def?.deepseeKpiSpec?.valueType === 'percentage') chart.meta.unit = 'percent';
    return chart;
  }

  /** The backing cube dimension's kind for an expanded KPI; degrades to categorical
   *  (never guesses temporal) when the cube shape or the match is unavailable. Matches
   *  by the KPI dim's `cubeDimension` first MDX SEGMENT — the id `CubeShape.dimensions[].name`
   *  carries — NOT by the short REST `name` (D3-PLAN-01); falls back to `name` only when
   *  `cubeDimension` is absent. */
  private async backingDimensionKind(def: KpiDefinition, kpiDim: KpiDimension): Promise<DimensionKind> {
    const cube = def.deepseeKpiSpec?.cube;
    if (!cube) return 'categorical';
    const shape = await this.shapeReader.shape(cube).catch(() => null);
    if (!shape) return 'categorical';
    const key = (mdxDim(kpiDim.cubeDimension) ?? kpiDim.name).toLowerCase();
    const match = shape.dimensions.find((d) => d.name.toLowerCase() === key);
    return match?.kind ?? 'categorical';
  }
}

/** Flatten the values envelope to ChartData: categories = labels, one numeric series.
 *  A NULL value stays null, never 0. No topN bound — a KPI's members are author-bounded. */
function normalize(
  body: RawKpiValuesBody,
  labels: { seriesLabel: string; categoryLabel?: string; dimKind: DimensionKind },
): ChartData {
  const values = body.values ?? [];
  const categories = values.map((v) => v.label);
  const data = values.map((v) => (v.value === null || v.value === undefined ? null : Number(v.value)));
  const shown = categories.length;
  return {
    categories,
    series: [{ name: labels.seriesLabel, data }],
    meta: {
      truncated: false,
      shown,
      total: shown,
      dimensionKind: labels.dimKind,
      valueLabel: labels.seriesLabel,
      ...(labels.categoryLabel ? { categoryLabel: labels.categoryLabel } : {}),
    },
  };
}
