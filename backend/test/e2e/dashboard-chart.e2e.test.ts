/**
 * E2E — the full D2 charting flow through the mounted app for the CUBE source:
 * cube-shape → chart-data → chart-spec, end to end, to catch a proxy-prefix or
 * router-wiring regression the unit tier (which mocks IRIS) cannot. Builds one
 * Workbench cube over a seeded source, then drives the three routes in order and
 * asserts a renderable ECharts spec comes back for each layer path (1b default,
 * 1a override). The KPI source flow follows below.
 *
 * Live IRIS required; run via: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import { seedSource, buildTestCube, makeTestKpi, runCleanups, type Cleanup } from '../integration/helpers/provision.js';
import { sweep, healCubeRegistry } from '../integration/helpers/sweep.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

const d = describe;

interface SpecResp {
  spec: Record<string, unknown>;
  type: string;
  layer: '1a' | '1b' | '2';
  source?: string;
  fallback?: boolean;
}

d('E2E: cube chart flow (shape → data → spec) through the mounted app', () => {
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

  it('drives cube-shape → chart-data → chart-spec and gets a renderable spec each layer', async () => {
    // Build a real cube over a seeded source (20 rows across North/South/East).
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);

    // 1a. Chartable cubes: the picker's list. The cube we just built has both a
    //     measure and a dimension, so it must be offered — with truthful counts.
    const chartableRes = await fetch(`${app.base}/api/dashboard/chartable-cubes`);
    expect(chartableRes.status, await chartableRes.clone().text()).toBe(200);
    const chartable = await jsonOf<{ cubes: { cubeName: string; measureCount: number; dimensionCount: number }[] }>(chartableRes);
    const listed = chartable.cubes.find((c) => c.cubeName === cube.cubeName);
    expect(listed, `built cube ${cube.cubeName} should be offered as chartable`).toBeDefined();
    expect(listed!.measureCount).toBeGreaterThan(0);
    expect(listed!.dimensionCount).toBeGreaterThan(0);
    // The endpoint REPORTS FACTS: every cube in the namespace with well-formed,
    // non-negative measure/dimension counts — deliberately INCLUDING 0-count cubes
    // (SCO's WorkbenchTest*IT* residue, and the WBDemoEmpty/WBDemoNoDim fixtures).
    // Chartability (both counts > 0) is decided in the FRONTEND (isCubeChartable),
    // not here — see chartable-cubes.ts, "backend reports facts, frontend decides
    // policy". So the invariant to assert is well-formedness, not "no 0-count cube",
    // which would contradict the contract and flake on any shared-instance residue.
    for (const c of chartable.cubes) {
      expect(Number.isInteger(c.measureCount), `${c.cubeName} measureCount is an integer`).toBe(true);
      expect(c.measureCount, `${c.cubeName} measureCount`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(c.dimensionCount), `${c.cubeName} dimensionCount is an integer`).toBe(true);
      expect(c.dimensionCount, `${c.cubeName} dimensionCount`).toBeGreaterThanOrEqual(0);
    }

    // 1. Shape: the picker's metadata (measures + dimensions) via the proxy-local route.
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    expect(shapeRes.status, await shapeRes.clone().text()).toBe(200);
    const shape = await jsonOf<{ measures: { name: string }[]; dimensions: { name: string }[] }>(shapeRes);
    const measure = shape.measures.find((m) => m.name === 'Total')?.name ?? shape.measures[0]!.name;
    const dimension = shape.dimensions.find((dd) => dd.name.toLowerCase().includes('region'))?.name ?? shape.dimensions[0]!.name;

    // 2. Data: the one IRIS read, producing source-agnostic ChartData.
    const dataRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: [measure], dimensions: [{ name: dimension, role: 'category' }],
    });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const chartData = await jsonOf<ChartData>(dataRes);
    expect(chartData.series.length).toBe(1);
    expect(chartData.categories.length).toBeGreaterThan(0);

    // 3a. Spec, no type → deterministic Layer 1b, renderable ECharts options (the forced
    //     renderer this cycle). The assertion is renderer-agnostic — both shapes carry `series`.
    const auto = await post('/api/dashboard/chart-spec', { chartData });
    expect(auto.status, await auto.clone().text()).toBe(200);
    const autoSpec = await jsonOf<SpecResp>(auto);
    expect(autoSpec.layer).toBe('1b');
    expect(autoSpec.spec).toHaveProperty('series');
    expect(autoSpec.type).toBeTruthy();

    // 3b. Spec with an explicit type → Layer 1a faithful build over the SAME data
    //     (no second /chart-data; the client holds the ChartData).
    const forced = await post('/api/dashboard/chart-spec', { chartData, type: 'column' });
    expect(forced.status, await forced.clone().text()).toBe(200);
    const forcedSpec = await jsonOf<SpecResp>(forced);
    expect(forcedSpec.layer).toBe('1a');
    expect(forcedSpec.type).toBe('column');
    expect(forcedSpec.spec).toHaveProperty('series');
  });

  it('drives KPI chart-data → chart-spec and gets a renderable gauge spec', async () => {
    // A queryable scalar KPI over a freshly built cube (real measure + real member condition).
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    const kpi = await makeTestKpi(app.iris, cube);
    cleanups.push(kpi.cleanup);

    // The KPI must be offered by the discovery route (it is DeepSee-backed).
    const kpisRes = await fetch(`${app.base}/api/dashboard/kpis`);
    expect(kpisRes.status, await kpisRes.clone().text()).toBe(200);
    const { kpis } = await jsonOf<{ kpis: { name: string }[] }>(kpisRes);
    expect(kpis.some((k) => k.name === kpi.name), `KPI ${kpi.name} should be offered`).toBe(true);

    // 1. Data: the one IRIS read for the KPI source → source-agnostic ChartData (scalar).
    const dataRes = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: kpi.name });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const chartData = await jsonOf<ChartData>(dataRes);
    expect(chartData.meta.dimensionKind).toBe('scalar');
    expect(chartData.series.length).toBe(1);

    // 2. Spec, no type → deterministic Layer 1b; a scalar → a renderable gauge spec.
    const auto = await post('/api/dashboard/chart-spec', { chartData });
    expect(auto.status, await auto.clone().text()).toBe(200);
    const autoSpec = await jsonOf<SpecResp>(auto);
    expect(autoSpec.layer).toBe('1b');
    expect(autoSpec.type).toBe('solidgauge');
    expect(autoSpec.spec).toHaveProperty('series');
  });
});
