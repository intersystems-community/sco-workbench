import { describe, it, expect } from 'vitest';
import {
  plan, planFamilyOf, capabilityFor, assertStackable, BuilderRejection, PALETTE, gaugeMax, BAND_COLORS,
  type ChartPlan,
} from '../../src/dashboard/chart-plan.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

const oneSeries: ChartData = {
  categories: ['Normal', 'AboveMaximum'],
  series: [{ name: 'Count', data: [360, 165] }],
  meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Count', categoryLabel: 'Region' },
};
const seriesData: ChartData = {
  categories: ['North', 'South'],
  series: [{ name: '2024', data: [10, 20] }, { name: '2025', data: [12, 18] }],
  meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Year', valueLabel: 'Revenue', categoryLabel: 'Region', seriesShown: 2, seriesTotal: 2, seriesTruncated: false },
};
const negSeries: ChartData = {
  categories: ['North', 'South'],
  series: [{ name: '2024', data: [10, -20] }, { name: '2025', data: [12, 18] }],
  meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Year', valueLabel: 'Revenue', categoryLabel: 'Region' },
};

describe('chart-plan — family mapping and neutral IR for the 3 built families', () => {
  it('planFamilyOf maps the built types to their family and returns null otherwise', () => {
    for (const t of ['bar', 'column', 'line', 'area', 'scatter', 'slope', 'divergingBar'] as const) expect(planFamilyOf(t)).toBe('cartesian');
    expect(planFamilyOf('pie')).toBe('composition');
    for (const t of ['stackedColumn', 'stackedColumn100', 'stackedArea'] as const) expect(planFamilyOf(t)).toBe('stacked');
    expect(planFamilyOf('solidgauge')).toBe('gauge');
    expect(planFamilyOf('heatmap')).toBe('matrix');
    expect(planFamilyOf('radar')).toBe('radar');
    for (const t of ['treemap', 'sunburst'] as const) expect(planFamilyOf(t)).toBe('hierarchy');
    expect(planFamilyOf('dumbbell')).toBe('paired');
    expect(planFamilyOf('bullet')).toBe('bulletValue');
  });

  it('cartesian plan carries neutral facts: categories, per-series data (nulls as gaps), labels, palette, legend, colorByPoint', () => {
    const p = plan(oneSeries, 'bar') as any;
    expect(p.kind).toBe('cartesian');
    expect(p.seriesType).toBe('bar');
    expect(p.categories).toEqual(['Normal', 'AboveMaximum']);
    expect(p.series).toEqual([{ name: 'Count', data: [360, 165] }]);
    expect(p.categoryLabel).toBe('Region');
    expect(p.valueLabel).toBe('Count');
    expect(p.legend).toBe(false);       // single series → no legend
    expect(p.colorByPoint).toBe(true);  // single-series bar → colour by point
    expect(p.title).toBe('Count by Region');
    expect(p.palette).toBe(PALETTE);
  });

  it('slope maps to cartesian with endLabels and the two-category guard', () => {
    const twoCats: ChartData = { categories: ['Before', 'After'], series: [{ name: 'A', data: [3, 8] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Score', categoryLabel: 'Phase' } };
    expect(planFamilyOf('slope')).toBe('cartesian');
    const p = plan(twoCats, 'slope') as any;
    expect(p.kind).toBe('cartesian');
    expect(p.seriesType).toBe('line');
    expect(p.endLabels).toBe(true);
    const threeCats: ChartData = { ...twoCats, categories: ['A', 'B', 'C'], series: [{ name: 'A', data: [1, 2, 3] }] };
    expect(() => plan(threeCats, 'slope')).toThrow(BuilderRejection);
  });

  it('divergingBar maps to cartesian with signColor; guard is hasNegative+categorical', () => {
    const negCats: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Delta', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    expect(planFamilyOf('divergingBar')).toBe('cartesian');
    const p = plan(negCats, 'divergingBar') as any;
    expect(p.kind).toBe('cartesian');
    expect(p.seriesType).toBe('bar');
    expect(p.signColor).toBe(true);
    expect(() => plan({ ...negCats, series: [{ name: 'Delta', data: [4, 2, 6] }] }, 'divergingBar')).toThrow(BuilderRejection); // no negative
    expect(() => plan({ ...negCats, meta: { ...negCats.meta, dimensionKind: 'temporal' } }, 'divergingBar')).toThrow(BuilderRejection); // temporal
  });

  it('gauge node carries value + gaugeMax + label + seriesName; guard is single non-negative value', () => {
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    expect(planFamilyOf('solidgauge')).toBe('gauge');
    const p = plan(scalar, 'solidgauge') as any;
    expect(p.kind).toBe('gauge');
    expect(p.value).toBe(42);
    expect(p.max).toBe(gaugeMax(42));
    expect(p.valueLabel).toBe('Count');
    expect(p.seriesName).toBe('Count');
    expect(() => plan({ ...scalar, series: [{ name: 'Count', data: [42, 1] }] }, 'solidgauge')).toThrow(BuilderRejection); // not single
    expect(() => plan({ ...scalar, series: [{ name: 'Count', data: [-1] }] }, 'solidgauge')).toThrow(BuilderRejection); // negative
    expect(() => plan({ ...scalar, series: [{ name: 'Count', data: [null] }] }, 'solidgauge')).toThrow(BuilderRejection); // empty cell
  });

  it('gauge node with thresholds accumulates bands (from BAND_COLORS) + carries target + widens max', () => {
    // Higher-is-better KPI (deriveBands emits kinds warning→watching→ok with ascending `to`, top band Infinity).
    const kpi: ChartData = { categories: [], series: [{ name: 'On-Hand Inventory', data: [48100] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'On-Hand Inventory',
        target: 40000, bands: [{ to: 30000, kind: 'warning' }, { to: 40000, kind: 'watching' }, { to: Infinity, kind: 'ok' }] } };
    const p = plan(kpi, 'solidgauge') as any;
    expect(p.kind).toBe('gauge');
    expect(p.value).toBe(48100);
    expect(p.target).toBe(40000);
    // Bands accumulate a `from` and carry the BAND_COLORS hue, exactly like the bullet; Infinity `to` kept.
    expect(p.bands).toEqual([
      { from: 0, to: 30000, color: BAND_COLORS.warning },
      { from: 30000, to: 40000, color: BAND_COLORS.watching },
      { from: 40000, to: Infinity, color: BAND_COLORS.ok },
    ]);
    // max must cover value(48100), target(40000) AND the last FINITE band `to`(40000) → gaugeMax(48100) = 50000.
    expect(p.max).toBe(gaugeMax(48100));
    expect(p.max).toBe(50000);
  });

  it('gauge node widens max to cover target + band edges when the value is below them', () => {
    // An underperforming higher-is-better KPI: value(25000) is BELOW both the target and the top
    // finite band edge(40000). If max keyed on value alone (gaugeMax(25000)=30000) the watching/ok
    // zones above 30000 would collapse to zero width. The rule maxInput = max(value, target,
    // lastFiniteBandTo) = 40000 keeps every zone visible → gaugeMax(40000) = 40000.
    const under: ChartData = { categories: [], series: [{ name: 'On-Hand Inventory', data: [25000] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'On-Hand Inventory',
        target: 40000, bands: [{ to: 30000, kind: 'warning' }, { to: 40000, kind: 'watching' }, { to: Infinity, kind: 'ok' }] } };
    const p = plan(under, 'solidgauge') as any;
    expect(p.value).toBe(25000);
    expect(p.max).toBe(gaugeMax(40000)); // widened past value to the target/band edge …
    expect(p.max).toBe(40000);           // … not gaugeMax(25000) = 30000, which would clip the top zones
  });

  it('gauge node without thresholds is byte-identical to today (no bands/target keys)', () => {
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    const p = plan(scalar, 'solidgauge') as any;
    expect(p.max).toBe(gaugeMax(42)); // 50 — unchanged: maxInput = max(42, 0, 0) = 42
    expect('bands' in p).toBe(false);
    expect('target' in p).toBe(false);
  });

  it('gauge node with a target but no bands carries the target only (no bands key)', () => {
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }],
      meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count', target: 40 } };
    const p = plan(scalar, 'solidgauge') as any;
    expect(p.target).toBe(40);
    expect('bands' in p).toBe(false);
    expect(p.max).toBe(gaugeMax(42)); // maxInput = max(42, 40, 0) = 42
  });

  it('a PERCENTAGE gauge node caps max at 100 and carries percent:true (never gaugeMax, which would give 90 for 85)', () => {
    const pct: ChartData = { categories: [], series: [{ name: 'Fill', data: [85] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Fill Rate', unit: 'percent' } };
    const p = plan(pct, 'solidgauge') as any;
    expect(p.kind).toBe('gauge');
    expect(p.percent).toBe(true);
    expect(p.max).toBe(100);          // NOT gaugeMax(85) === 90
    expect(p.value).toBe(85);
  });

  it('a PERCENTAGE gauge node keeps max at 100 even when the value exceeds 100 (C-SPEC-01 — clamp is the renderer\'s job)', () => {
    const over: ChartData = { categories: [], series: [{ name: 'Fill', data: [120] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Fill Rate', unit: 'percent' } };
    const p = plan(over, 'solidgauge') as any;
    expect(p.max).toBe(100);
    expect(p.value).toBe(120);        // the true value survives; the renderer clamps the ARC, not the number
  });

  it('a RAW gauge node is byte-identical to today (percent absent, gaugeMax max)', () => {
    const raw: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    const p = plan(raw, 'solidgauge') as any;
    expect(p.percent).toBeUndefined();
    expect(p.max).toBe(gaugeMax(42));
  });

  it('matrix node carries row-major triples with nulls preserved; visualMap bounds span the finite extent; guard is >=2 series', () => {
    const twoSeries: ChartData = { categories: ['Q1', 'Q2'], series: [{ name: 'Plan', data: [10, 20] }, { name: 'Actual', data: [8, 22] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Amount', categoryLabel: 'Quarter' } };
    expect(planFamilyOf('heatmap')).toBe('matrix');
    const p = plan(twoSeries, 'heatmap') as any;
    expect(p.kind).toBe('matrix');
    expect(p.xCategories).toEqual(['Q1', 'Q2']);
    expect(p.yCategories).toEqual(['Plan', 'Actual']);
    expect(p.triples).toEqual([[0, 0, 10], [1, 0, 20], [0, 1, 8], [1, 1, 22]]);
    expect(p.minValue).toBe(8);   // real data floor (matches HC's auto-scaling colorAxis), not 0
    expect(p.maxValue).toBe(22);
    // nulls are ignored for the bounds AND preserved as gaps in triples.
    const sparse: ChartData = { categories: ['Closed', 'Open'], series: [{ name: 'Late', data: [12, null] }, { name: 'Unknown', data: [null, 5] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };
    const sp = plan(sparse, 'heatmap') as any;
    expect(sp.triples).toEqual([[0, 0, 12], [1, 0, null], [0, 1, null], [1, 1, 5]]);
    expect(sp.minValue).toBe(5);
    expect(sp.maxValue).toBe(12);
    // C-PLAN-02: a negative matrix is reachable (capabilityFor pushes heatmap on n>=2, no !neg guard).
    // Bounds must span the real negative extent, NOT floor at 0 (which would mis-colour + degenerate).
    const negMatrix: ChartData = { categories: ['A', 'B'], series: [{ name: 'X', data: [-4, -1] }, { name: 'Y', data: [-9, -2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    const nm = plan(negMatrix, 'heatmap') as any;
    expect(nm.minValue).toBe(-9);
    expect(nm.maxValue).toBe(-1);   // NOT 0 — an all-negative matrix keeps a non-degenerate span
    const oneSeries: ChartData = { ...twoSeries, series: [{ name: 'Plan', data: [10, 20] }] };
    expect(() => plan(oneSeries, 'heatmap')).toThrow(BuilderRejection);
  });

  it('radar node carries categories + indicatorMax + series; guard is >=3 categories', () => {
    const negCats: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Delta', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
    expect(planFamilyOf('radar')).toBe('radar');
    const p = plan(negCats, 'radar') as any;
    expect(p.kind).toBe('radar');
    expect(p.categories).toEqual(['A', 'B', 'C']);
    expect(p.indicatorMax).toBe(6);
    expect(p.series).toEqual([{ name: 'Delta', data: [4, -2, 6] }]);
    const twoCats: ChartData = { ...negCats, categories: ['A', 'B'], series: [{ name: 'Delta', data: [4, 6] }] };
    expect(() => plan(twoCats, 'radar')).toThrow(BuilderRejection);
  });

  it('paired node carries {low,high} points + names; nulls preserved; guard is exactly 2 series', () => {
    const twoSeries: ChartData = { categories: ['Q1', 'Q2'], series: [{ name: 'Plan', data: [10, 20] }, { name: 'Actual', data: [8, 22] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Amount', categoryLabel: 'Quarter' } };
    expect(planFamilyOf('dumbbell')).toBe('paired');
    const p = plan(twoSeries, 'dumbbell') as any;
    expect(p.kind).toBe('paired');
    expect(p.points).toEqual([{ name: 'Q1', low: 10, high: 8 }, { name: 'Q2', low: 20, high: 22 }]);
    expect(p.lowName).toBe('Plan');
    expect(p.highName).toBe('Actual');
    const sparse: ChartData = { categories: ['Closed', 'Open'], series: [{ name: 'Late', data: [12, null] }, { name: 'Unknown', data: [null, 5] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };
    expect((plan(sparse, 'dumbbell') as any).points).toEqual([{ name: 'Closed', low: 12, high: null }, { name: 'Open', low: null, high: 5 }]);
    expect(() => plan({ ...twoSeries, series: [{ name: 'Plan', data: [10, 20] }] }, 'dumbbell')).toThrow(BuilderRejection);
  });

  it('bulletValue node carries value+target+accumulated bands (Infinity kept); guard needs value+target+bands', () => {
    const bulletData: ChartData = { categories: [], series: [{ name: 'Late', data: [7] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Late Orders', target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' }] } };
    expect(planFamilyOf('bullet')).toBe('bulletValue');
    const p = plan(bulletData, 'bullet') as any;
    expect(p.kind).toBe('bulletValue');
    expect(p.value).toBe(7);
    expect(p.target).toBe(5);
    expect(p.seriesName).toBe('Late');
    expect(p.bands).toEqual([
      { from: 0, to: 5, color: BAND_COLORS.ok },
      { from: 5, to: 10, color: BAND_COLORS.watching },
      { from: 10, to: Infinity, color: BAND_COLORS.warning },
    ]);
    const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
    expect(() => plan(scalar, 'bullet')).toThrow(BuilderRejection); // no target/bands
  });

  it('composition plan carries {name, value} points with nulls preserved', () => {
    const p = plan({ ...oneSeries, series: [{ name: 'Count', data: [360, null] }] }, 'pie') as any;
    expect(p.kind).toBe('composition');
    expect(p.points).toEqual([{ name: 'Normal', value: 360 }, { name: 'AboveMaximum', value: null }]);
  });

  it('hierarchy node: flat treemap keeps 1 level; nested treemap + sunburst carry rowNodes + leaves', () => {
    expect(planFamilyOf('treemap')).toBe('hierarchy');
    expect(planFamilyOf('sunburst')).toBe('hierarchy');
    const flat = plan(oneSeries, 'treemap') as any;
    expect(flat.kind).toBe('hierarchy');
    expect(flat.nested).toBe(false);
    expect(flat.flatPoints).toEqual([{ name: 'Normal', value: 360 }, { name: 'AboveMaximum', value: 165 }]);
    const nested = plan(seriesData, 'sunburst') as any;
    expect(nested.nested).toBe(true);
    expect(nested.rowNodes).toEqual([{ id: 'North', name: 'North', parent: '' }, { id: 'South', name: 'South', parent: '' }]);
    expect(nested.leaves).toEqual([
      { name: '2024', parent: 'North', value: 10 }, { name: '2025', parent: 'North', value: 12 },
      { name: '2024', parent: 'South', value: 20 }, { name: '2025', parent: 'South', value: 18 },
    ]);
    expect(() => plan(negSeries, 'sunburst')).toThrow(BuilderRejection); // nested + negative
  });

  it('stacked plan carries stackingMode + areaNotColumn + series, and rejects a truncated 100% stack', () => {
    const p = plan(seriesData, 'stackedColumn') as any;
    expect(p.kind).toBe('stacked');
    expect(p.stackingMode).toBe('normal');
    expect(p.areaNotColumn).toBe(false);
    expect(p.series).toEqual([{ name: '2024', data: [10, 20] }, { name: '2025', data: [12, 18] }]);
    expect(() => plan({ ...seriesData, meta: { ...seriesData.meta, seriesTruncated: true } }, 'stackedColumn100'))
      .toThrow(BuilderRejection);
  });

  it('assertStackable throws on no second dimension or any negative, passes on homogeneous non-negative', () => {
    expect(() => assertStackable(oneSeries)).toThrow(BuilderRejection);   // no seriesDimensionName
    expect(() => assertStackable(negSeries)).toThrow(BuilderRejection);   // has a negative
    expect(() => assertStackable(seriesData)).not.toThrow();
  });

  it('plan() throws for a non-built family (there is no neutral node for it this round)', () => {
    expect(() => plan(oneSeries, 'dumbbell')).toThrow();
  });
});

describe('bubble — new IR node (two value axes, sized dots)', () => {
  const bubbleData: ChartData = {
    categories: ['A', 'B', 'C'],
    series: [
      { name: 'Lead Time', data: [3, 6, 9] },
      { name: 'Fill Rate', data: [90, 80, 70] },
      { name: 'Count', data: [100, 50, null] },
    ],
    points: [
      { x: 3, y: 90, size: 100, label: 'A' },
      { x: 6, y: 80, size: 50, label: 'B' },
      { x: 9, y: 70, size: null, label: 'C' },
    ],
    meta: { truncated: false, shown: 3, dimensionKind: 'categorical' },
  };

  it('capabilityFor offers bubble iff points are present (not merely two series)', () => {
    expect(capabilityFor(bubbleData)).toContain('bubble');
    const noPoints: ChartData = { ...bubbleData, points: undefined };
    expect(capabilityFor(noPoints)).not.toContain('bubble');
    const empty: ChartData = { ...bubbleData, points: [] };
    expect(capabilityFor(empty)).not.toContain('bubble');
  });

  it('plan(bubble) emits a kind:bubble node with axis labels from the three series and the raw points + finite size extent', () => {
    const p = plan(bubbleData, 'bubble') as any;
    expect(p.kind).toBe('bubble');
    expect(p.xLabel).toBe('Lead Time');
    expect(p.yLabel).toBe('Fill Rate');
    expect(p.sizeLabel).toBe('Count');
    expect(p.minSize).toBe(50);   // finite extent over non-null sizes {100,50}
    expect(p.maxSize).toBe(100);
    expect(p.palette).toEqual(PALETTE);
    expect(p.points).toEqual([
      { x: 3, y: 90, size: 100, label: 'A' },
      { x: 6, y: 80, size: 50, label: 'B' },
      { x: 9, y: 70, size: null, label: 'C' },
    ]);
  });

  it('plan(bubble) throws BuilderRejection when points are absent (defense in depth)', () => {
    const noPoints: ChartData = { ...bubbleData, points: undefined };
    expect(() => plan(noPoints, 'bubble')).toThrow(BuilderRejection);
  });

  it('planFamilyOf maps bubble to its own family', () => {
    expect(planFamilyOf('bubble')).toBe('bubble');
  });
});

describe('funnel — composition family with a source discriminator', () => {
  const comp: ChartData = { categories: ['Visited', 'Added', 'Bought'], series: [{ name: 'Users', data: [1000, 400, 120] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };

  it('capabilityFor offers funnel under the one-non-negative-series gate', () => {
    expect(capabilityFor(comp)).toContain('funnel');
    const neg: ChartData = { ...comp, series: [{ name: 'Users', data: [1000, -5, 120] }] };
    expect(capabilityFor(neg)).not.toContain('funnel');
  });

  it('plan(funnel) emits kind:composition, source:funnel, defaults sort to value', () => {
    const p = plan(comp, 'funnel') as any;
    expect(p.kind).toBe('composition');
    expect(p.source).toBe('funnel');
    expect(p.sort).toBe('value');
    expect(p.points).toEqual([{ name: 'Visited', value: 1000 }, { name: 'Added', value: 400 }, { name: 'Bought', value: 120 }]);
  });

  it('plan(funnel, {funnelSort:"source"}) preserves the source order', () => {
    const p = plan(comp, 'funnel', { funnelSort: 'source' }) as any;
    expect(p.sort).toBe('source');
  });

  it('plan(pie) is unchanged — source:pie, no sort', () => {
    const p = plan(comp, 'pie') as any;
    expect(p.source).toBe('pie');
    expect(p.sort).toBeUndefined();
  });
});

describe('bubbleHeatmap — matrix node with a render discriminator', () => {
  const grid: ChartData = { categories: ['A', 'B'], series: [{ name: 'North', data: [1, 4] }, { name: 'South', data: [9, 16] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Region' } };
  const negGrid: ChartData = { ...grid, series: [{ name: 'North', data: [1, -4] }, { name: 'South', data: [9, 16] }] };

  it('offers bubbleHeatmap for >=2 non-negative series, and NOT when a value is negative', () => {
    expect(capabilityFor(grid)).toContain('bubbleHeatmap');
    expect(capabilityFor(negGrid)).not.toContain('bubbleHeatmap');
    expect(capabilityFor(negGrid)).toContain('heatmap'); // heatmap still tolerates negatives
  });
  it('plan(bubbleHeatmap) marks render:bubbles and zero-anchors minValue', () => {
    const p = plan(grid, 'bubbleHeatmap') as any;
    expect(p.kind).toBe('matrix');
    expect(p.render).toBe('bubbles');
    expect(p.minValue).toBe(0);
    expect(p.maxValue).toBe(16);
  });
  it('plan(heatmap) stays render:cells with its data-driven min', () => {
    const p = plan(grid, 'heatmap') as any;
    expect(p.render).toBe('cells');
    expect(p.minValue).toBe(1); // unchanged: real data extent
  });
});

describe('chart-plan — flow family (Sankey)', () => {
  // A clean disjoint matrix (the demo shape): 2 sources × 2 homogeneous non-negative targets.
  const flowData: ChartData = {
    categories: ['USA', 'DEU'],
    series: [{ name: 'Closed', data: [170, 31] }, { name: 'Open', data: [10, 3] }],
    meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Order Status', valueLabel: 'Total Order Value', categoryLabel: 'Customer Country', seriesShown: 2, seriesTotal: 2, seriesTruncated: false },
  };

  it('planFamilyOf maps sankey to flow', () => {
    expect(planFamilyOf('sankey')).toBe('flow');
  });

  it('capabilityFor OFFERS sankey for a >=2-category x >=2-homogeneous-non-negative-series matrix', () => {
    expect(capabilityFor(flowData)).toContain('sankey');
  });

  it('capabilityFor does NOT offer sankey for the wrong shapes', () => {
    expect(capabilityFor(oneSeries)).not.toContain('sankey');                 // single series
    const oneCat: ChartData = { ...flowData, categories: ['USA'], series: [{ name: 'Closed', data: [170] }, { name: 'Open', data: [10] }] };
    expect(capabilityFor(oneCat)).not.toContain('sankey');                    // 1xN single source (Q3)
    expect(capabilityFor(negSeries)).not.toContain('sankey');                 // a negative cell
    const empty: ChartData = { categories: [], series: [], meta: { truncated: false, shown: 0, dimensionKind: 'categorical' } };
    expect(capabilityFor(empty)).not.toContain('sankey');                     // empty query
  });

  it('plan(flow) reshapes the matrix into nodes (source-then-target) and one link per non-null cell', () => {
    const p = plan(flowData, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>;
    expect(p.kind).toBe('flow');
    expect(p.nodes.map((n) => n.name)).toEqual(['USA', 'DEU', 'Closed', 'Open']);
    expect(p.links).toEqual([
      { source: 'USA', target: 'Closed', value: 170 },
      { source: 'USA', target: 'Open', value: 10 },
      { source: 'DEU', target: 'Closed', value: 31 },
      { source: 'DEU', target: 'Open', value: 3 },
    ]);
    expect(p.valueLabel).toBe('Total Order Value');
    expect(p.palette).toEqual(PALETTE);
  });

  it('a null cell yields NO link and drops an all-null node; a real 0 cell IS a link', () => {
    const sparse: ChartData = {
      ...flowData,
      categories: ['USA', 'DEU', 'GBR'],
      series: [{ name: 'Closed', data: [170, 0, null] }, { name: 'Open', data: [10, null, null] }],
    };
    const p = plan(sparse, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>;
    expect(p.links).toEqual([
      { source: 'USA', target: 'Closed', value: 170 },
      { source: 'USA', target: 'Open', value: 10 },
      { source: 'DEU', target: 'Closed', value: 0 },  // a genuine 0 is data, not a gap
    ]);
    expect(p.nodes.map((n) => n.name)).toEqual(['USA', 'DEU', 'Closed', 'Open']); // GBR (all-null) dropped
  });

  it('node names: disjoint source/target sets keep BARE member names', () => {
    const p = plan(flowData, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>;
    expect(p.nodes.map((n) => n.name)).toEqual(['USA', 'DEU', 'Closed', 'Open']);
  });

  it('node names: a member on BOTH sides with DISTINCT axis labels suffixes both sides; others stay bare', () => {
    const collide: ChartData = {
      categories: ['North', 'South'],
      series: [{ name: 'North', data: [1, 2] }, { name: 'East', data: [3, 4] }],
      meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Destination', categoryLabel: 'Origin', valueLabel: 'Trips' },
    };
    const p = plan(collide, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>;
    expect(p.nodes.map((n) => n.name)).toEqual(['North (Origin)', 'South', 'North (Destination)', 'East']);
    expect(p.links).toContainEqual({ source: 'North (Origin)', target: 'North (Destination)', value: 1 });
    expect(new Set(p.nodes.map((n) => n.name)).size).toBe(p.nodes.length); // all unique
  });

  it('node names: a collision where BOTH axes carry the SAME label falls back to positional words', () => {
    const sameLabel: ChartData = {
      categories: ['North', 'South'],
      series: [{ name: 'North', data: [1, 2] }, { name: 'East', data: [3, 4] }],
      meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Region', categoryLabel: 'Region', valueLabel: 'Trips' },
    };
    const p = plan(sameLabel, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>;
    expect(p.nodes.map((n) => n.name)).toEqual(['North (source)', 'South', 'North (target)', 'East']);
    expect(new Set(p.nodes.map((n) => n.name)).size).toBe(p.nodes.length);
  });

  it('title names BOTH axes and never contains the word "flow"', () => {
    const p = plan(flowData, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>;
    expect(p.title).toBe('Total Order Value by Customer Country and Order Status');
    expect(p.title.toLowerCase()).not.toContain('flow');
  });

  it('subtitle discloses BOTH truncations: source-only, target-only, both, and none', () => {
    const srcOnly: ChartData = { ...flowData, meta: { ...flowData.meta, truncated: true, shown: 5, total: 12 } };
    expect((plan(srcOnly, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>).subtitle)
      .toEqual({ text: 'Showing top 5 of 12 sources' });

    const tgtOnly: ChartData = { ...flowData, meta: { ...flowData.meta, seriesTruncated: true, seriesShown: 8, seriesTotal: 20 } };
    expect((plan(tgtOnly, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>).subtitle)
      .toEqual({ text: 'Showing top 8 of 20 targets' });

    const both: ChartData = { ...flowData, meta: { ...flowData.meta, truncated: true, shown: 5, total: 12, seriesTruncated: true, seriesShown: 8, seriesTotal: 20 } };
    expect((plan(both, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>).subtitle)
      .toEqual({ text: 'Showing top 5 of 12 sources and top 8 of 20 targets' });

    expect((plan(flowData, 'sankey') as Extract<ChartPlan, { kind: 'flow' }>).subtitle).toBeUndefined();
  });

  it('plan(sankey) rejects the untruthful shapes with distinct messages', () => {
    expect(() => plan(oneSeries, 'sankey')).toThrow(/second dimension of homogeneous series/);
    expect(() => plan(negSeries, 'sankey')).toThrow(/cannot show negative values/);
    const oneCat: ChartData = { ...flowData, categories: ['USA'], series: [{ name: 'Closed', data: [170] }, { name: 'Open', data: [10] }] };
    expect(() => plan(oneCat, 'sankey')).toThrow(/at least two source categories/);
    expect(() => plan(oneSeries, 'sankey')).toThrow(BuilderRejection);
  });
});
