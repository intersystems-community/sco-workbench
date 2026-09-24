/**
 * E2E — the chart-type-expansion flows through the mounted app: series-dimension
 * picker → cube crossjoin → stacked render (Step 3a), and KPI (with thresholds) →
 * bullet render (Step 3b). Drives the three-layer charting pipeline end-to-end to
 * catch a proxy-prefix or router-wiring regression the unit/integration tiers cannot.
 * Live IRIS required; run via: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import { seedSource, buildTestCube, uniqueSuffix, runCleanups, type Cleanup } from '../integration/helpers/provision.js';
import { sweep, healCubeRegistry } from '../integration/helpers/sweep.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

const d = describe;

/** The multi-dimension cube override for crossjoin tests (3 data dimensions). */
const MULTI_DIM: Partial<CubeDefinition> = {
  dimensions: [
    { name: 'RegionD',  type: 'data', hasAll: true, hierarchies: [{ name: 'H1', levels: [{ name: 'Region',  sourceProperty: 'Region',  factNumber: 2 }] }] },
    { name: 'ProductD', type: 'data', hasAll: true, hierarchies: [{ name: 'H1', levels: [{ name: 'Product', sourceProperty: 'Product', factNumber: 4 }] }] },
    { name: 'SaleDateD',type: 'data', hasAll: true, hierarchies: [{ name: 'H1', levels: [{ name: 'SaleDate',sourceProperty: 'SaleDate',factNumber: 5 }] }] },
  ],
};

/** A single-dimension, three-measure cube (Total/Peak/Average over Amount) — the bubble source. */
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

interface SpecResp {
  spec: Record<string, unknown>;
  type: string;
  layer: '1a' | '1b' | '2';
  source?: string;
  fallback?: boolean;
}

d('E2E: series-dimension picker → cube crossjoin → stacked render', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
    cleanups = [];
  });
  afterAll(async () => {
    await runCleanups(cleanups);
    await sweep(app.iris);
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('drives shape → chart-data (crossjoin) → chart-spec and gets stacked column', async () => {
    // Build a multi-dim cube over a seeded source (20 rows: regions North/South/East, products Widget/Gadget/Gizmo/Doohickey).
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src, MULTI_DIM);
    cleanups.push(cube.cleanup);

    // 1. Shape: read the cube dimensions (don't hard-code names).
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    expect(shapeRes.status, await shapeRes.clone().text()).toBe(200);
    const shape = await jsonOf<{ measures: { name: string }[]; dimensions: { name: string }[] }>(shapeRes);
    const measure = shape.measures.find((m) => m.name === 'Total')?.name ?? shape.measures[0]!.name;
    const regionDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name;
    const productDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('product'))?.name;
    expect(regionDim, 'RegionD dimension present').toBeTruthy();
    expect(productDim, 'ProductD dimension present').toBeTruthy();

    // 2. Data: the IRIS read with a series split, producing homogeneous series.
    const dataRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: [measure], dimensions: [{ name: regionDim, role: 'category' }, { name: productDim, role: 'series' }],
    });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const chartData = await jsonOf<ChartData>(dataRes);
    // The crossjoin reached through the route (the Step 0 fix, proven end-to-end).
    expect(typeof chartData.meta.seriesDimensionName).toBe('string');
    expect(chartData.series.length).toBeGreaterThanOrEqual(2);

    // 3a. Spec, no type → deterministic Layer 1b. The homogeneous-non-negative
    //     categorical signal auto-recommends stacking; region has 3 categories so the
    //     2-category `slope` signal does not pre-empt it.
    const auto = await post('/api/dashboard/chart-spec', { chartData });
    expect(auto.status, await auto.clone().text()).toBe(200);
    const autoSpec = await jsonOf<SpecResp>(auto);
    expect(autoSpec.layer).toBe('1b');
    expect(autoSpec.type).toBe('stackedColumn');
    expect(autoSpec.spec).toHaveProperty('series');

    // 3b. Spec with an explicit type → Layer 1a faithful build over the SAME data.
    const forced = await post('/api/dashboard/chart-spec', { chartData, type: 'stackedColumn' });
    expect(forced.status, await forced.clone().text()).toBe(200);
    const forcedSpec = await jsonOf<SpecResp>(forced);
    expect(forcedSpec.layer).toBe('1a');
    expect(forcedSpec.type).toBe('stackedColumn');
    // ECharts-forced (Track C round 4): the stacked shape is a shared stack id on every
    // series, not Highcharts' plotOptions.series.stacking flag (echarts has no such flag —
    // see echarts-spec-builder.ts:318). Same guarantee, the renderer the app now runs.
    const spec = forcedSpec.spec as any;
    expect(spec.series.every((s: any) => s.stack === 'total')).toBe(true);
  });
});

d('E2E: KPI (with thresholds) → bullet render', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
    cleanups = [];
  });
  afterAll(async () => {
    await runCleanups(cleanups);
    await sweep(app.iris);
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('drives KPI chart-data → chart-spec and gets bullet (or solidgauge fallback if SCO drops thresholds)', async () => {
    // Provision a lower-is-better threshold KPI.
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    const name = `WorkbenchTestBulletKpi${uniqueSuffix()}`;
    await app.iris.kpi.create({
      name, label: 'Bullet E2E KPI', type: 'DeepSee', status: 'Active',
      watchingThreshold: 5, warningThreshold: 10,
      deepseeKpiSpec: { namespace: app.iris.namespace, cube: cube.cubeName, kpiMeasure: 'Total', valueType: 'raw', kpiConditions: ['[RegionD].[H1].[Region].&[North]'] },
    } as never);
    cleanups.push(async () => { try { await app.iris.kpi.delete(name); } catch { /* gone */ } });

    // GATE on the same round-trip probe as integration Step 2a: only if SCO round-trips thresholds.
    const def = await app.iris.kpi.get(name);
    const thresholdsPresent = typeof def?.watchingThreshold === 'number' && typeof def?.warningThreshold === 'number';

    // 1. Data: the one IRIS read for the KPI source → source-agnostic ChartData (scalar).
    const dataRes = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: name });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const chartData = await jsonOf<ChartData>(dataRes);
    expect(chartData.meta.dimensionKind).toBe('scalar');

    // 2. Spec, no type → deterministic Layer 1b.
    const auto = await post('/api/dashboard/chart-spec', { chartData });
    expect(auto.status, await auto.clone().text()).toBe(200);
    const autoSpec = await jsonOf<SpecResp>(auto);
    expect(autoSpec.layer).toBe('1b');

    if (thresholdsPresent) {
      // SCO round-trips the thresholds, so the KPI ChartData carries a target + bands and the
      // deterministic advisor flips the scalar default from solidgauge to bullet. VERIFIED GREEN
      // on the live SCO integration_test image. If it ever regresses, the logged meta localizes
      // whether the target/bands failed to surface on the values path.
      if (autoSpec.type !== 'bullet') {
        console.warn(`E2E KPI BULLET FLIP REGRESSION: autoSpec.type=${autoSpec.type}`);
        console.warn(`  chartData.meta.target=${chartData.meta.target}, bands=${chartData.meta.bands ? JSON.stringify(chartData.meta.bands) : 'undefined'}`);
      }
      expect(autoSpec.type).toBe('bullet');
      expect(autoSpec.spec).toHaveProperty('series');
    } else {
      // SCO LIMITATION: thresholds dropped. Assert the honest fallback.
      expect(autoSpec.type).toBe('solidgauge');
      console.warn(`SCO LIMITATION: KPI ${name} thresholds not round-tripped; chart-spec falls back to solidgauge`);
    }
  });
});

d('E2E: new ECharts types drive chart-data → chart-spec end-to-end', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
    cleanups = [];
  });
  afterAll(async () => {
    await runCleanups(cleanups);
    await sweep(app.iris);
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('bubble + bubbleHeatmap: a 3-measure cube read → forced spec is a scatter (both types)', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src, MULTI_MEASURE);
    cleanups.push(cube.cleanup);

    // 1. Shape → resolve the region dimension (don't hard-code the name).
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    expect(shapeRes.status, await shapeRes.clone().text()).toBe(200);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name;
    expect(regionDim, 'RegionD dimension present').toBeTruthy();

    // 2. Data: three measures over one category dimension → bubble points on the wire.
    const dataRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total', 'Peak', 'Average'], dimensions: [{ name: regionDim, role: 'category' }],
    });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const chartData = await jsonOf<ChartData>(dataRes);
    expect(Array.isArray(chartData.points)).toBe(true);
    expect(chartData.points!.length).toBeGreaterThan(0);

    // 3. Spec (bubble): forced Layer 1a build over the SAME data → an ECharts scatter.
    const bubble = await post('/api/dashboard/chart-spec', { chartData, type: 'bubble' });
    expect(bubble.status, await bubble.clone().text()).toBe(200);
    const bubbleSpec = await jsonOf<SpecResp>(bubble);
    expect(bubbleSpec.layer).toBe('1a');
    expect(bubbleSpec.type).toBe('bubble');
    expect((bubbleSpec.spec as any).series[0].type).toBe('scatter');
    expect((bubbleSpec.spec as any).series[0].data.length).toBeGreaterThan(0);

    // 3b. Spec (bubbleHeatmap): forced build over the same 3-series grid → an ECharts scatter.
    const heat = await post('/api/dashboard/chart-spec', { chartData, type: 'bubbleHeatmap' });
    expect(heat.status, await heat.clone().text()).toBe(200);
    const heatSpec = await jsonOf<SpecResp>(heat);
    expect(heatSpec.type).toBe('bubbleHeatmap');
    expect((heatSpec.spec as any).series[0].type).toBe('scatter');
    expect((heatSpec.spec as any).visualMap.min).toBe(0); // zero-anchored
  });

  it('funnel: a one-measure cube read → forced spec is an ECharts funnel with the chosen order', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src); // the minimal single-measure cube (Total)
    cleanups.push(cube.cleanup);

    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    const shape = await jsonOf<{ dimensions: { name: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name;

    const dataRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'], dimensions: [{ name: regionDim, role: 'category' }],
    });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const chartData = await jsonOf<ChartData>(dataRes);
    expect(chartData.series.length).toBe(1);

    // Forced funnel with source order → the route threads funnelSort into build() → sort:'none'.
    const forced = await post('/api/dashboard/chart-spec', { chartData, type: 'funnel', funnelSort: 'source' });
    expect(forced.status, await forced.clone().text()).toBe(200);
    const forcedSpec = await jsonOf<SpecResp>(forced);
    expect(forcedSpec.layer).toBe('1a');
    expect(forcedSpec.type).toBe('funnel');
    expect((forcedSpec.spec as any).series[0].type).toBe('funnel');
    expect((forcedSpec.spec as any).series[0].sort).toBe('none'); // source order end-to-end through the route
  });
});
