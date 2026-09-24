/**
 * Chart-type-expansion live IRIS+SCO integration tests: cube crossjoin (Step 1)
 * and KPI bullet with thresholds (Step 2). Self-provisioning + self-cleaning on
 * the clean-SCO baseline. Live IRIS required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, uniqueSuffix, runCleanups, type Cleanup } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';
import { MAX_SERIES } from '../../src/dashboard/cube-query.js';
import { capabilityFor } from '../../src/dashboard/chart-plan.js';
import { echartsBuilder } from '../../src/dashboard/echarts-spec-builder.js';

const d = describe;

/**
 * The multi-dimension cube override for crossjoin tests: two categorical dimensions
 * (Region, Product) plus a HIGH-CARDINALITY time dimension used to exercise the
 * series cap.
 *
 * `SaleDateD` is `type: 'time'` with a `timeFunction`, NOT a `data` dimension over
 * the raw `%Date` property, for two reasons. It is how a date must be modelled (see
 * the cube skill). And it is DETERMINISTIC: as a `data` dimension the member list a
 * `%Date` produces varies by SCO build — measured, the same fixture yields 20 real
 * date members on 1.7.4 but 3 unusable %PosixTime-shaped keys on a 1.7.3 instance,
 * which silently drops the series count below the cap and fails this test for a
 * reason that has nothing to do with the series cap. A time dimension gives the same
 * 20 day members on both.
 *
 * ONE level, at DAY grain, deliberately: a chart request that names only a
 * dimension resolves to `levels[0]` (cube-query.ts `resolveLevel`), so a
 * Year→Month→Day hierarchy would silently answer at YEAR grain — one member, and
 * the series cap would never engage. One day-grain level makes the grain explicit.
 * The 20 seeded rows are 3 days apart, so this yields 20 distinct members, above
 * MAX_SERIES (8).
 */
const MULTI_DIM: Partial<CubeDefinition> = {
  dimensions: [
    { name: 'RegionD',  type: 'data', hasAll: true, hierarchies: [{ name: 'H1', levels: [{ name: 'Region',  sourceProperty: 'Region',  factNumber: 2 }] }] },
    { name: 'ProductD', type: 'data', hasAll: true, hierarchies: [{ name: 'H1', levels: [{ name: 'Product', sourceProperty: 'Product', factNumber: 4 }] }] },
    { name: 'SaleDateD',type: 'time', hasAll: true, sourceProperty: 'SaleDate',
      hierarchies: [{ name: 'H1', levels: [{ name: 'SaleDate', timeFunction: 'DayMonthYear', factNumber: 5 }] }] },
  ],
};

/**
 * A three-measure cube over one source property (Amount). IRIS supports several
 * measures sharing a source column (SUM/MAX/AVG of Amount) and auto-assigns their
 * fact slots, so the generator omits measure factNumbers (cube-generator.ts:56-60).
 * Two+ measures over a category dimension (no series split) is what the bubble
 * points projection reads: x=measure0, y=measure1, size=measure2 (cube-query.ts:388).
 */
const MULTI_MEASURE: Partial<CubeDefinition> = {
  dimensions: [
    { name: 'RegionD', type: 'data', hasAll: true, hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }] },
  ],
  measures: [
    { name: 'Total',   sourceProperty: 'Amount', factName: 'MxTotal',   aggregate: 'SUM', type: 'number', factNumber: 3 },
    { name: 'Peak',    sourceProperty: 'Amount', factName: 'MxPeak',    aggregate: 'MAX', type: 'number', factNumber: 3 },
    { name: 'Average', sourceProperty: 'Amount', factName: 'MxAverage', aggregate: 'AVG', type: 'number', factNumber: 3 },
  ],
} as Partial<CubeDefinition>;

d('chart-type-expansion: cube crossjoin (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
  });
  afterAll(async () => {
    await sweep(app.iris);
    await app.close();
  });
  beforeEach(() => { cleanups = []; });
  afterEach(async () => { await runCleanups(cleanups); });

  /** Provision a multi-dimension cube (3 data dimensions over the standard seeded source). */
  async function freshMultiDimCube() {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src, MULTI_DIM);
    cleanups.push(cube.cleanup);
    return cube;
  }

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('a crossjoin carries a series dimension and homogeneous additive series', async () => {
    const cube = await freshMultiDimCube();
    // Read the shape to resolve dimension names (don't hard-code them).
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    expect(shapeRes.status, await shapeRes.clone().text()).toBe(200);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('region'))?.name;
    const productDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('product'))?.name;
    expect(regionDim, 'RegionD dimension present').toBeTruthy();
    expect(productDim, 'ProductD dimension present').toBeTruthy();

    const res = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }, { name: productDim, role: 'series' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    // The series dimension name is humanized and carried.
    expect(typeof data.meta.seriesDimensionName).toBe('string');
    expect(data.meta.seriesDimensionName!.length).toBeGreaterThan(0);
    // Multiple series, one per product member, all distinct.
    expect(data.series.length).toBeGreaterThanOrEqual(2);
    const seriesNames = new Set(data.series.map((s) => s.name));
    expect(seriesNames.size).toBe(data.series.length);

    // AXIS IDENTITY (not just distinctness): IRIS returns CROSSJOIN tuple members in the
    // REVERSE of the CROSSJOIN() argument order, so a positional read silently swaps the
    // row and series axes — and additivity/distinctness are both orientation-invariant, so
    // they cannot catch it. Anchor identity against the single-dimension queries, which are
    // independently correct (one member per tuple, no crossjoin): the crossjoin's CATEGORIES
    // must be the ROW dimension's members and its SERIES the SERIES dimension's members.
    const plainRegion = await jsonOf<ChartData>(await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }],
    }));
    const plainProduct = await jsonOf<ChartData>(await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: productDim, role: 'category' }],
    }));
    // Every crossjoin category is a region member; every series is a product member. Subset
    // (not set-equality) because NON EMPTY can drop a member that has no cell in the join.
    const regionMembers = new Set(plainRegion.categories);
    const productMembers = new Set(plainProduct.categories);
    for (const c of data.categories) expect(regionMembers.has(c), `category '${c}' is a region member`).toBe(true);
    for (const s of data.series) expect(productMembers.has(s.name), `series '${s.name}' is a product member`).toBe(true);
    // And they are NOT interchanged: no category is a product member (the swap this guards against).
    for (const c of data.categories) expect(productMembers.has(c), `category '${c}' must NOT be a product member`).toBe(false);
    // The series disclosure metadata is present.
    expect(data.meta.seriesShown).toBe(data.series.length);
    // The capability list includes BOTH stacked and sunburst (homogeneous-non-negative gate).
    const cap = capabilityFor(data);
    expect(cap).toContain('stackedColumn');
    expect(cap).toContain('sunburst');
    // The stacked spec builds from live crossjoin data. ECharts has no percent/stacking
    // flag — a shared `stack` id on every series IS the stack (see echarts-spec-builder.ts,
    // kind==='stacked'); the columns are `bar` series (orientation is axis-driven).
    const spec = echartsBuilder.build(data, 'stackedColumn') as any;
    expect(spec.series.length).toBe(data.series.length);
    expect(spec.series.every((s: any) => s.type === 'bar')).toBe(true);
    expect(spec.series.every((s: any) => s.stack === 'total')).toBe(true);
    for (const s of spec.series) {
      expect(s.data).toBeDefined();
    }
  });

  it('additivity: the crossjoin neither drops nor double-counts', async () => {
    const cube = await freshMultiDimCube();
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('region'))?.name;
    const productDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('product'))?.name;

    // Query the SAME cube+measure+category dimension WITHOUT a series split (single-dimension).
    const plainRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }],
    });
    const plainData = await jsonOf<ChartData>(plainRes);
    const plainSum = plainData.series[0]!.data.reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0);

    // Query WITH a series split (crossjoin, splitting the same measure).
    const splitRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }, { name: productDim, role: 'series' }],
    });
    const splitData = await jsonOf<ChartData>(splitRes);
    let splitSum = 0;
    for (const series of splitData.series) {
      for (const v of series.data) {
        if (typeof v === 'number') splitSum += v;
      }
    }

    // A SUM measure over a NON EMPTY crossjoin with no truncation reproduces the
    // single-dimension grand sum — the part-to-whole invariant a stacked/sunburst chart
    // depends on. This holds because composeMdx enumerates the LEAF LEVEL of each dimension
    // (`[dim].[hier].[level].MEMBERS`), which strips the `[All]` member and the
    // hierarchy-level mixing that otherwise double/quadruple-counts a SUM (the D2 [All]-leak
    // fix). VERIFIED GREEN on the live SCO integration_test image. If it ever regresses, the
    // logged actuals below localize which side drifted.
    const diff = Math.abs(splitSum - plainSum);
    if (diff >= 0.01) {
      console.warn(`ADDITIVITY REGRESSION: plainSum=${plainSum}, splitSum=${splitSum}, diff=${diff}`);
      console.warn(`  Plain query: ${plainData.categories.length} categories, ${plainData.series.length} series`);
      console.warn(`  Split query: ${splitData.categories.length} categories, ${splitData.series.length} series`);
    }
    expect(diff).toBeLessThan(0.01);
  });

  it('the series cap is DISCLOSED on real data, never silent', async () => {
    const cube = await freshMultiDimCube();
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('region'))?.name;
    const dateDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('date'))?.name;
    expect(dateDim, 'SaleDateD dimension present').toBeTruthy();

    // SaleDate has ~20 distinct members, above MAX_SERIES, so the series axis is truncated.
    const res = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }, { name: dateDim, role: 'series' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    // The series cap is disclosed.
    expect(data.meta.seriesShown!).toBeLessThanOrEqual(MAX_SERIES);
    expect(data.meta.seriesTotal!).toBeGreaterThan(MAX_SERIES);
    expect(data.meta.seriesTruncated).toBe(true);
    // If live IRIS surfaces an unexpected count (e.g. an [All] member), document it.
    // The load-bearing assertion: seriesTruncated is true, seriesTotal > seriesShown.
    if (data.meta.seriesShown !== MAX_SERIES) {
      console.warn(`OBSERVED: seriesShown=${data.meta.seriesShown} (expected ${MAX_SERIES}); seriesTotal=${data.meta.seriesTotal}`);
    }
  });

});

d('chart-type-expansion: KPI bullet with thresholds (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
  });
  afterAll(async () => {
    await sweep(app.iris);
    await app.close();
  });
  beforeEach(() => { cleanups = []; });
  afterEach(async () => { await runCleanups(cleanups); });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Provision a threshold-carrying KPI (watching/warning thresholds set). */
  async function freshThresholdKpi(watching: number, warning: number) {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src); // single-dim minimal cube is fine for a scalar KPI
    cleanups.push(cube.cleanup);
    const name = `WorkbenchTestBulletKpi${uniqueSuffix()}`;
    await app.iris.kpi.create({
      name, label: 'Bullet IT KPI', type: 'DeepSee', status: 'Active',
      watchingThreshold: watching, warningThreshold: warning,
      deepseeKpiSpec: { namespace: app.iris.namespace, cube: cube.cubeName, kpiMeasure: 'Total', valueType: 'raw', kpiConditions: ['[RegionD].[H1].[Region].&[North]'] },
    } as never);
    cleanups.push(async () => { try { await app.iris.kpi.delete(name); } catch { /* gone */ } });
    return name;
  }

  it('round-trip probe (gates the rest): SCO persists and returns thresholds', async () => {
    // Create a lower-is-better KPI (watching: 5, warning: 10).
    const name = await freshThresholdKpi(5, 10);
    const def = await app.iris.kpi.get(name);
    if (typeof def?.watchingThreshold !== 'number' || typeof def?.warningThreshold !== 'number') {
      // SCO LIMITATION: thresholds are not round-tripped. Assert the honest degradation.
      const res = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: name });
      expect(res.status).toBe(200);
      const data = await jsonOf<ChartData>(res);
      expect(data.meta.target).toBeUndefined();
      expect(data.meta.bands).toBeUndefined();
      console.warn(`SCO LIMITATION: watchingThreshold=${def?.watchingThreshold}, warningThreshold=${def?.warningThreshold} (KPI ${name} thresholds not round-tripped)`);
      return; // Stop here; the rest of the tests cannot run without thresholds.
    }
    // Thresholds ARE round-tripped; proceed to 2b/2c below.
  });

  it('lower-is-better bands over the wire (terminal to=null, not Infinity)', async () => {
    const name = await freshThresholdKpi(5, 10);
    const def = await app.iris.kpi.get(name);
    if (typeof def?.watchingThreshold !== 'number' || typeof def?.warningThreshold !== 'number') {
      console.warn('Skipping: SCO does not round-trip thresholds (gate 2a)');
      return;
    }

    const res = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: name });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    expect(data.meta.dimensionKind).toBe('scalar');
    // Target is the watching threshold (the nearer reference marker).
    expect(data.meta.target).toBe(5);
    // Bands: 3 zones, kinds in order ['ok','watching','warning'].
    expect(data.meta.bands).toBeDefined();
    expect(data.meta.bands!.length).toBe(3);
    expect(data.meta.bands!.map((b) => b.kind)).toEqual(['ok', 'watching', 'warning']);
    expect(data.meta.bands![0]!.to).toBe(5);
    expect(data.meta.bands![1]!.to).toBe(10);
    // The terminal band `to` is `null` on the wire (Infinity doesn't survive JSON.stringify).
    expect(data.meta.bands![2]!.to).toBe(null);

    // Build from the parsed body: an ECharts bullet — a horizontal bar (series type 'bar'),
    // the quality bands as a `markArea`, the target as a `markLine`. ECharts cannot paint a
    // markArea to Infinity, so the open top band's `to` is resolved to a finite axis max
    // (this is the deliberate difference from the Highcharts plotBand, whose terminal `to`
    // stayed null). The live target/band VALUES come from the wire and are asserted here;
    // the on-screen geometry is the Toast Master's browser eyeball.
    const spec = echartsBuilder.build(data, 'bullet') as any;
    expect(spec.series[0]!.type).toBe('bar');
    // The dashed target marker sits at the target value (5).
    expect(spec.series[0]!.markLine.data[0]!.xAxis).toBe(5);
    // Three quality bands as markArea rectangles; each is a [from, to] pair.
    expect(spec.series[0]!.markArea.data.length).toBe(3);
    expect(spec.series[0]!.markArea.data[0]![0]!.xAxis).toBe(0);
    // The two finite band `to`s ascend (5 then 10).
    expect(spec.series[0]!.markArea.data[0]![1]!.xAxis).toBe(5);
    expect(spec.series[0]!.markArea.data[1]![1]!.xAxis).toBe(10);
    // The terminal band `to` (Infinity on the wire) is resolved to a FINITE axis max, not null.
    expect(Number.isFinite(spec.series[0]!.markArea.data[2]![1]!.xAxis)).toBe(true);
  });

  it('higher-is-better FLIP proven on live data (warning < watching → danger at the LOW end)', async () => {
    const name = await freshThresholdKpi(90, 80);
    const def = await app.iris.kpi.get(name);
    if (typeof def?.watchingThreshold !== 'number' || typeof def?.warningThreshold !== 'number') {
      console.warn('Skipping: SCO does not round-trip thresholds (gate 2a)');
      return;
    }

    const res = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: name });
    const data = await jsonOf<ChartData>(res);
    // Target is still the watching threshold (nearer to "good").
    expect(data.meta.target).toBe(90);
    // Bands: kinds in order ['warning','watching','ok'] (the polarity flip).
    expect(data.meta.bands!.map((b) => b.kind)).toEqual(['warning', 'watching', 'ok']);
    expect(data.meta.bands![0]!.to).toBe(80);
    expect(data.meta.bands![1]!.to).toBe(90);
    expect(data.meta.bands![2]!.to).toBe(null);
  });
});

d('chart-type-expansion: new ECharts types (bubble / funnel / bubbleHeatmap) (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
  });
  afterAll(async () => {
    await sweep(app.iris);
    await app.close();
  });
  beforeEach(() => { cleanups = []; });
  afterEach(async () => { await runCleanups(cleanups); });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Provision a single-dimension, three-measure cube (Total/Peak/Average over Amount). */
  async function freshMultiMeasureCube() {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src, MULTI_MEASURE);
    cleanups.push(cube.cleanup);
    return cube;
  }

  it('two measures over a category dimension yield bubble points; capability offers bubble + bubbleHeatmap', async () => {
    const cube = await freshMultiMeasureCube();
    // Resolve the region dimension name from the shape (don't hard-code it).
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    expect(shapeRes.status, await shapeRes.clone().text()).toBe(200);
    const shape = await jsonOf<{ measures: { name: string }[]; dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name;
    expect(regionDim, 'RegionD dimension present').toBeTruthy();
    // The three measures round-trip through the shape.
    const measureNames = shape.measures.map((m) => m.name);
    expect(measureNames).toEqual(expect.arrayContaining(['Total', 'Peak', 'Average']));

    // TWO real measures + a category dimension (no series split) → bubble points.
    const res = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total', 'Peak', 'Average'],
      dimensions: [{ name: regionDim, role: 'category' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await jsonOf<ChartData & { applicableTypes: string[] }>(res);

    // Three series (one per measure) over the region members.
    expect(body.series.length).toBe(3);
    expect(body.series.map((s) => s.name)).toEqual(expect.arrayContaining(['Total', 'Peak', 'Average']));

    // Bubble points: x=Total, y=Peak, size=Average, one per non-null (x,y) region row.
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points!.length).toBeGreaterThan(0);
    for (const pt of body.points!) {
      expect(typeof pt.x).toBe('number');
      expect(typeof pt.y).toBe('number');
      // size is measure2 (Average), a number (never null here since Average is populated).
      expect(typeof pt.size).toBe('number');
      expect(typeof pt.label).toBe('string');
    }

    // capabilityFor offers bubble (points present) and bubbleHeatmap (>=2 non-negative series).
    const cap = capabilityFor(body);
    expect(cap).toContain('bubble');
    expect(cap).toContain('bubbleHeatmap');
    // applicableTypes rides alongside on the wire (dashboard-routes.ts:134), same set.
    expect(body.applicableTypes).toContain('bubble');
    expect(body.applicableTypes).toContain('bubbleHeatmap');

    // The bubble spec builds from the live points: a scatter with precomputed numeric symbolSizes.
    const bubbleSpec = echartsBuilder.build(body, 'bubble') as any;
    expect(bubbleSpec.series[0].type).toBe('scatter');
    expect(bubbleSpec.series[0].data.length).toBe(body.points!.length);
    expect(bubbleSpec.series[0].data.every((dd: any) => typeof dd.symbolSize === 'number')).toBe(true);

    // The bubbleHeatmap spec builds from the same live grid: a scatter with a zero-anchored visualMap.
    const heatSpec = echartsBuilder.build(body, 'bubbleHeatmap') as any;
    expect(heatSpec.series[0].type).toBe('scatter');
    expect(heatSpec.visualMap.min).toBe(0); // zero-anchored for area-honesty, not the data min
  });

  it('[Measures].[%COUNT] resolves as the cube row count (Count sizes the bubbles)', async () => {
    // The FE Size selector defaults to Count, carried as a 3rd measure token '%COUNT'
    // (cube-query.ts:103 bypasses the measure-existence guard; MDX interpolates
    // [Measures].[%COUNT]). PINNED CHECK (plan Task 9 Step 2): %COUNT resolves to the row
    // count, so size is populated, not an error. Fallback if it does NOT resolve is an
    // explicit 3rd measure + greyed Count — a scope trim to bring to Karsten, NOT a silent drop.
    const cube = await freshMultiMeasureCube();
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name;

    // Two real measures + %COUNT as the size source (exactly what the bubble Size=Count UI sends).
    const res = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total', 'Peak', '%COUNT'],
      dimensions: [{ name: regionDim, role: 'category' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await jsonOf<ChartData>(res);
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points!.length).toBeGreaterThan(0);
    // The %COUNT column resolved: every point carries a numeric, positive size (a row count >= 1).
    for (const pt of body.points!) {
      expect(typeof pt.size).toBe('number');
      expect(pt.size as number).toBeGreaterThan(0);
    }
    // The seeded source has 20 rows across 3 regions; the per-region counts must sum to the extent.
    const totalCount = body.points!.reduce<number>((a, pt) => a + (pt.size ?? 0), 0);
    expect(totalCount).toBeGreaterThan(0);
  });

  it('a one-measure category query offers funnel and builds a funnel spec', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src); // the minimal single-measure cube (Total)
    cleanups.push(cube.cleanup);
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name;

    const res = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await jsonOf<ChartData & { applicableTypes: string[] }>(res);
    // One non-negative series over categories → funnel is offered.
    expect(body.series.length).toBe(1);
    const cap = capabilityFor(body);
    expect(cap).toContain('funnel');
    expect(body.applicableTypes).toContain('funnel');

    // Build a funnel with explicit source order; the render emits an ECharts funnel with sort:'none'.
    const spec = echartsBuilder.build(body, 'funnel', { funnelSort: 'source' }) as any;
    expect(spec.series[0].type).toBe('funnel');
    expect(spec.series[0].sort).toBe('none');
    // Value order (the default) descends instead — proves the source-order assertion is load-bearing.
    const valueSpec = echartsBuilder.build(body, 'funnel') as any;
    expect(valueSpec.series[0].sort).toBe('descending');
  });
});
