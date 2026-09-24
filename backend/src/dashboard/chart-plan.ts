// backend/src/dashboard/chart-plan.ts
// The renderer-INDEPENDENT charting core: the guards that reject an untruthful
// (ChartData, type) pairing, the semantic colour/gauge values, and a neutral
// ChartPlan IR (the chart AS DRAWN) for all 11 families — round 2 promoted the last
// direct-emission families to neutral nodes, so every type now has one. Both the
// Highcharts and ECharts adapters build from this — so the rejection logic and the
// semantic decisions live ONCE, not duplicated per library.
import type { ChartData, ChartType } from './chart-data.js';

/** A builder rejection — the (ChartData, type) pairing cannot draw a truthful chart. */
export class BuilderRejection extends Error {}

/**
 * Okabe-Ito qualitative palette — the colour-vision-safe analogue of a ColorBrewer
 * qualitative scheme, for UNORDERED categorical series/points (the cognitive-audit
 * skill names ColorBrewer/viridis/cividis; Okabe-Ito is the qualitative counterpart).
 * Ordered strongest-contrast-first; yellow/black kept last (low contrast on white).
 * Used for `colors` (per-series) and, on single-series bar/column + treemap, per point
 * via `colorByPoint` — so a one-measure chart is not a wall of the Highcharts default
 * blue (#2caffe), the "everything is blue" the user reported.
 */
export const PALETTE = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#56B4E9', '#CC79A7', '#F0E442', '#000000'];

/** The colorAxis endpoints for a sequential (single-hue) heatmap ramp. */
export const HEAT_MIN_COLOR = '#eef6fb';
export const HEAT_MAX_COLOR = PALETTE[0]!;
/**
 * The fill for an EMPTY heatmap cell. A `null` cell is a gap ("no data here"), not a
 * low value — but with no nullColor Highcharts paints it the colorAxis minimum, so an
 * empty cell reads as a real small value. A neutral grey (the choropleth "no data"
 * convention) keeps the gap visually distinct from the sequential ramp.
 */
export const HEAT_NULL_COLOR = '#cccccc';

/**
 * The brightness spread applied to a sunburst/nested-treemap LEAF level so the children
 * within a branch are distinguishable shades of the branch hue (level-1 colorByPoint sets
 * the hue; this varies brightness across the leaves). Highcharts' default is 0.5; a slightly
 * wider 0.6 keeps adjacent leaves separable even in a branch with many members (e.g. eight
 * customers under one ship-status) while staying clearly within the parent's colour family.
 */
export const LEAF_BRIGHTNESS_RANGE = 0.6;

/** The unfilled remainder of a gauge arc — the neutral track the value fills against. A
 *  structural (theme-independent) colour like the heat/band ramps: the value arc uses the
 *  primary palette hue, and everything above the value shows this light grey. */
export const GAUGE_TRACK = '#e6e6e6';

/** Divergence colours for signed bars (positive, negative) — colour-vision-safe pair. */
export const DIVERGE_POS = '#0072B2';
export const DIVERGE_NEG = '#D55E00';
/** Bullet band ramp, ok → watching → warning (colour-vision-safe). */
export const BAND_COLORS: Record<'ok' | 'watching' | 'warning', string> = { ok: '#009E73', watching: '#E69F00', warning: '#D55E00' };

/** Any cell present at all? An all-empty query is not chartable. */
export function hasCells(data: ChartData): boolean {
  return data.series.some((s) => s.data.length > 0);
}

/** Any real negative value? (null is a gap, not a negative.) */
export function hasNegative(data: ChartData): boolean {
  return data.series.some((s) => s.data.some((v) => v !== null && v < 0));
}

/** Exactly one datum in one series — a scalar/gauge shape. */
export function isSingleValue(data: ChartData): boolean {
  return data.series.length === 1 && data.series[0]!.data.length === 1;
}

/** True when the series are homogeneous members of one dimension (stacking/nesting honest). */
export function hasSeriesDimension(data: ChartData): boolean {
  return !!data.meta.seriesDimensionName && data.series.length >= 2;
}

/**
 * Which of the capability types can draw a TRUTHFUL chart from this shape. The
 * single source of truth for both the FE dropdown filter (so an inapplicable type
 * is never offered) and `build`'s loud rejection (defense in depth — an
 * out-of-band request still fails cleanly rather than drawing garbage). The
 * invariant test ties the two: every type here builds; every excluded shape-gated
 * type throws. Cartesian types always read truthfully; the shape-gated ones
 * (pie/treemap/solidgauge/dumbbell/heatmap) each require a specific shape.
 */
export function capabilityFor(data: ChartData): ChartType[] {
  if (!hasCells(data)) return [];
  const caps: ChartType[] = ['bar', 'column', 'line', 'area', 'scatter'];
  const neg = hasNegative(data);
  const n = data.series.length;
  // pie/treemap: one non-negative series sliced over named categories (parts of a whole).
  if (n === 1 && !neg && data.categories.length > 0) caps.push('pie', 'treemap', 'funnel');
  // solidgauge: a single, non-negative value.
  if (isSingleValue(data) && !neg) caps.push('solidgauge');
  // dumbbell: exactly two series over shared categories (a paired comparison).
  if (n === 2) caps.push('dumbbell');
  // heatmap: a matrix — two or more series over the categories.
  if (n >= 2) caps.push('heatmap');
  if (n >= 2 && !neg) caps.push('bubbleHeatmap');
  const homogeneous = hasSeriesDimension(data);
  if (homogeneous && !neg) {
    caps.push('stackedColumn', 'sunburst');
    if (data.meta.dimensionKind === 'temporal') caps.push('stackedArea');
    if (!data.meta.seriesTruncated) caps.push('stackedColumn100');
    // nested treemap: n≥2 with a series dimension (flat treemap's n===1 push is above).
    if (!caps.includes('treemap')) caps.push('treemap');
    // sankey: >=2 source categories flowing into >=2 homogeneous non-negative targets.
    if (data.categories.length >= 2) caps.push('sankey');
  }
  if (data.categories.length >= 3) caps.push('radar');
  if (neg && data.meta.dimensionKind === 'categorical') caps.push('divergingBar');
  if (data.categories.length === 2) caps.push('slope');
  if (isSingleValue(data) && data.meta.target != null && data.meta.bands?.length) caps.push('bullet');
  if (data.points && data.points.length > 0) caps.push('bubble');
  return caps;
}

/** The disclosure subtitle when a query was bounded. */
export function truncationSubtitle(data: ChartData): { text: string } | undefined {
  return data.meta.truncated
    ? { text: `Showing top ${data.meta.shown} of ${data.meta.total ?? '?'}` }
    : undefined;
}

/** A truthful title from the carried labels — "Count by Region", "Count", or empty. */
export function titleText(data: ChartData): string {
  const v = data.meta.valueLabel;
  const c = data.meta.categoryLabel;
  if (v && c) return `${v} by ${c}`;
  return v ?? c ?? '';
}

/** A "nice" upper bound at or above the value, for the gauge yAxis max. */
export function gaugeMax(value: number): number {
  if (value <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.ceil(value / mag) * mag;
}

/** A standard half-circle gauge pane. */
export function gaugePane(): Record<string, unknown> {
  return {
    center: ['50%', '85%'],
    size: '140%',
    startAngle: -90,
    endAngle: 90,
    background: [{ innerRadius: '60%', outerRadius: '100%', shape: 'arc', borderWidth: 0 }],
  };
}

export type PlanFamily = 'cartesian' | 'composition' | 'stacked' | 'gauge' | 'matrix' | 'radar' | 'hierarchy' | 'paired' | 'bulletValue' | 'bubble' | 'flow';

/**
 * Which neutral-IR family a type belongs to. Every one of the 22 types now maps to a family
 * (round 2 promoted the last direct-emission families), so the null branch is unreachable for a
 * known type — it survives only as the out-of-band guard for an unknown token (build() then
 * throws via buildDirect). The return type keeps `| null` for that defense-in-depth path.
 */
export function planFamilyOf(type: ChartType): PlanFamily | null {
  if (type === 'bar' || type === 'column' || type === 'line' || type === 'area' || type === 'scatter' || type === 'slope' || type === 'divergingBar') return 'cartesian';
  if (type === 'pie' || type === 'funnel') return 'composition';
  if (type === 'treemap' || type === 'sunburst') return 'hierarchy'; // flat + nested treemap AND sunburst share one node
  if (type === 'stackedColumn' || type === 'stackedColumn100' || type === 'stackedArea') return 'stacked';
  if (type === 'solidgauge') return 'gauge';
  if (type === 'heatmap' || type === 'bubbleHeatmap') return 'matrix';
  if (type === 'radar') return 'radar';
  if (type === 'dumbbell') return 'paired';
  if (type === 'bullet') return 'bulletValue';
  if (type === 'bubble') return 'bubble';
  if (type === 'sankey') return 'flow';
  return null;
}

/** The shared stacking precondition — one place, both adapters call it. */
export function assertStackable(data: ChartData): void {
  if (!hasSeriesDimension(data) || hasNegative(data)) {
    throw new BuilderRejection('Stacking needs a second dimension of non-negative, additive series; pick a grouped bar instead.');
  }
}

/** Renderer-neutral intermediate representation — the chart AS DRAWN, before either engine keys it. */
export type ChartPlan =
  | { kind: 'cartesian'; seriesType: 'bar' | 'column' | 'line' | 'area' | 'scatter';
      categories: string[]; series: { name: string; data: (number | null)[] }[];
      categoryLabel: string | null; valueLabel: string | null;
      legend: boolean; colorByPoint: boolean; endLabels?: boolean; signColor?: boolean; palette: string[];
      title: string; subtitle?: { text: string } }
  | { kind: 'composition'; source: 'pie' | 'funnel'; sort?: 'value' | 'source';
      points: { name: string; value: number | null }[]; palette: string[];
      title: string; subtitle?: { text: string } }
  | { kind: 'stacked'; areaNotColumn: boolean; stackingMode: 'normal' | 'percent';
      categories: string[]; series: { name: string; data: (number | null)[] }[];
      categoryLabel: string | null; valueLabel: string | null; palette: string[];
      title: string; subtitle?: { text: string } }
  | { kind: 'gauge'; value: number; max: number; seriesName: string; valueLabel: string | null;
      target?: number;                                    // present iff meta.target != null
      bands?: { from: number; to: number; color: string }[]; // present iff meta.bands?.length; `to` may be Infinity
      percent?: boolean;                                  // present iff meta.unit === 'percent'; caps max at 100, renders a full ring
      palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'matrix'; render: 'cells' | 'bubbles'; xCategories: string[]; yCategories: string[]; triples: (number | null)[][];
      categoryLabel: string | null; minColor: string; maxColor: string; nullColor: string;
      minValue: number; maxValue: number; palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'radar'; categories: string[]; indicatorMax: number;
      series: { name: string; data: (number | null)[] }[]; valueLabel: string | null;
      legend: boolean; palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'hierarchy'; source: 'treemap' | 'sunburst'; nested: boolean;
      flatPoints?: { name: string; value: number | null }[];
      rowNodes?: { id: string; name: string; parent: string }[];
      leaves?: { name: string; parent: string; value: number | null }[];
      leafBrightness: number; palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'paired'; categories: string[];
      points: { name: string; low: number | null; high: number | null }[];
      lowName: string; highName: string; categoryLabel: string | null; valueLabel: string | null;
      lowColor: string; highColor: string; palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'bulletValue'; value: number; target: number; seriesName: string;
      bands: { from: number; to: number; color: string }[]; valueLabel: string | null;
      palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'bubble'; points: { x: number; y: number; size: number | null; label?: string }[];
      xLabel: string | null; yLabel: string | null; sizeLabel: string | null;
      minSize: number; maxSize: number;
      palette: string[]; title: string; subtitle?: { text: string } }
  | { kind: 'flow'; nodes: { name: string }[];
      links: { source: string; target: string; value: number }[];
      valueLabel: string | null;
      palette: string[]; title: string; subtitle?: { text: string } };

export function plan(data: ChartData, type: ChartType, opts?: { funnelSort?: 'value' | 'source' }): ChartPlan {
  if (!hasCells(data)) throw new BuilderRejection('No data to chart.');
  const subtitle = truncationSubtitle(data);
  const base = { palette: PALETTE, title: titleText(data), ...(subtitle ? { subtitle } : {}) };
  const family = planFamilyOf(type);

  if (family === 'cartesian') {
    if (type === 'slope' && data.categories.length !== 2) {
      throw new BuilderRejection('A slope compares exactly two points; pick a line for a longer series.');
    }
    if (type === 'divergingBar' && (!hasNegative(data) || data.meta.dimensionKind !== 'categorical')) {
      throw new BuilderRejection('A diverging bar needs signed values on a categorical axis; pick a bar or line.');
    }
    const multi = data.series.length > 1;
    const colorByPoint = !multi && (type === 'bar' || type === 'column');
    const seriesType = (type === 'slope' ? 'line' : type === 'divergingBar' ? 'bar' : type) as 'bar' | 'column' | 'line' | 'area' | 'scatter';
    return {
      kind: 'cartesian', seriesType,
      categories: data.categories, series: data.series.map((s) => ({ name: s.name, data: s.data })),
      categoryLabel: data.meta.categoryLabel ?? null, valueLabel: data.meta.valueLabel ?? null,
      legend: type === 'slope' ? true : type === 'divergingBar' ? false : multi, colorByPoint,
      ...(type === 'slope' ? { endLabels: true } : {}), ...(type === 'divergingBar' ? { signColor: true } : {}), ...base,
    };
  }

  if (family === 'composition') {
    // Pie + funnel — treemap (flat + nested) is now the hierarchy node. Both need named
    // categories, a single non-negative series (parts of one whole).
    if (data.categories.length === 0) throw new BuilderRejection('A pie needs named categories to slice; pick a gauge for a single value.');
    if (hasNegative(data)) throw new BuilderRejection('This chart type cannot show negative values; pick a bar or line.');
    if (data.series.length !== 1) throw new BuilderRejection('A pie shows one series; pick a bar for multiple series.');
    const s0 = data.series[0]!;
    const points = data.categories.map((c, i) => ({ name: c, value: s0.data[i] ?? null }));
    const source = type === 'funnel' ? ('funnel' as const) : ('pie' as const);
    const sort = type === 'funnel' ? (opts?.funnelSort ?? 'value') : undefined;
    return { kind: 'composition', source, ...(sort ? { sort } : {}), points, ...base };
  }

  if (family === 'hierarchy') {
    // treemap (flat OR nested) + sunburst on ONE node. A series dimension with n>=2 (or any
    // sunburst) nests into rows × series; a single series is a flat treemap. The branch-hue /
    // leaf-brightness encoding is emitted per-renderer from leafBrightness.
    const nested = type === 'sunburst' || hasSeriesDimension(data);
    if (nested) {
      if (!hasSeriesDimension(data) || hasNegative(data)) {
        throw new BuilderRejection('A nested chart needs a second dimension of non-negative series; pick a bar.');
      }
      const rowNodes = data.categories.map((c) => ({ id: c, name: c, parent: '' }));
      const leaves: { name: string; parent: string; value: number | null }[] = [];
      data.categories.forEach((c, ci) => data.series.forEach((s) => leaves.push({ name: s.name, parent: c, value: s.data[ci] ?? null })));
      return { kind: 'hierarchy', source: type as 'treemap' | 'sunburst', nested: true, rowNodes, leaves, leafBrightness: LEAF_BRIGHTNESS_RANGE, ...base };
    }
    // flat treemap — the pie/treemap composition preconditions (named categories, non-negative,
    // single series). A single-series sunburst is not offered by capabilityFor; if plan() is
    // called out-of-band with one, `nested` is true (sunburst always nests) and rejects above.
    if (data.categories.length === 0) throw new BuilderRejection('A pie or treemap needs named categories to slice; pick a gauge for a single value.');
    if (hasNegative(data)) throw new BuilderRejection('This chart type cannot show negative values; pick a bar or line.');
    if (data.series.length !== 1) throw new BuilderRejection('A pie or treemap shows one series; pick a bar for multiple series.');
    const s0 = data.series[0]!;
    return { kind: 'hierarchy', source: 'treemap', nested: false, flatPoints: data.categories.map((c, i) => ({ name: c, value: s0.data[i] ?? null })), leafBrightness: LEAF_BRIGHTNESS_RANGE, ...base };
  }

  if (family === 'stacked') {
    assertStackable(data);
    if (type === 'stackedColumn100' && data.meta.seriesTruncated) {
      throw new BuilderRejection('A 100% stack over a truncated series would misrepresent the whole; pick a normal stack.');
    }
    return {
      kind: 'stacked', areaNotColumn: type === 'stackedArea',
      stackingMode: type === 'stackedColumn100' ? 'percent' : 'normal',
      categories: data.categories, series: data.series.map((s) => ({ name: s.name, data: s.data })),
      categoryLabel: data.meta.categoryLabel ?? null, valueLabel: data.meta.valueLabel ?? null, ...base,
    };
  }

  if (family === 'gauge') {
    if (!isSingleValue(data) || hasNegative(data)) {
      throw new BuilderRejection('A gauge needs a single, non-negative value; pick a bar for a series.');
    }
    // isSingleValue guarantees one datum exists; `== null` narrows out both null and the
    // indexed-access `undefined` (noUncheckedIndexedAccess). seriesName is the emitted HC
    // series name (data.series[0].name), carried so the HC output stays byte-for-byte.
    const value = data.series[0]!.data[0];
    if (value == null) throw new BuilderRejection('A gauge needs a value; this cell is empty.');
    // Threshold context (shared shape with the bullet). Bands accumulate a `from` and carry the
    // BAND_COLORS hue; the top band's `to` stays Infinity (the adapter clamps it). The zone ring
    // consumes only `to`+`color`; `from` is unused on the gauge — harmless over-carry, kept for parity.
    let from = 0;
    const bands = data.meta.bands?.length
      ? data.meta.bands.map((band) => { const out = { from, to: band.to, color: BAND_COLORS[band.kind] }; from = band.to; return out; })
      : undefined;
    // max must cover the value, the target, AND every finite zone edge, or the top zone collapses to
    // zero width. Mirror the bullet's axisMax inputs (ignoring an Infinity top band), then round for
    // clean scale labels. No thresholds → maxInput = value → gaugeMax(value), byte-identical to today.
    const lastFiniteBandTo = bands ? bands.reduce((m, b) => (Number.isFinite(b.to) ? Math.max(m, b.to) : m), 0) : 0;
    // A percentage ring is a fixed 0–100 dial: cap max at 100, never gaugeMax (which would round 85→90
    // and 120→200). The value may exceed 100 (numerator not a subset of its base); the renderer clamps
    // the ARC to a full circle while the centre readout shows the true value (C-SPEC-01).
    const percent = data.meta.unit === 'percent';
    const max = percent ? 100 : gaugeMax(Math.max(value, data.meta.target ?? 0, lastFiniteBandTo));
    return {
      kind: 'gauge', value, max, seriesName: data.series[0]!.name, valueLabel: data.meta.valueLabel ?? null,
      ...(data.meta.target != null ? { target: data.meta.target } : {}),
      ...(bands ? { bands } : {}),
      ...(percent ? { percent: true } : {}),
      ...base,
    };
  }

  if (family === 'matrix') {
    if (data.series.length < 2) throw new BuilderRejection('A heatmap needs a matrix — two or more series over the categories; pick a bar for one.');
    // Row-major [x, y, value|null] triples: each series is a y-row, each category an x-column.
    const triples: (number | null)[][] = [];
    const finite: number[] = [];
    data.series.forEach((s, y) => data.categories.forEach((_, x) => {
      const v = s.data[x] ?? null;
      triples.push([x, y, v]);
      if (v != null) finite.push(v);
    }));
    const render = type === 'bubbleHeatmap' ? ('bubbles' as const) : ('cells' as const);
    // bubbleHeatmap sizes area ∝ value, so it must anchor at 0 for area-honesty; heatmap keeps
    // its real-data-extent min because it must colour negatives truthfully.
    const minValue = render === 'bubbles' ? 0 : (finite.length ? Math.min(...finite) : 0);
    const maxValue = finite.length ? Math.max(...finite) : 0;
    return {
      kind: 'matrix', render, xCategories: data.categories, yCategories: data.series.map((s) => s.name),
      triples, minValue, maxValue, categoryLabel: data.meta.categoryLabel ?? null,
      minColor: HEAT_MIN_COLOR, maxColor: HEAT_MAX_COLOR, nullColor: HEAT_NULL_COLOR, ...base,
    };
  }

  if (family === 'radar') {
    if (data.categories.length < 3) throw new BuilderRejection('A radar needs at least three axes; pick a bar for fewer categories.');
    // The shared indicator bound ECharts needs on every axis. `Math.max(0, ...)` floors at 0 so
    // an all-negative/empty set still yields a finite bound; HC auto-scales, so it is unused there.
    const indicatorMax = Math.max(0, ...data.series.flatMap((s) => s.data.filter((v): v is number => v != null)));
    return {
      kind: 'radar', categories: data.categories, indicatorMax,
      series: data.series.map((s) => ({ name: s.name, data: s.data })),
      valueLabel: data.meta.valueLabel ?? null, legend: data.series.length > 1, ...base,
    };
  }

  if (family === 'paired') {
    if (data.series.length !== 2) throw new BuilderRejection('A dumbbell compares exactly two series; pick a bar for one or many.');
    const [low, high] = data.series;
    return {
      kind: 'paired', categories: data.categories,
      points: data.categories.map((c, i) => ({ name: c, low: low!.data[i] ?? null, high: high!.data[i] ?? null })),
      lowName: low!.name, highName: high!.name,
      categoryLabel: data.meta.categoryLabel ?? null, valueLabel: data.meta.valueLabel ?? null,
      lowColor: PALETTE[0]!, highColor: PALETTE[1]!, ...base,
    };
  }

  if (family === 'bulletValue') {
    // A single value against its target + quality bands. The bands accumulate a `from` (HC's
    // plotBands shape) and carry the BAND_COLORS hue; the top band's `to` stays Infinity in the
    // node (each adapter resolves it — HC keeps the raw Infinity, ECharts clamps to a finite max).
    // BAND_COLORS is read unchanged (Track B's KPI-threshold rendering shares it).
    if (!isSingleValue(data) || data.meta.target == null || !data.meta.bands?.length) {
      throw new BuilderRejection('A bullet needs a single value with a target and quality bands; pick a gauge.');
    }
    const value = data.series[0]!.data[0];
    if (value == null) throw new BuilderRejection('A bullet needs a value; this cell is empty.');
    let from = 0;
    const bands = data.meta.bands.map((band) => { const out = { from, to: band.to, color: BAND_COLORS[band.kind] }; from = band.to; return out; });
    return { kind: 'bulletValue', value, target: data.meta.target, seriesName: data.series[0]!.name, bands, valueLabel: data.meta.valueLabel ?? null, ...base };
  }

  if (family === 'bubble') {
    const pts = data.points;
    if (!pts || pts.length === 0) throw new BuilderRejection('A bubble needs plotted points; this data has none.');
    const sizes = pts.map((pt) => pt.size).filter((s): s is number => s != null && Number.isFinite(s));
    return {
      kind: 'bubble',
      points: pts,
      xLabel: data.series[0]?.name ?? null,
      yLabel: data.series[1]?.name ?? null,
      sizeLabel: data.series[2]?.name ?? null,
      minSize: sizes.length ? Math.min(...sizes) : 0,
      maxSize: sizes.length ? Math.max(...sizes) : 0,
      ...base,
    };
  }

  if (family === 'flow') {
    // Guards (loud rejection, distinct messages) — mirrors the sibling families.
    if (!hasSeriesDimension(data)) throw new BuilderRejection('A Sankey needs a second dimension of homogeneous series to flow into; pick a bar for a single series.');
    if (hasNegative(data)) throw new BuilderRejection('A Sankey cannot show negative values — a flow ribbon has no direction of sign; pick a diverging bar.');
    if (data.categories.length < 2) throw new BuilderRejection('A Sankey needs at least two source categories to flow between; pick a pie for one source\'s split.');

    // Node-name disambiguation — only on collision (a member that is both a source and a target).
    const targetNames = data.series.map((s) => s.name);
    const collide = new Set(data.categories.filter((c) => targetNames.includes(c)));
    const catLabel = data.meta.categoryLabel;
    const serLabel = data.meta.seriesDimensionName;
    const distinctLabels = !!catLabel && !!serLabel && catLabel !== serLabel;
    const sourceName = (c: string) => (collide.has(c) ? (distinctLabels ? `${c} (${catLabel})` : `${c} (source)`) : c);
    const targetName = (t: string) => (collide.has(t) ? (distinctLabels ? `${t} (${serLabel})` : `${t} (target)`) : t);

    // Links: one per non-null cell (a real 0 is kept; null is a gap).
    const links: { source: string; target: string; value: number }[] = [];
    data.categories.forEach((cat, i) => data.series.forEach((s) => {
      const cell = s.data[i];
      if (cell != null) links.push({ source: sourceName(cat), target: targetName(s.name), value: cell });
    }));

    // Nodes: names that actually appear as an endpoint, source-then-target order, unique
    // (an all-null source/target contributes no link, so it is not emitted as an isolated node).
    const linkedSources = new Set(links.map((l) => l.source));
    const linkedTargets = new Set(links.map((l) => l.target));
    const nodeNames: string[] = [];
    data.categories.forEach((c) => { const n = sourceName(c); if (linkedSources.has(n) && !nodeNames.includes(n)) nodeNames.push(n); });
    data.series.forEach((s) => { const n = targetName(s.name); if (linkedTargets.has(n) && !nodeNames.includes(n)) nodeNames.push(n); });

    // Title (caveat 1 — honest, names both axes, never "flow of"); falls back to titleText when a label is absent.
    const title = (data.meta.valueLabel && catLabel && serLabel)
      ? `${data.meta.valueLabel} by ${catLabel} and ${serLabel}`
      : titleText(data);

    // Subtitle (caveat 2 — disclose BOTH truncations; combined when both fire).
    const parts: string[] = [];
    if (data.meta.truncated) parts.push(`top ${data.meta.shown} of ${data.meta.total ?? '?'} sources`);
    if (data.meta.seriesTruncated) parts.push(`top ${data.meta.seriesShown} of ${data.meta.seriesTotal ?? '?'} targets`);
    const flowSubtitle = parts.length ? { text: `Showing ${parts.join(' and ')}` } : undefined;

    return {
      kind: 'flow',
      nodes: nodeNames.map((name) => ({ name })),
      links,
      valueLabel: data.meta.valueLabel ?? null,
      palette: PALETTE,
      title,
      ...(flowSubtitle ? { subtitle: flowSubtitle } : {}),
    };
  }

  throw new BuilderRejection(`plan() has no neutral node for ${type} this round.`);
}
