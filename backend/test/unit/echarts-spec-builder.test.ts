import { describe, it, expect } from 'vitest';
import { EChartsSpecBuilder, brighten, labelColorFor, LABEL_ON_LIGHT, LABEL_ON_DARK, renderECharts, echartsBuilder } from '../../src/dashboard/echarts-spec-builder.js';
import { BuilderRejection, DIVERGE_POS, DIVERGE_NEG, gaugeMax, HEAT_MIN_COLOR, HEAT_MAX_COLOR, BAND_COLORS, PALETTE, LEAF_BRIGHTNESS_RANGE, GAUGE_TRACK, plan, capabilityFor } from '../../src/dashboard/chart-plan.js';
import { CAPABILITY_TYPES } from '../../src/dashboard/chart-type-advisor.js';
import type { ChartData, ChartType } from '../../src/dashboard/chart-data.js';

const b = new EChartsSpecBuilder();
const oneSeries: ChartData = { categories: ['Normal', 'AboveMaximum'], series: [{ name: 'Count', data: [360, 165] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Count', categoryLabel: 'Region' } };
const seriesData: ChartData = { categories: ['North', 'South'], series: [{ name: '2024', data: [10, 20] }, { name: '2025', data: [12, 18] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Year', valueLabel: 'Revenue', categoryLabel: 'Region', seriesShown: 2, seriesTotal: 2, seriesTruncated: false } };
const negSeries: ChartData = { ...seriesData, series: [{ name: '2024', data: [10, -20] }, { name: '2025', data: [12, 18] }] };
const sparsePie: ChartData = { ...oneSeries, series: [{ name: 'Count', data: [360, null] }] };

describe('EChartsSpecBuilder — supports() is the ported families', () => {
  it('true for ALL 22 families now — full parity, nothing HC-only', () => {
    // The nine cheap round-1 families (bar/column/line/area/scatter/pie + the three stacks)
    // plus the round-2 parity ports, one per task. slope + divergingBar (Tasks 1-2) route
    // through the cartesian IR node via a flag; solidgauge (Task 3) gets its own gauge node;
    // bullet (Task 8) the last — declarative bar + markArea + markLine. The fallback set is empty.
    // sankey (flow family) is the round-7 addition — a native ECharts sankey series.
    for (const t of ['bar', 'column', 'line', 'area', 'scatter', 'pie', 'stackedColumn', 'stackedArea', 'stackedColumn100', 'slope', 'divergingBar', 'solidgauge', 'heatmap', 'radar', 'treemap', 'sunburst', 'dumbbell', 'bullet', 'bubble', 'funnel', 'bubbleHeatmap', 'sankey'] as ChartType[]) {
      expect(b.supports(t)).toBe(true);
    }
  });
});

describe('EChartsSpecBuilder — native option shapes', () => {
  it('bar: HORIZONTAL — category on yAxis, value on xAxis (matches the Highcharts `bar` token, which is horizontal; `column` is vertical)', () => {
    const spec = b.build(oneSeries, 'bar') as any;
    // ECharts has no bar-vs-column series type; orientation is set by which axis is the
    // category axis. The workbench `bar` token means horizontal (that is what distinguishes
    // it from `column`), and Highcharts — the back-compat reference renderer — draws it
    // horizontally, so ECharts must too. Category goes on Y, value on X.
    expect(spec.yAxis.type).toBe('category');
    expect(spec.yAxis.data).toEqual(['Normal', 'AboveMaximum']);
    expect(spec.xAxis.type).toBe('value');
    expect(spec.series[0].type).toBe('bar');
    expect(spec.series[0].data).toEqual([360, 165]);
    expect(spec.series[0].colorBy).toBe('data'); // single-series → per-category colour (the HC colorByPoint analogue)
    expect(spec.color).toBeDefined();            // Okabe-Ito palette carried
  });

  it('column: VERTICAL — category on xAxis, value on yAxis (the `bar` token is horizontal; `column` is vertical), colorByPoint on', () => {
    const spec = b.build(oneSeries, 'column') as any;
    expect(spec.xAxis.type).toBe('category');
    expect(spec.xAxis.data).toEqual(['Normal', 'AboveMaximum']);
    expect(spec.yAxis.type).toBe('value');
    expect(spec.series[0].type).toBe('bar'); // ECharts has one bar series type; orientation is axis-driven
    expect(spec.series[0].data).toEqual([360, 165]);
    expect(spec.series[0].colorBy).toBe('data'); // single-series column → per-category colour
  });

  it('line: category xAxis, value yAxis, series.type line; multi-series legend on', () => {
    const spec = b.build(seriesData, 'line') as any;
    expect(spec.xAxis.type).toBe('category');
    expect(spec.xAxis.data).toEqual(['North', 'South']);
    expect(spec.yAxis.type).toBe('value');
    expect(spec.series.map((s: any) => s.type)).toEqual(['line', 'line']);
    expect(spec.series[0].data).toEqual([10, 20]);
    expect(spec.series[0].colorBy).toBeUndefined(); // multi-series → per-series colour, not per-point
    expect(spec.legend.show).toBe(true);
  });

  it('area: a line series with areaStyle (the fill is what distinguishes it from line)', () => {
    const spec = b.build(oneSeries, 'area') as any;
    expect(spec.series[0].type).toBe('line');
    expect(spec.series[0].areaStyle).toEqual({});
  });

  it('scatter: series.type scatter, category xAxis / value yAxis', () => {
    const spec = b.build(oneSeries, 'scatter') as any;
    expect(spec.xAxis.type).toBe('category');
    expect(spec.yAxis.type).toBe('value');
    expect(spec.series[0].type).toBe('scatter');
    expect(spec.series[0].data).toEqual([360, 165]);
  });

  it('stackedArea: line series with areaStyle, all sharing one stack id', () => {
    const spec = b.build(seriesData, 'stackedArea') as any;
    expect(spec.series.map((s: any) => s.type)).toEqual(['line', 'line']);
    expect(spec.series.every((s: any) => s.areaStyle && Object.keys(s.areaStyle).length === 0)).toBe(true);
    const stacks = new Set(spec.series.map((s: any) => s.stack));
    expect(stacks.size).toBe(1);
  });

  it('stackedColumn100: bars sharing one stack + normalized to percent (ECharts has no percent flag — the adapter computes it)', () => {
    // North: 10 + 12 = 22 → 45.45% / 54.55%; South: 20 + 18 = 38 → 52.63% / 47.37%.
    const spec = b.build(seriesData, 'stackedColumn100') as any;
    expect(spec.series.map((s: any) => s.type)).toEqual(['bar', 'bar']);
    const stacks = new Set(spec.series.map((s: any) => s.stack));
    expect(stacks.size).toBe(1);
    // Column sums to ~100 across series (per category), the point of a 100% stack.
    for (let cat = 0; cat < 2; cat++) {
      const colSum = spec.series.reduce((acc: number, s: any) => acc + (s.data[cat] ?? 0), 0);
      expect(colSum).toBeCloseTo(100, 5);
    }
    expect(spec.series[0].data[0]).toBeCloseTo((10 / 22) * 100, 5);
    expect(spec.series[1].data[0]).toBeCloseTo((12 / 22) * 100, 5);
    // yAxis reads 0..100 as a percent axis.
    expect(spec.yAxis.max).toBe(100);
  });

  it('stackedColumn100 preserves a null as null (a gap), not 0, inside the normalized column', () => {
    const sparse: ChartData = { ...seriesData, series: [{ name: '24', data: [10, null] }, { name: '25', data: [null, 18] }] };
    const spec = b.build(sparse, 'stackedColumn100') as any;
    // North: only 10 present → 100%; the null stays null. South: only 18 present → 100%.
    expect(spec.series[0].data[0]).toBeCloseTo(100, 5);
    expect(spec.series[0].data[1]).toBeNull();
    expect(spec.series[1].data[0]).toBeNull();
    expect(spec.series[1].data[1]).toBeCloseTo(100, 5);
  });

  it('pie: one pie series of {name,value}; a hole stays value:null (never 0)', () => {
    const spec = b.build(sparsePie, 'pie') as any;
    expect(spec.series[0].type).toBe('pie');
    expect(spec.series[0].data).toEqual([{ name: 'Normal', value: 360 }, { name: 'AboveMaximum', value: null }]);
  });

  it('pie: slices carry a white divider border so adjacent slices separate (Highcharts parity)', () => {
    const spec = b.build(oneSeries, 'pie') as any;
    expect(spec.series[0].type).toBe('pie');
    expect(spec.series[0].itemStyle.borderColor).toBe('#ffffff'); // SLICE_DIVIDER, fixed white both themes
    expect(spec.series[0].itemStyle.borderWidth).toBeGreaterThan(0); // exact width is gallery-tuned, not pinned
  });

  it('pie: identity rides direct pointing labels (name + leader line), NOT a legend below', () => {
    // A pie's slices ARE its categories, so the category name is drawn AT each wedge with a leader
    // line to it — the reader matches label→slice by the line, not by hunting a colour swatch in a
    // legend. No legend box (a single-series chart needs none; the legend just repeats every name and
    // its swatches collide once the category count climbs — the clutter Karsten flagged).
    const spec = b.build(oneSeries, 'pie') as any;
    expect(spec.series[0].label).toMatchObject({ show: true, formatter: '{b}' }); // {b} = the category name
    expect(spec.series[0].labelLine).toMatchObject({ show: true });
    expect(spec.legend.show).toBe(false);
  });

  it('pie: pointing labels are size-responsive (hideOverlap) — the small tile drops crowded labels, the zoom shows all', () => {
    // The analogue of the sibling bar chart's category-axis auto-thinning: ONE spec, both behaviours,
    // driven by the rendered box. hideOverlap lets ECharts drop labels that would collide in the small
    // tile and show every label once the zoom modal gives them room — so a 24-category pie never
    // clutters the tile yet stays fully labelled when opened.
    const spec = b.build(oneSeries, 'pie') as any;
    expect(spec.series[0].labelLayout).toMatchObject({ hideOverlap: true });
  });

  it('stackedColumn: every series is a bar with the SAME stack id; legend on; nulls preserved', () => {
    const spec = b.build({ ...seriesData, series: [{ name: '2024', data: [10, null] }, { name: '2025', data: [null, 18] }] }, 'stackedColumn') as any;
    expect(spec.series.map((s: any) => s.type)).toEqual(['bar', 'bar']);
    const stacks = new Set(spec.series.map((s: any) => s.stack));
    expect(stacks.size).toBe(1);          // one shared stack id
    expect(spec.series[0].data).toEqual([10, null]);
    expect(spec.legend.show).toBe(true);
  });

  it('stackedColumn / stackedColumn100: each bar segment carries a white divider; stackedArea gets none', () => {
    for (const t of ['stackedColumn', 'stackedColumn100'] as ChartType[]) {
      const spec = b.build(seriesData, t) as any;
      for (const s of spec.series) {
        expect(s.itemStyle.borderColor).toBe('#ffffff');       // SLICE_DIVIDER on the bar stacks
        expect(s.itemStyle.borderWidth).toBeGreaterThan(0);    // width is gallery-tuned, not pinned
      }
    }
    // stackedArea does not divide its bands — Highcharts fills area stacks with no border, so we match.
    const area = b.build(seriesData, 'stackedArea') as any;
    for (const s of area.series) expect(s.itemStyle).toBeUndefined();
  });

  it('slope: a 2-category line with endpoint labels; supports() true', () => {
    const twoCats: ChartData = { categories: ['Before', 'After'], series: [{ name: 'A', data: [3, 8] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Score', categoryLabel: 'Phase' } };
    expect(b.supports('slope')).toBe(true);
    const spec = b.build(twoCats, 'slope') as any;
    expect(spec.series[0].type).toBe('line');
    expect(spec.series[0].label).toMatchObject({ show: true });
    expect(spec.xAxis.data).toEqual(['Before', 'After']);
  });

  it('divergingBar: horizontal bar, per-point sign colour, zero-baseline markLine; supports() true', () => {
    const negCats: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Delta', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    expect(b.supports('divergingBar')).toBe(true);
    const spec = b.build(negCats, 'divergingBar') as any;
    expect(spec.yAxis.type).toBe('category'); // horizontal: category on Y (matches HC inverted bar)
    expect(spec.xAxis.type).toBe('value');
    expect(spec.series[0].type).toBe('bar');
    expect(spec.series[0].data.map((p: any) => p.itemStyle.color)).toEqual([DIVERGE_POS, DIVERGE_NEG, DIVERGE_POS]);
    expect(spec.series[0].markLine.data).toEqual([{ xAxis: 0 }]);
  });

  it('solidgauge: progress-arc semicircle — no needle/ticks, value-fill axisLine, big number + label; supports() true', () => {
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    expect(b.supports('solidgauge')).toBe(true);
    const spec = b.build(scalar, 'solidgauge') as any;
    const s = spec.series[0];
    expect(s.type).toBe('gauge');
    expect(s.min).toBe(0);
    expect(s.max).toBe(gaugeMax(42)); // 50
    expect(s.startAngle).toBe(180); // semicircle, mirroring HC's half-circle solid gauge
    expect(s.endAngle).toBe(0);
    // The arc IS the fill: a two-stop axisLine, palette hue up to value/max then the neutral track.
    expect(s.axisLine.lineStyle.color).toEqual([[42 / gaugeMax(42), PALETTE[0]], [1, GAUGE_TRACK]]);
    // Still needle-less (no pointer, no separate progress bar), but now with a Highcharts-style scale.
    expect(s.pointer).toEqual({ show: false });
    expect(s.progress).toEqual({ show: false });
    // Fix 4b (2026-08-28): a Highcharts-style scale — numbers on major splitlines (minor ticks OFF,
    // matching HC's gauge). The spec sets only theme-INDEPENDENT geometry; the scale ink is injected
    // per-theme by applyEChartsChrome (a hard-coded grey was unreadable in dark mode — 2026-08-28
    // pixel review), so NO colour is asserted here.
    expect(s.axisTick.show).toBe(false);           // minor ticks off (HC shows none; read as clutter)
    expect(s.splitLine.show).toBe(true);           // major splitlines carry the scale numbers
    expect(s.splitLine.length).toBe(40);           // span the value band
    expect(s.splitLine.lineStyle).toBeUndefined(); // colour comes from the theme merge, not here
    expect(s.axisLabel.show).toBe(true);
    expect(s.axisLabel.distance).toBe(48);         // push the numbers off the 40px value band (geometry, not colour)
    expect(s.axisLabel.color).toBeUndefined();     // colour comes from the theme merge, not here
    expect(s.splitNumber).toBe(5); // five intervals over the dynamic gaugeMax (→ 0/10/20/30/40/50 at max 50)
    expect(s.detail.formatter).toBe('{value}'); // the big centred number
    expect(s.title.show).toBe(true);             // the value label below it
    expect(s.data).toEqual([{ value: 42, name: 'Count' }]);
  });

  it('solidgauge: a zero value shows an all-track arc (0-fill stop, no divide-by-zero)', () => {
    const zero: ChartData = { categories: [], series: [{ name: 'Count', data: [0] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    const s = (b.build(zero, 'solidgauge') as any).series[0];
    // gaugeMax(0) === 1, value 0 → first stop at 0 (empty fill), remainder is all track.
    expect(s.axisLine.lineStyle.color).toEqual([[0, PALETTE[0]], [1, GAUGE_TRACK]]);
  });

  it('solidgauge with thresholds: three layers — zone ring (back), value fill (front), dashed target tick', () => {
    const kpi: ChartData = { categories: [], series: [{ name: 'On-Hand Inventory', data: [48100] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'On-Hand Inventory',
        target: 40000, bands: [{ to: 30000, kind: 'warning' }, { to: 40000, kind: 'watching' }, { to: Infinity, kind: 'ok' }] } };
    const spec = b.build(kpi, 'solidgauge') as any;
    expect(spec.series).toHaveLength(3);
    const [ring, fill, tick] = spec.series;
    const max = gaugeMax(48100); // 50000

    // --- Zone ring (back): thin full-arc R/Y/G ramp, radius 100%, every decoration but the ramp OFF. ---
    expect(ring.type).toBe('gauge');
    expect(ring.radius).toBe('100%');
    expect(ring.axisLine.lineStyle.width).toBe(10);
    // stops = band `to` / max, ascending; the Infinity top band clamps to 1.0.
    expect(ring.axisLine.lineStyle.color).toEqual([
      [30000 / max, BAND_COLORS.warning],
      [40000 / max, BAND_COLORS.watching],
      [1, BAND_COLORS.ok],
    ]);
    // ECharts gauge decorations default show:true — the ring is a PURE ramp, so assert show:false
    // EXPLICITLY (not key-absence: absence renders the defaults, which would lock the defect in).
    expect(ring.pointer).toEqual({ show: false });
    expect(ring.anchor).toEqual({ show: false });
    expect(ring.progress).toEqual({ show: false });
    expect(ring.axisTick).toEqual({ show: false });
    expect(ring.splitLine).toEqual({ show: false });
    expect(ring.axisLabel).toEqual({ show: false });
    expect(ring.title).toEqual({ show: false });
    expect(ring.detail).toEqual({ show: false });

    // --- Value fill (front): pulled-in radius 86%, thick two-stop blue arc, the scale-bearer. ---
    expect(fill.radius).toBe('86%');
    expect(fill.axisLine.lineStyle.width).toBe(28);
    expect(fill.axisLine.lineStyle.color).toEqual([[48100 / max, PALETTE[0]], [1, GAUGE_TRACK]]);
    expect(fill.axisLabel.show).toBe(true);   // the fill carries the readable scale (Task 3 keys on this)
    expect(fill.splitLine.show).toBe(true);
    expect(fill.detail.formatter).toBe('{value}');
    expect(fill.data).toEqual([{ value: 48100, name: 'On-Hand Inventory' }]);

    // --- Target tick: degenerate min:max:target overlay, only splitLine shown, axisLine OFF. ---
    expect(tick.min).toBe(40000);
    expect(tick.max).toBe(40000);
    expect(tick.axisLine).toEqual({ show: false }); // no ramp on the tick (Task 3 keys on this)
    expect(tick.splitLine.show).toBe(true);
    expect(tick.splitLine.lineStyle.type).toBe('dashed');
    expect(tick.splitLine.lineStyle.color).toBeUndefined(); // theme ink injected on the FE (Task 3)
    expect(tick.pointer).toEqual({ show: false });
    expect(tick.axisLabel).toEqual({ show: false });
    expect(tick.detail).toEqual({ show: false });
    expect(tick.title).toEqual({ show: false });
    expect(tick.data).toEqual([{ value: 40000 }]);
  });

  it('solidgauge with a target but no bands: single arc + target tick (no zone ring)', () => {
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count', target: 40 } };
    const spec = b.build(scalar, 'solidgauge') as any;
    expect(spec.series).toHaveLength(2);
    expect(spec.series[0].radius).toBe('100%');       // the single arc, unchanged
    expect(spec.series[0].axisLine.lineStyle.width).toBe(40);
    expect(spec.series[1].axisLine).toEqual({ show: false }); // the target tick
    expect(spec.series[1].min).toBe(40);
  });

  it('solidgauge with no thresholds is a single unchanged arc (no tick, no ring)', () => {
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    const spec = b.build(scalar, 'solidgauge') as any;
    expect(spec.series).toHaveLength(1);
    expect(spec.series[0].radius).toBe('100%');
    expect(spec.series[0].axisLine.lineStyle.width).toBe(40);
  });

  it('percentage gauge: full-circle geometry (90 → -270), centre 50/50, max 100, %-suffixed readout, scale OFF', () => {
    const pct: ChartData = { categories: [], series: [{ name: 'Fill Rate', data: [82] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Fill Rate', unit: 'percent' } };
    const s = (b.build(pct, 'solidgauge') as any).series[0];
    expect(s.startAngle).toBe(90);
    expect(s.endAngle).toBe(-270);              // a full 360° clockwise from 12 o'clock
    expect(s.center).toEqual(['50%', '50%']);
    expect(s.max).toBe(100);
    expect(s.axisLine.lineStyle.color).toEqual([[82 / 100, PALETTE[0]], [1, GAUGE_TRACK]]);
    expect(s.detail.formatter).toBe('{value}%');
    expect(s.detail.offsetCenter).toEqual([0, '0%']); // dead centre for the ring
    expect(s.axisLabel.show).toBe(false);       // no speedometer numbers on the ring
    expect(s.splitLine.show).toBe(false);
    expect(s.data).toEqual([{ value: 82, name: 'Fill Rate' }]);
  });

  it('percentage gauge over 100 (C-SPEC-01): the fill arc clamps at 1, the readout keeps the true value', () => {
    const over: ChartData = { categories: [], series: [{ name: 'Fill Rate', data: [120] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Fill Rate', unit: 'percent' } };
    const s = (b.build(over, 'solidgauge') as any).series[0];
    expect(s.axisLine.lineStyle.color).toEqual([[1, PALETTE[0]], [1, GAUGE_TRACK]]); // clamped — no out-of-range stop
    expect(s.data).toEqual([{ value: 120, name: 'Fill Rate' }]);                     // true value in the centre readout
  });

  it('percentage gauge with thresholds: three layers, all full-circle; band arcs = to/100', () => {
    const pct: ChartData = { categories: [], series: [{ name: 'Fill Rate', data: [82] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Fill Rate', unit: 'percent',
        target: 90, bands: [{ to: 80, kind: 'warning' }, { to: 90, kind: 'watching' }, { to: Infinity, kind: 'ok' }] } };
    const spec = b.build(pct, 'solidgauge') as any;
    expect(spec.series).toHaveLength(3);
    const [ring, fill, tick] = spec.series;
    expect(ring.startAngle).toBe(90);
    expect(ring.endAngle).toBe(-270);
    expect(ring.axisLine.lineStyle.color).toEqual([[80 / 100, BAND_COLORS.warning], [90 / 100, BAND_COLORS.watching], [1, BAND_COLORS.ok]]);
    expect(fill.center).toEqual(['50%', '50%']);
    expect(tick.min).toBe(90);   // target tick at target/100 of the full circle
    expect(tick.max).toBe(90);
  });

  it('raw solidgauge is byte-identical to today (half-circle, gaugeMax, plain {value}, scale ON)', () => {
    const raw: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    const s = (b.build(raw, 'solidgauge') as any).series[0];
    expect(s.startAngle).toBe(180);
    expect(s.endAngle).toBe(0);
    expect(s.center).toEqual(['50%', '80%']);
    expect(s.max).toBe(gaugeMax(42));
    expect(s.detail.formatter).toBe('{value}');
    expect(s.axisLabel.show).toBe(true);
  });

  it('heatmap: matrix series over category axes with a continuous visualMap spanning the finite extent; supports() true', () => {
    const twoSeries: ChartData = { categories: ['Q1', 'Q2'], series: [{ name: 'Plan', data: [10, 20] }, { name: 'Actual', data: [8, 22] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Amount', categoryLabel: 'Quarter' } };
    expect(b.supports('heatmap')).toBe(true);
    const spec = b.build(twoSeries, 'heatmap') as any;
    expect(spec.xAxis.type).toBe('category');
    expect(spec.xAxis.data).toEqual(['Q1', 'Q2']);
    expect(spec.yAxis.type).toBe('category');
    expect(spec.yAxis.data).toEqual(['Plan', 'Actual']);
    expect(spec.series[0].type).toBe('heatmap');
    expect(spec.series[0].data).toEqual([[0, 0, 10], [1, 0, 20], [0, 1, 8], [1, 1, 22]]);
    // The visualMap is what paints the cells; it must span the real data extent (matching HC's
    // auto-scaling colorAxis) with the same single-hue ramp endpoints.
    expect(spec.visualMap.type).toBe('continuous');
    expect(spec.visualMap.min).toBe(8);
    expect(spec.visualMap.max).toBe(22);
    expect(spec.visualMap.inRange.color).toEqual([HEAT_MIN_COLOR, HEAT_MAX_COLOR]);
  });

  it('heatmap: an ALL-NEGATIVE matrix keeps a non-degenerate visualMap span (C-PLAN-02 regression guard)', () => {
    // capabilityFor pushes heatmap on n>=2 with no !hasNegative guard, so a negative matrix is
    // reachable. A 0-floored visualMap would collapse to {0,0} here and mis-colour every cell.
    const negMatrix: ChartData = { categories: ['A', 'B'], series: [{ name: 'X', data: [-4, -1] }, { name: 'Y', data: [-9, -2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    const spec = b.build(negMatrix, 'heatmap') as any;
    expect(spec.visualMap.min).toBe(-9);
    expect(spec.visualMap.max).toBe(-1);
    expect(spec.visualMap.min).not.toBe(spec.visualMap.max); // non-degenerate span
  });

  it('radar: native radar series with per-category indicators; nulls preserved; supports() true', () => {
    const negCats: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Delta', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    expect(b.supports('radar')).toBe(true);
    const spec = b.build(negCats, 'radar') as any;
    expect(spec.series[0].type).toBe('radar');
    expect(spec.radar.indicator).toEqual([{ name: 'A', max: 6 }, { name: 'B', max: 6 }, { name: 'C', max: 6 }]);
    expect(spec.series[0].data).toEqual([{ name: 'Delta', value: [4, -2, 6] }]);
  });

  it('radar: fills the tile — an explicit radius + center are set (exact values gallery-tuned, not pinned)', () => {
    const negCats: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Delta', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    const spec = b.build(negCats, 'radar') as any;
    expect(spec.radar.radius).toBeDefined();  // set so ECharts' small default is overridden
    expect(spec.radar.center).toBeDefined();  // recentred so a wide tile is filled without clipping labels
  });

  it('treemap flat: native treemap of {name,value}; one hue per leaf; nulls preserved; supports() true', () => {
    const oneSeries: ChartData = { categories: ['Normal', 'AboveMaximum'], series: [{ name: 'Count', data: [360, 165] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Count', categoryLabel: 'Region' } };
    expect(b.supports('treemap')).toBe(true);
    const spec = b.build(oneSeries, 'treemap') as any;
    expect(spec.series[0].type).toBe('treemap');
    // Each node carries an explicit palette hue (ECharts leaves a single-level treemap mono otherwise)
    // + a fill-luminance-matched label colour (ECharts labels default to white → unreadable on light fills).
    expect(spec.series[0].data).toEqual([
      { name: 'Normal', value: 360, itemStyle: { color: PALETTE[0] }, label: { color: labelColorFor(PALETTE[0]!) } },
      { name: 'AboveMaximum', value: 165, itemStyle: { color: PALETTE[1] }, label: { color: labelColorFor(PALETTE[1]!) } },
    ]);
  });

  it('treemap nested + sunburst: children tree with branch-hue + per-leaf brightness gradient (not mono); supports() true', () => {
    expect(b.supports('sunburst')).toBe(true);
    for (const t of ['treemap', 'sunburst'] as ChartType[]) {
      const spec = b.build(seriesData, t) as any;
      expect(spec.series[0].type).toBe(t);
      // Branch hue = palette index; a branch's two leaves span brightness 0..LEAF_BRIGHTNESS_RANGE
      // (first leaf = branch hue, last = brightest). Explicit colours because ECharts inherits
      // parent colour inconsistently (leaves would render mono).
      const b0 = PALETTE[0]!, b1 = PALETTE[1]!;
      const b0hi = brighten(b0, LEAF_BRIGHTNESS_RANGE), b1hi = brighten(b1, LEAF_BRIGHTNESS_RANGE);
      const lab = (fill: string) => ({ color: labelColorFor(fill) });
      expect(spec.series[0].data).toEqual([
        { name: 'North', itemStyle: { color: b0 }, label: lab(b0), children: [
          { name: '2024', value: 10, itemStyle: { color: b0 }, label: lab(b0) },
          { name: '2025', value: 12, itemStyle: { color: b0hi }, label: lab(b0hi) },
        ] },
        { name: 'South', itemStyle: { color: b1 }, label: lab(b1), children: [
          { name: '2024', value: 20, itemStyle: { color: b1 }, label: lab(b1) },
          { name: '2025', value: 18, itemStyle: { color: b1hi }, label: lab(b1hi) },
        ] },
      ]);
      // distinct leaf colours within a branch — the mono-leaf defect this guards against.
      const northLeaves = spec.series[0].data[0].children.map((c: any) => c.itemStyle.color);
      expect(new Set(northLeaves).size).toBe(2);
    }
  });

  it('brighten: amount 0 is identity (matches the branch hue), positive amount lightens, clamps at #FFFFFF', () => {
    expect(brighten('#0072B2', 0)).toBe('#0072B2');            // first leaf keeps the branch hue exactly
    expect(brighten('#000000', 0.5)).toBe('#808080');          // +0.5×255 ≈ 128 per channel
    expect(brighten('#0072B2', 1)).toBe('#FFFFFF');            // clamps at white, never overflows
  });

  it('labelColorFor: dark ink on light fills, white on dark — readable on the light palette hues + brightened leaves', () => {
    // Dark fills → white text.
    expect(labelColorFor('#0072B2')).toBe(LABEL_ON_DARK);   // palette blue (dark)
    expect(labelColorFor('#D55E00')).toBe(LABEL_ON_DARK);   // palette vermillion (dark)
    expect(labelColorFor('#000000')).toBe(LABEL_ON_DARK);
    // Light fills → dark ink (the unreadable-white cases this fixes).
    expect(labelColorFor('#F0E442')).toBe(LABEL_ON_LIGHT);  // palette yellow — white was invisible
    expect(labelColorFor('#56B4E9')).toBe(LABEL_ON_LIGHT);  // palette light blue
    expect(labelColorFor(brighten('#0072B2', LEAF_BRIGHTNESS_RANGE))).toBe(LABEL_ON_LIGHT); // brightest leaf
    expect(labelColorFor('#FFFFFF')).toBe(LABEL_ON_LIGHT);
  });

  it('every treemap/sunburst node label colour is readable on its own fill (no white-on-light)', () => {
    for (const t of ['treemap', 'sunburst'] as ChartType[]) {
      const spec = b.build(seriesData, t) as any;
      const walk = (nodes: any[]): void => nodes.forEach((n) => {
        expect(n.label.color).toBe(labelColorFor(n.itemStyle.color)); // label matches its own fill's luminance
        if (n.children) walk(n.children);
      });
      walk(spec.series[0].data);
    }
  });

  it('dumbbell: two scatter endpoint series + markLine connectors; declarative (JSON-safe); supports() true', () => {
    const twoSeries: ChartData = { categories: ['Q1', 'Q2'], series: [{ name: 'Plan', data: [10, 20] }, { name: 'Actual', data: [8, 22] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Amount', categoryLabel: 'Quarter' } };
    expect(b.supports('dumbbell')).toBe(true);
    const spec = b.build(twoSeries, 'dumbbell') as any;
    expect(spec.series.map((s: any) => s.type)).toEqual(['scatter', 'scatter']);
    expect(spec.series[0].data).toEqual([10, 20]); // low endpoints
    expect(spec.series[1].data).toEqual([8, 22]);  // high endpoints
    // connectors are markLine coordinate pairs on the first series, keyed by category name
    expect(spec.series[0].markLine.data).toEqual([
      [{ coord: ['Q1', 10] }, { coord: ['Q1', 8] }],
      [{ coord: ['Q2', 20] }, { coord: ['Q2', 22] }],
    ]);
    // No function anywhere in the spec (must survive JSON.stringify).
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });

  it('bullet: horizontal bar + markArea bands + markLine target; Infinity resolved to finite xAxis.max; supports() true', () => {
    const bulletData: ChartData = { categories: [], series: [{ name: 'Late', data: [7] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Late Orders', target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' }] } };
    expect(b.supports('bullet')).toBe(true);
    const spec = b.build(bulletData, 'bullet') as any;
    expect(spec.yAxis.type).toBe('category'); // horizontal (matches HC inverted bullet)
    expect(spec.xAxis.type).toBe('value');
    expect(typeof spec.xAxis.max).toBe('number');   // Infinity resolved to a finite bound
    expect(Number.isFinite(spec.xAxis.max)).toBe(true);
    expect(spec.series[0].type).toBe('bar');
    expect(spec.series[0].data).toEqual([7]);
    expect(spec.series[0].barWidth).toBe('55%'); // proportional measure bar (not a fixed-px sliver) — fills the category band like HC
    // bands sit BENEATH the grid splitLine layer (z:-1) so the vertical gridlines show through them —
    // an opaque markArea at default z occludes them (2026-08-28 pixel review). HC draws bands below gridlines natively.
    expect(spec.series[0].markArea.z).toBe(-1);
    // three band areas, each an [{xAxis:from,itemStyle.color},{xAxis:to}] pair; top band's `to` is the finite max.
    expect(spec.series[0].markArea.data).toHaveLength(3);
    expect(spec.series[0].markArea.data.map((band: any) => band[0].itemStyle.color)).toEqual([BAND_COLORS.ok, BAND_COLORS.watching, BAND_COLORS.warning]);
    expect(spec.series[0].markArea.data[2][1].xAxis).toBe(spec.xAxis.max); // top band closes at the finite max, not Infinity/null
    expect(spec.series[0].markLine.data).toEqual([{ xAxis: 5 }]); // target
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec); // JSON-safe: no Infinity, no functions
  });

  it('bullet: value-axis shows its numeric scale (Fix 3) and the single label sits below it, left row-name suppressed (Fix 5)', () => {
    const bulletData: ChartData = { categories: [], series: [{ name: 'Late', data: [7] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Late Orders', target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' }] } };
    const spec = b.build(bulletData, 'bullet') as any;
    // Fix 3 — the value xAxis renders its scale (line + ticks + labels) AND vertical gridlines, so the
    // measure bar can be tracked against the scale like the Highcharts bullet (2026-08-28 review).
    expect(spec.xAxis.axisLine.show).toBe(true);
    expect(spec.xAxis.axisTick.show).toBe(true);
    expect(spec.xAxis.axisLabel.show).toBe(true);
    expect(spec.xAxis.splitLine.show).toBe(true);
    // Fix 5 — the ONE label is the value-label centred under the scale (xAxis.name), not the left row-name.
    expect(spec.xAxis.name).toBe('Late Orders');
    expect(spec.xAxis.nameLocation).toBe('middle');
    expect(spec.yAxis.axisLabel.show).toBe(false); // left category row-name suppressed (tile header already names the KPI)
    expect(spec.yAxis.name).toBeUndefined();        // value-label no longer duplicated on the category axis
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec); // still JSON-safe (no functions, no Infinity)
  });
});

describe('EChartsSpecBuilder — interactive parity (tooltip + emphasis; Highcharts ships these on, ECharts does not)', () => {
  // Bars/columns (incl. the two column stacks) get an AXIS tooltip with a SHADOW pointer —
  // the band-over-the-category affordance that reads a whole column's values at once.
  it('bar/column/stackedColumn/stackedColumn100 → axis tooltip with a shadow pointer', () => {
    const specs = [
      b.build(oneSeries, 'bar'), b.build(oneSeries, 'column'),
      b.build(seriesData, 'stackedColumn'), b.build(seriesData, 'stackedColumn100'),
    ] as any[];
    for (const spec of specs) {
      expect(spec.tooltip.trigger).toBe('axis');
      expect(spec.tooltip.axisPointer.type).toBe('shadow');
    }
  });

  // Line/area (incl. stacked area) get an AXIS tooltip with a LINE (crosshair) pointer.
  it('line/area/stackedArea → axis tooltip with a line (crosshair) pointer', () => {
    const specs = [
      b.build(seriesData, 'line'), b.build(oneSeries, 'area'), b.build(seriesData, 'stackedArea'),
    ] as any[];
    for (const spec of specs) {
      expect(spec.tooltip.trigger).toBe('axis');
      expect(spec.tooltip.axisPointer.type).toBe('line');
    }
  });

  // Pie/scatter are point-based, so they read the hovered ITEM, not an axis column.
  it('pie/scatter → item tooltip (no axis pointer)', () => {
    for (const spec of [b.build(oneSeries, 'pie'), b.build(oneSeries, 'scatter')] as any[]) {
      expect(spec.tooltip.trigger).toBe('item');
    }
  });

  // The "hovered series lights up, the others fade" behaviour — focus:'series' on every
  // cartesian/stacked series. It only visibly fades when there is more than one series.
  it('cartesian + stacked series focus the hovered series (fade others)', () => {
    for (const [data, type] of [[seriesData, 'line'], [seriesData, 'stackedColumn'], [oneSeries, 'bar']] as [ChartData, ChartType][]) {
      const spec = b.build(data, type) as any;
      for (const s of spec.series) expect(s.emphasis.focus).toBe('series');
    }
  });
});

describe('echarts adapter — bubble (scatter over two value axes, √-area sizing)', () => {
  const bubblePlan = () => plan(
    {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'Lead Time', data: [1, 4, 9] }, { name: 'Fill Rate', data: [90, 80, 70] }],
      points: [
        { x: 1, y: 90, size: 100, label: 'A' },
        { x: 4, y: 80, size: 25, label: 'B' },
        { x: 9, y: 70, size: null, label: 'C' },
      ],
      meta: { truncated: false, shown: 3, dimensionKind: 'categorical' },
    } as ChartData,
    'bubble',
  );

  it('emits value axes and a single scatter series with per-datum numeric symbolSize', () => {
    const spec = renderECharts(bubblePlan()) as any;
    expect(spec.xAxis.type).toBe('value');
    expect(spec.yAxis.type).toBe('value');
    expect(spec.series).toHaveLength(1);
    expect(spec.series[0].type).toBe('scatter');
    const data = spec.series[0].data;
    expect(data.map((d: any) => d.value)).toEqual([[1, 90], [4, 80], [9, 70]]);
    // Area ∝ value: size 100 → 2× the diameter of size 25 (√100 / √25 = 2), above the floor.
    expect(typeof data[0].symbolSize).toBe('number');
    expect(data[0].symbolSize).toBeCloseTo(2 * data[1].symbolSize, 5);
    // null size → the minimum legibility diameter (the disclosed floor).
    expect(data[2].symbolSize).toBe(8);
    expect(data[1].symbolSize).toBeGreaterThanOrEqual(8);
    // Each bubble is coloured by its own category (palette index, wrapping) with a semi-transparent
    // fill + thin white border, so a point stays identifiable by hue when a crowded cluster drops its
    // label — the bubble-vs-mono-scatter distinction. Same per-item palette pattern as the treemap.
    expect(data.map((d: any) => d.itemStyle.color)).toEqual([PALETTE[0], PALETTE[1], PALETTE[2]]);
    expect(data[0].itemStyle.opacity).toBeGreaterThan(0);
    expect(data[0].itemStyle.opacity).toBeLessThan(1);
    expect(data[0].itemStyle.borderColor).toBe('#ffffff'); // SLICE_DIVIDER, fixed white both themes
    expect(data[0].itemStyle.borderWidth).toBeGreaterThan(0);
    // direct labels ride each point, thinned when crowded (same pattern as the pie).
    expect(spec.series[0].label.show).toBe(true);
    expect(spec.series[0].labelLayout.hideOverlap).toBe(true);
    // Both value axes auto-thin their tick labels so large-magnitude numbers don't collide in a
    // small tile ("collapse onto itself"); the zoom modal's larger box shows them all.
    expect(spec.xAxis.axisLabel.hideOverlap).toBe(true);
    expect(spec.yAxis.axisLabel.hideOverlap).toBe(true);
  });

  it('supports bubble', () => {
    expect(echartsBuilder.supports('bubble')).toBe(true);
  });
});

describe('EChartsSpecBuilder — the SAME stacking rejection as Highcharts (shared precondition)', () => {
  it('rejects stacking with no second dimension', () => {
    expect(() => b.build(oneSeries, 'stackedColumn')).toThrow(BuilderRejection);
  });
  it('rejects stacking with any negative value', () => {
    expect(() => b.build(negSeries, 'stackedColumn')).toThrow(BuilderRejection);
  });
  it('rejects an empty ChartData', () => {
    const empty: ChartData = { categories: [], series: [], meta: { truncated: false, shown: 0, dimensionKind: 'categorical' } };
    expect(() => b.build(empty, 'bar')).toThrow(BuilderRejection);
  });
  it('rejects an out-of-band type outright via the supports() gate (defense in depth)', () => {
    // Every real ChartType is now supported (full parity), so the `!supports()` gate can only be
    // reached by an out-of-band token — cast one in to prove the gate still fires cleanly.
    expect(() => b.build(oneSeries, 'gantt' as ChartType)).toThrow(BuilderRejection);
  });
});

describe('echarts adapter — funnel', () => {
  const comp = { categories: ['Visited', 'Added', 'Bought'], series: [{ name: 'Users', data: [1000, 400, 120] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } } as ChartData;
  it('emits a funnel series, sort descending for value order', () => {
    const spec = renderECharts(plan(comp, 'funnel')) as any;
    expect(spec.series[0].type).toBe('funnel');
    expect(spec.series[0].sort).toBe('descending');
    expect(spec.series[0].data.map((d: any) => d.name)).toEqual(['Visited', 'Added', 'Bought']);
  });
  it('identity rides direct segment labels, NOT a legend below (same as the pie; no wasted tile space)', () => {
    const spec = renderECharts(plan(comp, 'funnel')) as any;
    expect(spec.series[0].label.show).toBe(true); // each band is named directly
    expect(spec.legend.show).toBe(false);          // no redundant legend box
  });
  it('funnelSort source → sort none (renderer keeps input order)', () => {
    const spec = renderECharts(plan(comp, 'funnel', { funnelSort: 'source' })) as any;
    expect(spec.series[0].sort).toBe('none');
  });
  it('supports funnel and build threads opts', () => {
    expect(echartsBuilder.supports('funnel')).toBe(true);
    const spec = echartsBuilder.build(comp, 'funnel', { funnelSort: 'source' }) as any;
    expect(spec.series[0].sort).toBe('none');
  });
});

describe('echarts adapter — bubbleHeatmap', () => {
  const grid = { categories: ['A', 'B'], series: [{ name: 'North', data: [1, 4] }, { name: 'South', data: [9, 16] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Region' } } as ChartData;
  it('emits a scatter series with a zero-anchored visualMap and value-driven symbolSize', () => {
    const spec = renderECharts(plan(grid, 'bubbleHeatmap')) as any;
    expect(spec.series[0].type).toBe('scatter');
    expect(spec.visualMap.min).toBe(0);           // zero-anchored, not the data min
    expect(spec.visualMap.max).toBe(16);
    expect(spec.xAxis.type).toBe('category');
    expect(spec.yAxis.type).toBe('category');
    const sizes = spec.series[0].data.map((d: any) => d.symbolSize);
    expect(sizes.every((s: number) => typeof s === 'number')).toBe(true);
  });
  it('marks the series bubbleMatrix so the FE box-sizer fills each dot to its rendered cell', () => {
    const spec = renderECharts(plan(grid, 'bubbleHeatmap')) as any;
    expect(spec.series[0].bubbleMatrix).toBe(true); // the discriminator the FE keys on
  });
  it('carries a value label below each bubble (the number a plain heatmap does NOT show — Karsten)', () => {
    const spec = renderECharts(plan(grid, 'bubbleHeatmap')) as any;
    expect(spec.series[0].label.show).toBe(true);
    expect(spec.series[0].label.position).toBe('bottom'); // below the dot, clear of the fill
    // Labels thin out when the cells are too tight to show every number (a small tile) and all
    // appear when there's room (the zoom view) — the same hideOverlap rule as the bubble/pie.
    expect(spec.series[0].labelLayout.hideOverlap).toBe(true);
    // each non-null cell carries a compact-number formatter; the largest (16) reads "16", not a raw sum.
    const labels = spec.series[0].data.map((d: any) => d.label?.formatter);
    expect(labels).toContain('16');
    expect(labels.every((f: any) => typeof f === 'string')).toBe(true);
  });
  it('compacts large values in the bubble label (1_700_000 → "1.7M", not the raw sum)', () => {
    const big = { categories: ['A'], series: [{ name: 'S', data: [1_700_000] }, { name: 'T', data: [170_123_000] }], meta: { truncated: false, shown: 1, dimensionKind: 'categorical', seriesDimensionName: 'Region' } } as ChartData;
    const spec = renderECharts(plan(big, 'bubbleHeatmap')) as any;
    const labels = spec.series[0].data.map((d: any) => d.label?.formatter);
    expect(labels).toContain('1.7M');
    expect(labels).toContain('170.1M'); // one decimal, honest to the raw 170,123,000
  });
  it('heatmap still renders cells (the existing branch is untouched)', () => {
    const spec = renderECharts(plan(grid, 'heatmap')) as any;
    expect(spec.series[0].type).toBe('heatmap');
  });
  it('supports bubbleHeatmap', () => {
    expect(echartsBuilder.supports('bubbleHeatmap')).toBe(true);
  });
});

describe('EChartsSpecBuilder — sankey (flow) native option shape', () => {
  const sankeyMatrix: ChartData = { categories: ['USA', 'DEU'], series: [{ name: 'Closed', data: [170, 31] }, { name: 'Open', data: [10, 3] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Order Status', valueLabel: 'Total Order Value', categoryLabel: 'Customer Country', seriesShown: 2, seriesTotal: 2, seriesTruncated: false } };

  it('emits a native sankey series with per-node palette colours, links, item tooltip, and NO axes', () => {
    const spec = b.build(sankeyMatrix, 'sankey') as any;
    expect(spec.series[0].type).toBe('sankey');
    expect(spec.series[0].data.map((n: any) => n.name)).toEqual(['USA', 'DEU', 'Closed', 'Open']);
    expect(spec.series[0].data[0].itemStyle.color).toBe(PALETTE[0]);
    expect(spec.series[0].links).toContainEqual({ source: 'USA', target: 'Closed', value: 170 });
    expect(spec.series[0].links).toHaveLength(4);
    expect(spec.series[0].emphasis).toEqual({ focus: 'adjacency' });
    expect(spec.series[0].label).toEqual({ show: true });
    expect(spec.series[0].lineStyle).toEqual({ color: 'gradient', opacity: 0.5 });
    expect(spec.tooltip.trigger).toBe('item');
    expect(spec.xAxis).toBeUndefined();
    expect(spec.yAxis).toBeUndefined();
    expect(spec.title.text).toBe('Total Order Value by Customer Country and Order Status');
    expect(spec.color).toEqual(PALETTE);
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec); // JSON-safe (no functions/Infinity over the wire)
  });

  it('a truncation subtitle rides title.subtext (the disclosure survives to the renderer)', () => {
    const truncated: ChartData = { ...sankeyMatrix, meta: { ...sankeyMatrix.meta, seriesTruncated: true, seriesShown: 8, seriesTotal: 20 } };
    const spec = b.build(truncated, 'sankey') as any;
    expect(spec.title.subtext).toBe('Showing top 8 of 20 targets');
    expect(spec.title.text).toBe('Total Order Value by Customer Country and Order Status');
  });

  it('with NO truncation there is no subtext', () => {
    const spec = b.build(sankeyMatrix, 'sankey') as any;
    expect(spec.title.subtext).toBeUndefined();
  });
});

describe('EChartsSpecBuilder — offer ⇒ builds (capabilityFor and the builder agree, app-wide)', () => {
  // A fixture set chosen so its UNION of offered types spans EVERY capability type — the
  // "app-wide" bar the spec DoD (§316) sets. The first five cover the common shapes; the last
  // three are the spanning fixtures that trigger the three otherwise-unreached types:
  //   radarData      -> radar         (needs >= 3 categories)
  //   divergingData  -> divergingBar  (a negative cell on a categorical axis)
  //   temporalData   -> stackedArea   (a series dimension with dimensionKind 'temporal')
  // Verified against HEAD 4ad3463 (pre-sankey) in an isolated clone: the union of the eight
  // equals CAPABILITY_TYPES exactly (21/21, no missing, no extra); with sankey added it is 22/22.
  const scalar: ChartData = { categories: [], series: [{ name: 'v', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
  const bulletData: ChartData = { categories: [], series: [{ name: 'Late', data: [7] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Late', target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' }] } };
  const bubbleData: ChartData = { categories: ['A', 'B'], series: [{ name: 'X', data: [1, 2] }, { name: 'Y', data: [3, 4] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' }, points: [{ x: 1, y: 2, size: 3, label: 'A' }, { x: 4, y: 5, size: 6, label: 'B' }] };
  const radarData: ChartData = { categories: ['Speed', 'Power', 'Range'], series: [{ name: 'Model A', data: [8, 6, 7] }, { name: 'Model B', data: [5, 9, 4] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', seriesDimensionName: 'Model', valueLabel: 'Score', categoryLabel: 'Metric', seriesShown: 2, seriesTotal: 2, seriesTruncated: false } };
  const divergingData: ChartData = { categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Net', data: [12, -5, 8] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Net Change', categoryLabel: 'Quarter' } };
  const temporalData: ChartData = { categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Web', data: [10, 12, 15] }, { name: 'Mobile', data: [5, 8, 11] }], meta: { truncated: false, shown: 3, dimensionKind: 'temporal', seriesDimensionName: 'Channel', valueLabel: 'Visits', categoryLabel: 'Month', seriesShown: 2, seriesTotal: 2, seriesTruncated: false } };
  const fixtures: ChartData[] = [oneSeries, seriesData, scalar, bulletData, bubbleData, radarData, divergingData, temporalData];

  it('every type capabilityFor offers renders a series-bearing spec without throwing', () => {
    for (const data of fixtures) {
      for (const t of capabilityFor(data)) {
        const spec = renderECharts(plan(data, t)) as any;
        expect(Array.isArray(spec.series), `${t} produced no series array`).toBe(true);
        expect(spec.series.length, `${t} produced an empty series array`).toBeGreaterThan(0);
      }
    }
  });

  it('the fixtures span EVERY capability type — no capability type is left unexercised', () => {
    const offered = new Set<string>();
    for (const data of fixtures) for (const t of capabilityFor(data)) offered.add(t);
    // Machine-checks the "app-wide" claim (spec DoD §316): every type in the canonical allow-list is
    // offered by at least one fixture, so the offer⇒builds loop above genuinely exercises all of them.
    // `missing == []` holds whether or not the advisor list yet carries sankey (Task 3), because every
    // NON-sankey capability type is spanned by these fixtures and sankey is asserted separately below —
    // so this test is green at THIS task's completion and stays green after Task 3.
    const missing = [...CAPABILITY_TYPES].filter((t) => !offered.has(t));
    expect(missing, 'capability types no fixture offers').toEqual([]);
    expect(offered, 'sankey itself must be spanned').toContain('sankey');
    // The reverse guard (capabilityFor offers nothing OUTSIDE the allow-list) is already covered by the
    // existing "recommend never returns a type outside the capability allow-list" and supports()-parity
    // tests, so it is intentionally not re-asserted here (it would also couple this Task-2 test to the
    // Task-3 advisor edit, since capabilityFor offers sankey from Task 1 but the list gains it in Task 3).
  });
});
