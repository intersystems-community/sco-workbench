// backend/src/dashboard/echarts-spec-builder.ts
// The ECharts adapter of the ChartSpecBuilder port. Covers ALL 22 chart types now — full
// parity with the Highcharts adapter (round 2, SC-2654 follow-on). It builds from the
// SAME neutral ChartPlan the Highcharts adapter uses, so the truthfulness guards (hasCells,
// assertStackable, the composition/gauge/matrix/radar/hierarchy/paired/bullet preconditions)
// are the shared logic in chart-plan.ts, not a second copy. Most families map to a native
// ECharts series (bar/line/scatter/pie/gauge/heatmap/radar/treemap/sunburst); the two Tier-4
// dialect seams have no native series and are drawn declaratively — a dumbbell as two scatter
// endpoints joined by a markLine connector, a bullet as a horizontal bar with markArea quality
// bands + a markLine target (the open band's Infinity resolved to a finite xAxis.max, since a
// spec is JSON over the wire — no functions, no Infinity). The registry never asks this adapter
// for a type it does not support; build() still guards it (defense in depth).
import type { ChartData, ChartType, RenderSpec, ChartSpecBuilder } from './chart-data.js';
import { plan, BuilderRejection, DIVERGE_POS, DIVERGE_NEG, GAUGE_TRACK, type ChartPlan } from './chart-plan.js';

const SUPPORTED: ReadonlySet<ChartType> = new Set<ChartType>([
  'bar', 'column', 'line', 'area', 'scatter', 'pie', 'stackedColumn', 'stackedArea', 'stackedColumn100',
  'slope', 'divergingBar', 'solidgauge', 'heatmap', 'radar', 'treemap', 'sunburst', 'dumbbell', 'bullet', 'bubble', 'funnel', 'bubbleHeatmap', 'sankey',
]);

/** The ECharts series-type token + fill for a cartesian seriesType. ECharts has one `bar` series
 *  type (orientation is axis-driven, below), one `line` type, and `area` is a line with an
 *  areaStyle fill — so bar/column collapse to 'bar' and area collapses to 'line'+areaStyle. */
function cartesianSeriesType(seriesType: 'bar' | 'column' | 'line' | 'area' | 'scatter'): { type: string; areaStyle?: Record<string, never> } {
  if (seriesType === 'bar' || seriesType === 'column') return { type: 'bar' };
  if (seriesType === 'scatter') return { type: 'scatter' };
  if (seriesType === 'area') return { type: 'line', areaStyle: {} };
  return { type: 'line' };
}

/** Brighten a #rrggbb hex toward white by `amount` in [0,1] (adds amount×255 to each channel,
 *  clamped) — the ECharts analogue of Highcharts' Color.brighten(). Used to give a nested
 *  treemap/sunburst its per-leaf brightness gradient: HC emits this declaratively via
 *  `levels[].colorVariation:{key:'brightness'}`, but ECharts' treemap and sunburst inherit a
 *  parent's colour inconsistently (leaves come out mono), and a spec is JSON over the wire (no
 *  colour-callback functions), so the adapter computes explicit per-node colours instead. */
export function brighten(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const ch = (i: number) => parseInt(h.slice(i, i + 2), 16);
  const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + amount * 255)));
  // Uppercase output to match the PALETTE convention, so brighten(hue, 0) === hue exactly
  // (the first leaf of a branch keeps its branch hue, the rest brighten from there).
  const hx = (c: number) => adj(c).toString(16).padStart(2, '0').toUpperCase();
  return `#${hx(ch(0))}${hx(ch(2))}${hx(ch(4))}`;
}

/** The readable label colour for text drawn ON a #rrggbb fill — dark ink on a light fill, white on a
 *  dark one. ECharts treemap/sunburst labels default to white, which vanishes on the light palette hues
 *  (yellow, light blue) and on the brightness-gradient leaves, so each node carries an explicit label
 *  colour by its fill's perceived brightness (the classic YIQ threshold). LABEL_ON_LIGHT is the app's
 *  light-theme ink; white is used on dark fills. */
export const LABEL_ON_LIGHT = '#1D1D1F';
export const LABEL_ON_DARK = '#FFFFFF';

/** The white divider drawn BETWEEN adjacent coloured fills — pie slices and stacked-bar segments.
 *  Fixed white in both themes, matching what Highcharts draws. A scale-on-background (the gauge
 *  ticks/numbers) is a distinct role and uses the neutral grey, not this. */
const SLICE_DIVIDER = '#ffffff';
export function labelColorFor(hexFill: string): string {
  const h = hexFill.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const brightness = (r! * 299 + g! * 587 + b! * 114) / 1000; // YIQ perceived brightness, 0..255
  return brightness >= 140 ? LABEL_ON_LIGHT : LABEL_ON_DARK;
}

/** Normalize each category column to percent of its column total, per the 100%-stack contract.
 *  ECharts has NO percent-stacking flag (unlike Highcharts' `stacking:'percent'`), so the adapter
 *  computes the percentages itself. A null stays null (a gap, not 0) and is excluded from the
 *  column total, matching how plan()/the guards treat missing cells. An all-null / zero-sum
 *  column leaves its cells untouched (no divide-by-zero). */
function toPercentColumns(series: { name: string; data: (number | null)[] }[], categoryCount: number): { name: string; data: (number | null)[] }[] {
  const totals: number[] = [];
  for (let c = 0; c < categoryCount; c++) {
    totals[c] = series.reduce((acc, s) => acc + (s.data[c] ?? 0), 0);
  }
  return series.map((s) => ({
    name: s.name,
    data: s.data.map((v, c) => (v == null || !totals[c] ? v : (v / totals[c]!) * 100)),
  }));
}

/**
 * Interactive hover, to parity with Highcharts (which ships tooltips + series highlight ON by
 * default; ECharts ships them OFF). An AXIS tooltip reads a whole category column at once — every
 * series' value with its colour — with a `shadow` band pointer for bars/columns and a `line`
 * crosshair for lines/areas (the idiomatic affordance for each). `emphasis.focus:'series'` is the
 * "hovered series lights up, the others fade" behaviour; it only visibly fades with >1 series but
 * is harmless on one. Pie/scatter are point-based, so they read the hovered ITEM, not an axis. */
const AXIS_TOOLTIP = (pointer: 'shadow' | 'line') => ({ trigger: 'axis' as const, axisPointer: { type: pointer } });
const ITEM_TOOLTIP = { trigger: 'item' as const };
const FOCUS_SERIES = { emphasis: { focus: 'series' as const } };
const BUBBLE_MIN_PX = 8;   // disclosed legibility floor — a null/zero-size datum still reads as a dot
const BUBBLE_MAX_PX = 60;  // diameter for the largest value; area ∝ value below it (diameter ∝ √value)

/** Compact a measure for a data label: 1_700_000 → "1.7M", 170_123_000 → "170M", 950 → "950".
 *  A grid of bubbles carries raw sums too long to sit under each dot, so labels read in SI-ish
 *  units; one decimal, trailing ".0" trimmed, sign-preserving. Pure. */
function compactNumber(v: number): string {
  const abs = Math.abs(v);
  const unit = abs >= 1e9 ? ['B', 1e9] as const : abs >= 1e6 ? ['M', 1e6] as const : abs >= 1e3 ? ['k', 1e3] as const : ['', 1] as const;
  const scaled = v / unit[1];
  // No unit → show up to one decimal only if not integral; with a unit → one decimal, trim ".0".
  const text = unit[0] === '' ? String(Math.round(scaled * 10) / 10) : scaled.toFixed(1).replace(/\.0$/, '');
  return text + unit[0];
}

export function renderECharts(p: ChartPlan): RenderSpec {
  const base = { title: { text: p.title }, color: p.palette };
  if (p.kind === 'cartesian') {
    // ECharts has no bar-vs-column series type: orientation is set by WHICH axis is the
    // category axis. The workbench `bar` token means HORIZONTAL (category on Y, value on X)
    // — that is what distinguishes it from `column` — and Highcharts, the back-compat
    // reference renderer, draws it horizontally, so ECharts must match. Key off p.seriesType so
    // the vertical tokens (column/line/area/scatter) keep category on X.
    const horizontal = p.seriesType === 'bar';
    const categoryAxis = { type: 'category' as const, data: p.categories, name: p.categoryLabel ?? undefined };
    const valueAxis = { type: 'value' as const, name: p.valueLabel ?? undefined };
    const st = cartesianSeriesType(p.seriesType);
    const isBarLike = p.seriesType === 'bar' || p.seriesType === 'column';
    // scatter reads a single point (item); bars/lines read the whole category column (axis).
    const tooltip = p.seriesType === 'scatter' ? ITEM_TOOLTIP : AXIS_TOOLTIP(isBarLike ? 'shadow' : 'line');
    if (p.signColor) {
      // A diverging bar: a single horizontal bar whose points are coloured by sign, with a
      // zero-baseline markLine (the analogue of HC's yAxis.plotLines at 0). ECharts colours a
      // point via per-datum itemStyle; the baseline axis is the value axis, which is xAxis when
      // horizontal (the HC `bar` orientation). markLine is a mark component — silently absent if
      // the module is unregistered, so it is asserted by the FE geometry probe (Task 9).
      const signed = (v: number | null) => (v != null && v < 0 ? DIVERGE_NEG : DIVERGE_POS);
      return {
        ...base, tooltip,
        xAxis: horizontal ? valueAxis : categoryAxis,
        yAxis: horizontal ? categoryAxis : valueAxis,
        legend: { show: false },
        series: [{ type: 'bar', ...FOCUS_SERIES,
          data: p.series[0]!.data.map((v) => ({ value: v, itemStyle: { color: signed(v) } })),
          markLine: { symbol: 'none', silent: true, data: [{ [horizontal ? 'xAxis' : 'yAxis']: 0 }], lineStyle: { color: '#000000', width: 1 } } }],
      };
    }
    return {
      ...base,
      tooltip,
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : valueAxis,
      legend: { show: p.legend },
      series: p.series.map((s) => ({ ...st, ...FOCUS_SERIES, name: s.name, data: s.data,
        ...(p.colorByPoint ? { colorBy: 'data' } : {}),
        // A slope's endpoints carry a per-series label ({a} is the ECharts series-name
        // placeholder — the analogue of Highcharts' {series.name}, a pure-JSON string).
        ...(p.endLabels ? { label: { show: true, formatter: '{a}' } } : {}) })),
    };
  }
  if (p.kind === 'composition') { // 'pie' + 'funnel' now
    if (p.source === 'funnel') {
      // A funnel's stages ARE its categories, carried on DIRECT labels ({b} on each segment) — so, like
      // the sibling pie, it needs NO legend box below. A legend repeats every stage name with no line
      // back to its band and eats the tile's vertical space (the clutter Karsten flagged). Drop it.
      return {
        ...base,
        tooltip: ITEM_TOOLTIP,
        legend: { show: false },
        series: [{
          type: 'funnel',
          sort: p.sort === 'source' ? 'none' : 'descending',
          label: { show: true, formatter: '{b}' },
          data: p.points.map((pt) => ({ name: pt.name, value: pt.value })),
        }],
      };
    }
    // pie follows (fall-through when source:'pie')
    return {
      ...base,
      tooltip: ITEM_TOOLTIP,
      // A pie's slices ARE its categories, so identity rides DIRECT labels that point at each wedge
      // (the category name + a leader line to it) — NOT a legend below. A legend repeats every name
      // with no line back to its slice, so it is the harder-to-match duplicate and its swatches
      // collide once the category count climbs (the clutter Karsten flagged). Keep the pointing
      // labels, drop the legend (a single-series chart needs no legend box — dataviz).
      //
      // labelLayout.hideOverlap makes the pointing labels SIZE-RESPONSIVE, the exact analogue of the
      // sibling bar chart's category-axis auto-thinning: in the small dashboard tile the crowded
      // labels that would collide are dropped so only the ones that fit are drawn, and in the zoom
      // modal the larger box lets every label spread out and show. One spec, both behaviours, driven
      // by the rendered box — no per-view branching. Exact values come from the item tooltip on hover.
      // The label INK is theme-dependent, injected on the FE (themeSeriesInk) so the light-palette
      // hues stay legible; only the geometry lives here.
      legend: { show: false },
      series: [{ type: 'pie', name: 'value',
        label: { show: true, formatter: '{b}' }, labelLine: { show: true }, labelLayout: { hideOverlap: true },
        itemStyle: { borderColor: SLICE_DIVIDER, borderWidth: 2 },
        data: p.points.map((pt) => ({ name: pt.name, value: pt.value })) }],
    };
  }
  if (p.kind === 'gauge') {
    // A half-circle gauge (startAngle 180 → endAngle 0), mirroring the Highcharts solidgauge. The
    // arc IS the value fill: a two-stop axisLine (palette hue up to value/max, then the neutral
    // GAUGE_TRACK) — no needle, no progress bar. A Highcharts-style scale reads over it (numbers on
    // major splitlines, minor ticks off). The scale INK is theme-dependent, so it is injected on the
    // FE (applyEChartsChrome → themeSeriesInk); only theme-independent geometry lives here.
    //
    // When the KPI carries quality thresholds (Track C, variation C), the gauge gains the bullet's
    // "bands behind the measure" context WITHOUT changing the fill hue: a thin R/Y/G zone ring sits
    // BEHIND the fill and a dashed tick marks the target. NB ECharts gauge decorations default
    // show:true (echarts@6.1.0 GaugeSeries.js — the reason the fill below disables pointer/progress/
    // anchor/axisTick), so the ring and tick MUST set show:false on every decoration they omit or
    // they draw a needle/ticks/numbers/title/second-centre-value over the fill.
    const filled = p.max > 0 ? p.value / p.max : 0;
    // The percentage ring clamps the ARC to a full circle (C-SPEC-01): a value > 100 would push the
    // two-stop colour past 1 (undefined render). The centre readout still shows the true value below.
    const filledArc = p.percent ? Math.min(1, filled) : filled;
    const shared = p.percent
      ? { type: 'gauge' as const, startAngle: 90, endAngle: -270, min: 0, max: 100, center: ['50%', '50%'] }   // full ring, 12 o'clock clockwise
      : { type: 'gauge' as const, startAngle: 180, endAngle: 0, min: 0, max: p.max, center: ['50%', '80%'] };  // today's half-circle
    const hasBands = !!p.bands?.length;

    // The value fill / single arc — the sole scale-bearing layer (axisLabel.show:true). Behind a zone
    // ring it pulls in to radius 86% / width 28; as the standalone fallback it is 100% / width 40,
    // structurally identical to the pre-zones gauge (same values/geometry; key order may differ but no
    // consumer observes it).
    const fill = {
      ...shared, radius: hasBands ? '86%' : '100%', splitNumber: 5,
      axisLine: { lineStyle: { width: hasBands ? 28 : 40, color: [[filledArc, p.palette[0]], [1, GAUGE_TRACK]] } },
      progress: { show: false }, pointer: { show: false }, anchor: { show: false },
      axisTick: { show: false },
      splitLine: { show: !p.percent, length: 40 },
      axisLabel: { show: !p.percent, distance: 48, fontSize: 11 },
      detail: { valueAnimation: false, formatter: p.percent ? '{value}%' : '{value}', fontSize: 42, fontWeight: 'bold', offsetCenter: p.percent ? [0, '0%'] : [0, '-12%'] },
      title: { show: true, offsetCenter: p.percent ? [0, '20%'] : [0, '18%'], fontSize: 13 },
      data: [{ value: p.value, name: p.valueLabel ?? '' }],
    };

    // The dashed target tick — a degenerate min:max:target overlay whose single splitLine sits at the
    // target. axisLine OFF (it carries no ramp); every other decoration OFF; only splitLine shown. No
    // splitLine colour here — the theme ink is injected on the FE (themeSeriesInk keys on axisLine.show:false).
    const targetPos = p.target != null ? Math.max(0, Math.min(p.target, p.max)) : 0;
    const targetTick = p.target != null ? [{
      ...shared, min: targetPos, max: targetPos,
      radius: '100%', splitNumber: 1,
      axisLine: { show: false }, axisTick: { show: false },
      pointer: { show: false }, anchor: { show: false }, progress: { show: false },
      axisLabel: { show: false }, title: { show: false }, detail: { show: false },
      splitLine: { show: true, distance: -12, length: 14, lineStyle: { width: 2, type: 'dashed' } },
      data: [{ value: targetPos }],
    }] : [];

    if (!hasBands) {
      // Fallback: today's single arc (+ optional target tick). No ring.
      return { ...base, series: [fill, ...targetTick] };
    }

    // Zone ring (back): a thin full-arc R/Y/G ramp. Stops = each band's `to`/max, ascending; an
    // Infinity top-band `to` clamps to 1.0, and the final stop is forced to 1 so the ring always
    // fills to the end (same Infinity-resolution rule the bullet uses). A PURE ramp — so every
    // decoration but the axisLine is explicitly OFF (see the default-on note above).
    const stops = p.bands!.map((b) => [Math.min(1, Number.isFinite(b.to) ? b.to / p.max : 1), b.color] as [number, string]);
    stops[stops.length - 1] = [1, p.bands![p.bands!.length - 1]!.color];
    const ring = {
      ...shared, radius: '100%', splitNumber: 5,
      axisLine: { lineStyle: { width: 10, color: stops } },
      pointer: { show: false }, anchor: { show: false }, progress: { show: false },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      title: { show: false }, detail: { show: false },
      data: [{ value: p.value }],
    };
    return { ...base, series: [ring, fill, ...targetTick] };
  }
  if (p.kind === 'matrix') {
    // A heatmap: the SAME row-major [x,y,value] triples the HC adapter emits, over two category
    // axes. ECharts paints cells via a `visualMap` (HC does it via an auto-scaling colorAxis), so
    // the map must span the real finite extent [minValue, maxValue] the node carried — not a
    // 0-floor, which would mis-colour negatives and degenerate on an all-negative matrix
    // (C-PLAN-02). The single-hue ramp endpoints match HC's minColor/maxColor. A null cell has no
    // triple value, so ECharts leaves it unpainted (the gap HC fills with nullColor grey).
    const xAxis = { type: 'category' as const, data: p.xCategories, name: p.categoryLabel ?? undefined };
    const yAxis = { type: 'category' as const, data: p.yCategories };
    const visualMap = { type: 'continuous' as const, min: p.minValue, max: p.maxValue, calculable: true, inRange: { color: [p.minColor, p.maxColor] } };
    if (p.render === 'bubbles') {
      const maxV = p.maxValue > 0 ? p.maxValue : 1;
      const data = p.triples.map(([x, y, v]) => ({
        value: [x, y, v],
        // A backend √-area FALLBACK off the fixed BUBBLE_MAX_PX. The FE re-sizes each bubble to its
        // ACTUAL rendered cell (scaleBubbleMatrixToBox) — cell pitch is only known once laid out, the
        // same reason the gauge scales on the FE — but this keeps the unit tier and any non-box render
        // area-honest and non-degenerate.
        symbolSize: v == null ? BUBBLE_MIN_PX : Math.max(BUBBLE_MIN_PX, BUBBLE_MAX_PX * Math.sqrt(Math.max(0, v) / maxV)),
        // The value number is part of what this chart offers over a plain heatmap (Karsten). Null
        // cells carry no value → no label. `label.show` here; the FE inks it for the theme + positions
        // it below the dot (position 'bottom'), so a bubble reads {size, colour, number} at a glance.
        ...(v == null ? {} : { label: { show: true, formatter: compactNumber(v) } }),
      }));
      // A heatmap's visualMap defaults to the value dimension; a scatter's defaults to the x dim, so
      // colour by the 3rd array element [x,y,v] explicitly, else every dot reads the same hue.
      // `bubbleMatrix:true` marks the series for the FE box-sizer (which cannot tell it from a plain
      // scatter by shape); the FE recomputes each symbolSize to fill the ACTUAL rendered cell.
      return { ...base, tooltip: ITEM_TOOLTIP, xAxis, yAxis, visualMap: { ...visualMap, dimension: 2 },
        series: [{ type: 'scatter', bubbleMatrix: true, data,
          // Labels thin out when the cells are too tight to show every number (a small tile) and all
          // appear when there's room (the zoom view) — the same hideOverlap rule as the bubble/pie.
          label: { show: true, position: 'bottom' }, labelLayout: { hideOverlap: true } }] };
    }
    return { ...base, tooltip: ITEM_TOOLTIP, xAxis, yAxis, visualMap, series: [{ type: 'heatmap', data: p.triples }] };
  }
  if (p.kind === 'radar') {
    // A native ECharts radar. Unlike HC's polar-line (a cartesian series over a polar grid),
    // ECharts models it as a dedicated `radar` coordinate system: one shared indicator per
    // category (each bounded by the node's indicatorMax) and one datum per series carrying the
    // whole value vector. It has no x/y axes, so there is no axis chrome.
    return {
      ...base,
      tooltip: ITEM_TOOLTIP,
      legend: { show: p.legend },
      radar: { indicator: p.categories.map((name) => ({ name, max: p.indicatorMax })), radius: '70%', center: ['50%', '55%'] },
      series: [{ type: 'radar', ...FOCUS_SERIES, data: p.series.map((s) => ({ name: s.name, value: s.data })) }],
    };
  }
  if (p.kind === 'hierarchy') {
    // treemap (flat + nested) + sunburst from the SAME node. A flat treemap is one series of
    // {name,value}. A nested treemap / sunburst reshapes the flat rowNodes+leaves the HC adapter
    // emits into ECharts' native `children` tree (one branch per row, its leaves as children) —
    // both adapters read the identical IR node, they just key nesting differently.
    // ECharts treemap/sunburst labels default to WHITE, unreadable on the light palette hues and on the
    // brightness-gradient leaves, so every node carries a fill-luminance-matched label colour (see
    // labelColorFor) alongside its fill (added on review 2026-08-27). A node's label lives under
    // itemStyle.color (fill) + label.color (text).
    const node = (name: string, fill: string, value?: number | null) => ({
      name, ...(value === undefined ? {} : { value }),
      itemStyle: { color: fill }, label: { color: labelColorFor(fill) },
    });
    if (!p.nested) {
      // A flat treemap: one hue per leaf (the branch-level encoding HC gets from level-1
      // colorByPoint). ECharts leaves a single-level treemap mono otherwise, so colour each
      // node explicitly by palette index (wraps if categories exceed the palette).
      return { ...base, tooltip: ITEM_TOOLTIP, series: [{ type: 'treemap', data: p.flatPoints!.map((pt, i) => node(pt.name, p.palette[i % p.palette.length]!, pt.value)) }] };
    }
    // Nested: hue per branch (palette index), brightness gradient across a branch's leaves —
    // the same branch-hue / leaf-brightness encoding HC gets from levels[1].colorByPoint +
    // levels[2].colorVariation{brightness}. ECharts inherits parent colour inconsistently
    // (leaves render mono), so set explicit per-node itemStyle.color here (corrected 2026-08-27).
    const tree = p.rowNodes!.map((r, ri) => {
      const hue = p.palette[ri % p.palette.length]!;
      const kids = p.leaves!.filter((l) => l.parent === r.id);
      return {
        ...node(r.name, hue),
        children: kids.map((l, li) =>
          // spread brightness 0..leafBrightness across the branch's leaves (first leaf = branch
          // hue, last = brightest); a lone leaf stays the branch hue (no divide-by-zero).
          node(l.name, kids.length > 1 ? brighten(hue, (li / (kids.length - 1)) * p.leafBrightness) : hue, l.value)),
      };
    });
    return { ...base, tooltip: ITEM_TOOLTIP, series: [{ type: p.source, data: tree }] };
  }
  if (p.kind === 'paired') {
    // A dumbbell has no native ECharts series. Draw it declaratively: two scatter series (the low
    // and high endpoints), joined per category by a markLine connector. markLine data is a pair of
    // {coord:[category,value]} endpoints — pure JSON, NOT a `custom` renderItem function (which
    // JSON.stringify would silently drop over the wire). The markLine is a mark component: silently
    // absent if the module is unregistered, so its visibility is asserted by the FE probe (Task 9).
    const connectors = p.points.map((pt) => [{ coord: [pt.name, pt.low] }, { coord: [pt.name, pt.high] }]);
    return {
      ...base,
      tooltip: ITEM_TOOLTIP,
      xAxis: { type: 'category', data: p.categories, name: p.categoryLabel ?? undefined },
      yAxis: { type: 'value', name: p.valueLabel ?? undefined },
      legend: { show: true },
      series: [
        { type: 'scatter', name: p.lowName, data: p.points.map((pt) => pt.low), symbolSize: 12, itemStyle: { color: p.lowColor },
          markLine: { symbol: 'none', silent: true, lineStyle: { color: '#999999', width: 2 }, data: connectors } },
        { type: 'scatter', name: p.highName, data: p.points.map((pt) => pt.high), symbolSize: 12, itemStyle: { color: p.highColor } },
      ],
    };
  }
  if (p.kind === 'bulletValue') {
    // A single value against its target + quality bands. ECharts has no native bullet series, so
    // draw it declaratively: a horizontal `bar` (category yAxis, value xAxis — matching HC's
    // inverted bullet), the bands as `markArea` rectangles, the target as a `markLine`. The node's
    // top band carries a raw Infinity `to`; ECharts cannot paint a markArea to Infinity (it drops
    // silently), so resolve the open band to a finite xAxis.max. markArea/markLine are mark
    // components — silently absent if the module is unregistered, so their visibility is asserted
    // by the FE geometry probe (Task 9).
    const lastFinite = p.bands.reduce((m, b) => (Number.isFinite(b.to) ? Math.max(m, b.to) : m), 0);
    const axisMax = Math.max(p.value, p.target, lastFinite) * 1.05;
    const bandTo = (to: number) => (Number.isFinite(to) ? to : axisMax);
    return {
      ...base,
      tooltip: ITEM_TOOLTIP,
      // Fix 3: show the value-axis scale (line/ticks/labels) so the numeric scale under the bands is
      // visible. splitLine ON — the vertical gridlines let a reader track the measure bar against the
      // scale, matching the Highcharts bullet (2026-08-28 pixel review reversed the earlier splitLine-
      // off call). Colours (axis + gridline) inherit from the FE theme merge (the bullet declares this
      // xAxis). Fix 5: the value-label is the ONE label, centred under the scale as the axis name
      // (nameLocation 'middle'), not duplicated on the left.
      xAxis: { type: 'value', max: axisMax,
        axisLine: { show: true }, axisTick: { show: true }, axisLabel: { show: true }, splitLine: { show: true },
        name: p.valueLabel ?? undefined, nameLocation: 'middle', nameGap: 28 },
      // Fix 5: suppress the redundant left row-name (the dashboard tile header already names the KPI);
      // the value-label moved to xAxis.name above, so the category axis carries no `name`.
      yAxis: { type: 'category', data: [p.seriesName], axisLabel: { show: false } },
      legend: { show: false },
      series: [{
        // A proportional width (a fraction of the single category band), not a fixed 12px:
        // the bands (markArea) span the whole plot height, so a 12px bar reads as a sliver in a
        // tall tile. '55%' makes the measure bar fill the category band like HC's bullet measure
        // (corrected on review 2026-08-27).
        type: 'bar', data: [p.value], barWidth: '55%',
        // z:-1 pushes the bands BENEATH the grid's splitLine layer so the vertical gridlines show
        // through them (an opaque markArea at its default z occludes the gridlines — the exact defect
        // the 2026-08-28 pixel review caught; Highcharts draws its plotBands below gridlines natively).
        markArea: { silent: true, z: -1, data: p.bands.map((b) => [{ xAxis: b.from, itemStyle: { color: b.color } }, { xAxis: bandTo(b.to) }]) },
        markLine: { symbol: 'none', silent: true, data: [{ xAxis: p.target }], lineStyle: { color: '#000000', width: 2 } },
      }],
    };
  }
  if (p.kind === 'stacked') {
    // stacked (stackedColumn / stackedArea / stackedColumn100): every series shares one stack id.
    // stackedArea → line+areaStyle; the two column stacks → bar. A 100% stack is normalized to
    // percent here (ECharts has no percent flag) and gets a 0..100 percent yAxis.
    const percent = p.stackingMode === 'percent';
    const seriesData = percent ? toPercentColumns(p.series, p.categories.length) : p.series;
    const st = p.areaNotColumn ? { type: 'line' as const, areaStyle: {} } : { type: 'bar' as const };
    const segmentBorder = p.areaNotColumn ? {} : { itemStyle: { borderColor: SLICE_DIVIDER, borderWidth: 1 } };
    return {
      ...base,
      tooltip: AXIS_TOOLTIP(p.areaNotColumn ? 'line' : 'shadow'),
      xAxis: { type: 'category', data: p.categories, name: p.categoryLabel ?? undefined },
      yAxis: { type: 'value', name: p.valueLabel ?? undefined, ...(percent ? { max: 100 } : {}) },
      legend: { show: true },
      series: seriesData.map((s) => ({ ...st, ...segmentBorder, ...FOCUS_SERIES, name: s.name, stack: 'total', data: s.data })),
    };
  }
  if (p.kind === 'bubble') {
    // diameter ∝ √value so encoded AREA is proportional to the size measure (Kirk area-honesty),
    // normalized to the node's finite maxSize with a floor so a null/zero datum is still visible.
    // Precomputed to a number — the wire spec is JSON, no symbolSize function survives serialization.
    // Each bubble is coloured by its own category (palette index, wrapping like the treemap) so a
    // point is identifiable by hue even when hideOverlap drops its label in a crowded cluster — the
    // difference between a bubble chart and a mono scatter. The fill is semi-transparent so two
    // overlapping bubbles both read through the overlap; a thin SLICE_DIVIDER border defines each edge.
    const data = p.points.map((pt, i) => {
      const symbolSize = pt.size == null || p.maxSize <= 0
        ? BUBBLE_MIN_PX
        : Math.max(BUBBLE_MIN_PX, BUBBLE_MAX_PX * Math.sqrt(Math.max(0, pt.size) / p.maxSize));
      const hue = p.palette[i % p.palette.length]!;
      return { value: [pt.x, pt.y], name: pt.label ?? '', symbolSize,
        itemStyle: { color: hue, opacity: 0.7, borderColor: SLICE_DIVIDER, borderWidth: 1 } };
    });
    // Both value axes auto-thin their tick labels (axisLabel.hideOverlap): a small dashboard tile
    // packs large-magnitude numbers that would otherwise collide along the bottom/side ("collapse
    // onto itself"), so the ones that don't fit are dropped; the zoom modal's larger box shows them
    // all. Size-responsive off the rendered box, the same rule the pie/funnel/point labels use — no
    // per-view branching. Point labels likewise hideOverlap so a dense cluster shows only what fits.
    return {
      ...base,
      tooltip: ITEM_TOOLTIP,
      xAxis: { type: 'value', name: p.xLabel ?? undefined, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: p.yLabel ?? undefined, axisLabel: { hideOverlap: true } },
      series: [{ type: 'scatter', data, label: { show: true, formatter: '{b}', position: 'top' }, labelLayout: { hideOverlap: true } }],
    };
  }
  if (p.kind === 'flow') {
    // A Sankey has no axes — the native `sankey` series lays out source→target ribbons itself. Each
    // node is coloured by its palette index (wrapping like the treemap/bubble) so a node reads by hue;
    // `emphasis.focus: 'adjacency'` dims all but a hovered node's own ribbons. `lineStyle.color:
    // 'gradient'` tints each ribbon between its endpoints' hues so a link's direction is legible. The
    // subtitle (truncation disclosure) rides `title.subtext`, overriding base's bare title only when
    // present — the co-occurrence matrix is often bounded and that cap must never be silent.
    return {
      ...base,
      ...(p.subtitle ? { title: { text: p.title, subtext: p.subtitle.text } } : {}),
      tooltip: ITEM_TOOLTIP,
      series: [{
        type: 'sankey',
        data: p.nodes.map((n, i) => ({ name: n.name, itemStyle: { color: p.palette[i % p.palette.length]! } })),
        links: p.links,
        emphasis: { focus: 'adjacency' },
        label: { show: true },
        lineStyle: { color: 'gradient', opacity: 0.5 },
      }],
    };
  }
  // Every ChartPlan kind is handled above. This assignment fails to compile if a new union member
  // is added without a branch here — an explicit exhaustiveness backstop rather than relying on
  // the last case's property-narrowing to reject a stray kind (a future member structurally
  // compatible with `stacked`'s reads would otherwise fall through silently).
  const _exhaustive: never = p;
  throw new BuilderRejection(`Unhandled chart plan kind: ${(_exhaustive as ChartPlan).kind}`);
}

export class EChartsSpecBuilder implements ChartSpecBuilder {
  supports(type: ChartType): boolean { return SUPPORTED.has(type); }

  build(data: ChartData, type: ChartType, opts?: { funnelSort?: 'value' | 'source' }): RenderSpec {
    if (!this.supports(type)) throw new BuilderRejection(`EChartsSpecBuilder does not build ${type}.`);
    return renderECharts(plan(data, type, opts)); // plan() runs hasCells + the shared guards (incl. assertStackable)
  }
}

export const echartsBuilder = new EChartsSpecBuilder();
