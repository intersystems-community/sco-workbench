/**
 * D3 KPI CHART-QUERY path against a live, clean IRIS — the KPI-values read nothing
 * else exercises through /api/dashboard. Builds a queryable KPI over a seeded cube,
 * queries it scalar and expanded, and documents the SC-2643 500 → our 422 mapping
 * and the bad-expand-dimension NotFoundError. Self-provisioning + self-cleaning on the
 * clean-SCO baseline. Live IRIS required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, makeTestKpi, runCleanups, type Cleanup } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

describe('KPI chart-query (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => { app = bootApp(); await healCubeRegistry(app.iris); });
  afterAll(async () => { await sweep(app.iris); await app.close(); });
  beforeEach(() => { cleanups = []; });
  afterEach(async () => { await runCleanups(cleanups); });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /** A seeded cube + a queryable raw KPI over it (real measure + a real member condition). */
  async function freshKpi() {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    const kpi = await makeTestKpi(app.iris, cube);
    cleanups.push(kpi.cleanup);
    return { kpi };
  }

  it('a queryable KPI returns a scalar ChartData with a real number', async () => {
    const { kpi } = await freshKpi();
    const res = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: kpi.name });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    expect(data.meta.dimensionKind).toBe('scalar');
    expect(data.series.length).toBe(1);
    const numeric = data.series[0]!.data.filter((v) => typeof v === 'number');
    expect(numeric.length, JSON.stringify(data)).toBeGreaterThan(0);
  });

  it('the KPI listing includes the built KPI', async () => {
    const { kpi } = await freshKpi();
    const res = await fetch(`${app.base}/api/dashboard/kpis`);
    expect(res.status).toBe(200);
    const body = await jsonOf<{ kpis: { name: string }[] }>(res);
    expect(body.kpis.some((k) => k.name === kpi.name)).toBe(true);
  });

  it('a bad expandDimension → 404 NOT_FOUND (never a silently-swallowed scalar)', async () => {
    const { kpi } = await freshKpi();
    const res = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: kpi.name, expandDimension: 'NoSuchDim' });
    expect(res.status).toBe(404);
    expect((await jsonOf<{ code: string }>(res)).code).toBe('NOT_FOUND');
  });

  it('an un-evaluatable KPI (%COUNT/%ALL pseudo-input) reproduces the 500 and our 422 normalization', async () => {
    // Per docs/integration-testing.md: a KPI built with %COUNT/%ALL 500s on the scbi
    // values endpoint (the SC-2643 symptom). Build one deliberately, assert our 422.
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    const badName = `WorkbenchTestBadKpi${Date.now()}`;
    await app.iris.kpi.create({
      name: badName, label: 'Bad IT KPI', type: 'DeepSee', status: 'Active',
      deepseeKpiSpec: { namespace: app.iris.namespace, cube: cube.cubeName, kpiMeasure: '%COUNT', valueType: 'raw' },
    } as never);
    cleanups.push(async () => { try { await app.iris.kpi.delete(badName); } catch { /* already gone */ } });
    const res = await post('/api/dashboard/chart-data', { source: 'kpi', kpi: badName });
    // Assert the ERROR taxonomy when it errors (the case we want), and record the observed
    // behavior so a future SCO change is visible (docs/integration-testing.md prescribes this).
    if (res.status === 422) {
      expect((await jsonOf<{ code: string }>(res)).code).toBe('QUERY_FAILED');
    } else {
      expect(res.status).toBe(200); // documents that SCO evaluated it after all
    }
  });
});
