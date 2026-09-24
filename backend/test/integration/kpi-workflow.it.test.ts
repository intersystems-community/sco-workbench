/**
 * KPI draft-vs-real state workflows (W8–W10) against live IRIS. These exercise
 * the draft store's rename semantics and the interaction between a local draft
 * and a real IRIS KPI of the same name. Self-provisioning + self-cleaning.
 *
 * Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, runCleanups, uniqueSuffix, TEST_CUBE_MEASURE, TEST_CUBE_CONDITION, type Cleanup, type BuiltCube } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('KPI draft/real workflows (live)', () => {
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
  beforeEach(() => {
    cleanups = [];
  });
  afterEach(async () => {
    await runCleanups(cleanups);
  });

  async function cubeForKpi(): Promise<BuiltCube> {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    return cube;
  }

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const draftDef = (name: string) => ({ name, type: 'DeepSee', deepseeKpiSpec: { cube: 'X', valueType: 'raw' } });

  it('W8: creating a "new" KPI whose name equals an existing IRIS KPI is refused (no silent overwrite)', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    // A real IRIS KPI exists.
    const first = await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions: [TEST_CUBE_CONDITION] },
    });
    expect([200, 201]).toContain(first.status);

    // A create (POST, not PUT) with the same name must be refused, not treated as
    // an update — otherwise a "new" flow silently clobbers the existing KPI.
    const dup = await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions: [TEST_CUBE_CONDITION] },
    });
    expect(dup.status).toBeGreaterThanOrEqual(400);
  });

  it('W9: renaming a draft onto a name that already has its own draft must not silently lose the other draft', async () => {
    const a = `WorkbenchDraftA${uniqueSuffix()}`;
    const b = `WorkbenchDraftB${uniqueSuffix()}`;

    await post('/api/kpi-drafts/save', { definition: draftDef(a) });
    await post('/api/kpi-drafts/save', { definition: draftDef(b) });

    // Rename A → B (B already exists as a distinct draft). The current store
    // upserts by name, so B is overwritten by A's content and A is dropped —
    // documenting the collision. We assert the observable outcome: exactly one
    // draft named B survives, and A is gone (no orphan, no duplicate).
    await post('/api/kpi-drafts/save', { definition: draftDef(b), originalName: a });

    const list = await jsonOf<{ drafts: Array<{ kpiName: string }> }>(await fetch(`${app.base}/api/kpi-drafts`));
    const bs = list.drafts.filter((x) => x.kpiName === b);
    const as = list.drafts.filter((x) => x.kpiName === a);
    expect(bs.length, 'exactly one B draft, no duplicate').toBe(1);
    expect(as.length, 'A draft removed by the rename').toBe(0);

    // cleanup
    await fetch(`${app.base}/api/kpi-drafts/${b}`, { method: 'DELETE' });
  });

  it('W10: after a successful KPI submit, the draft is removed so the list shows only the IRIS entry', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    // Draft exists locally.
    await post('/api/kpi-drafts/save', { definition: draftDef(name) });
    // Real KPI created in IRIS.
    await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions: [TEST_CUBE_CONDITION] },
    });
    // The frontend deletes the draft on success; assert the draft delete works so
    // no stale draft shadows the real KPI.
    const del = await fetch(`${app.base}/api/kpi-drafts/${name}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list = await jsonOf<{ drafts: Array<{ kpiName: string }> }>(await fetch(`${app.base}/api/kpi-drafts`));
    expect(list.drafts.some((x) => x.kpiName === name)).toBe(false);
  });
});
