/**
 * E2E FAILURE PATHS — the emphasis of this suite (per docs/integration-testing.md).
 * Each test drives a broken step in the custom-object → cube → KPI → data → query
 * chain and asserts the SPECIFIC failure contract at the seam, not just "it errored".
 *
 * This suite intentionally churns cubes/objects across tests, so it NEVER asserts a
 * working KPI/cube value — only failure contracts. Self-provisioning; per-test
 * cleanups; scmodel objects are create-only and leak (documented).
 *
 * Live IRIS required; run via the path-scoped script: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import {
  createCustomObject,
  seedRowsInto,
  countRowsOf,
  seedSource,
  buildTestCube,
  minimalCubeDef,
  deleteWorkbenchCube,
  runCleanups,
  uniqueSuffix,
  type Cleanup,
  type BuiltCube,
} from '../integration/helpers/provision.js';
import { sweep, healCubeRegistry } from '../integration/helpers/sweep.js';

const d = describe;

d('E2E failure paths — seams across custom object → cube → KPI → data → query', () => {
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

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Seed a source + build a cube; register cleanups; return the built cube. */
  async function cube(): Promise<BuiltCube> {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const c = await buildTestCube(app.iris, src);
    cleanups.push(c.cleanup);
    return c;
  }

  it('F1: building a cube on a source object that was never created → 404 NOT_FOUND with candidates', async () => {
    const def = minimalCubeDef(`WorkbenchTestF1${uniqueSuffix()}`, 'SC.Data.NoSuchObjectXYZ');
    const res = await post('/api/cubes/compile', { definition: def });
    expect(res.status).toBe(404);
    const body = await jsonOf<{ code: string; candidates: string[] }>(res);
    expect(body.code).toBe('NOT_FOUND');
    expect(Array.isArray(body.candidates)).toBe(true);
  });

  it('F2: cube mapping a WRONG property name (the SCO-rename seam) → 422 COMPILE_FAILED with diagnostics', async () => {
    // A real custom object, but the cube maps a dimension to an attribute name
    // that is NOT a real IRIS property on the class.
    const obj = await createCustomObject(app, [
      { name: 'region', dataType: 'String', required: true },
      { name: 'amount', dataType: 'Numeric' },
    ]);
    cleanups.push(obj.cleanup);
    const cubeName = `WorkbenchTestF2${uniqueSuffix()}`;
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));
    const def = minimalCubeDef(cubeName, obj.className, {
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'NotARealProperty', factNumber: 2 }] }],
        },
      ],
      measures: [
        { name: 'Total', sourceProperty: 'amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3 },
      ],
    } as never);
    const res = await post('/api/cubes/compile', { definition: def });
    expect(res.status, await res.clone().text()).toBe(422);
    expect((await jsonOf<{ code: string }>(res)).code).toBe('COMPILE_FAILED');
  });

  it('F3: a KPI over a cube that was never built — SCO does NOT validate the ref at create; value 500s (SC-2643)', async () => {
    const name = `WorkbenchTestKpiF3${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    // Create SUCCEEDS (200) — SCO stores the cube name verbatim without checking it exists.
    const created = await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: 'NoSuchCubeXYZ', kpiMeasure: 'Total', valueType: 'raw', kpiConditions: ['[RegionD].[H1].[Region].Members'] },
    });
    expect([200, 201]).toContain(created.status);
    // The missing cube only surfaces when the value MDX is prepared → known 500 (SC-2643).
    const value = await fetch(`${app.base}/api/scbi/v1/kpi/values/${name}`);
    expect(value.status, `SC-2643: nonexistent cube ref should be a 400 but is a 500. got ${value.status}`).toBeGreaterThanOrEqual(400);
  });

  it('F4: a KPI referencing a measure not on the cube — accepted at create; value fails (SC-2643 class)', async () => {
    const c = await cube();
    const name = `WorkbenchTestKpiF4${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    const created = await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: c.cubeName, kpiMeasure: 'NoSuchMeasure', valueType: 'raw', kpiConditions: ['[RegionD].[H1].[Region].&[North]'] },
    });
    expect([200, 201]).toContain(created.status);
    const value = await fetch(`${app.base}/api/scbi/v1/kpi/values/${name}`);
    expect(value.status).toBeGreaterThanOrEqual(400);
  });

  it('F5: loading a wrong-typed value into a Numeric attribute → IRIS %Save datatype error, row NOT saved', async () => {
    const obj = await createCustomObject(app, [
      { name: 'region', dataType: 'String', required: true },
      { name: 'amount', dataType: 'Numeric' },
    ]);
    cleanups.push(obj.cleanup);
    const load = await seedRowsInto(app.iris, obj.className, [
      { uid: 'ok1', region: 'North', amount: 100 },
      { uid: 'bad', region: 'South', amount: 'not-a-number' }, // datatype violation
    ]);
    cleanups.push(load.cleanup);
    // One row saved, one failed with a readable datatype error.
    expect(load.saved).toBe(1);
    expect(load.failures).toHaveLength(1);
    expect(load.failures[0]).toMatch(/not a valid number|Datatype validation/i);
    // F9 within F5: the persisted count reflects only the committed row (no phantom/stale count).
    expect(await countRowsOf(app.iris, obj.className)).toBe(1);
  });

  it('F6: re-creating an existing custom object is refused (create-only) with a readable Message', async () => {
    const obj = await createCustomObject(app, [{ name: 'code', dataType: 'String', required: true }]);
    cleanups.push(obj.cleanup);
    // Second create with the SAME objectName must not silently update — expect non-2xx + a message.
    const dup = await post('/api/scmodel/v1/objects', {
      objectName: obj.objectName,
      description: 'duplicate',
      attributes: [{ name: 'code', dataType: 'String', required: 0, description: '' }],
    });
    expect([200, 201].includes(dup.status), `duplicate create should be refused (got ${dup.status})`).toBe(false);
    const body = await jsonOf<Record<string, unknown>>(dup);
    const msg = (body.Message ?? body.message ?? body.error) as string | undefined;
    expect(typeof msg === 'string' && msg.length > 0, JSON.stringify(body)).toBe(true);
  });

  it('F7: querying a KPI whose cube was deleted out from under it does NOT return a clean 200', async () => {
    const c = await cube();
    const name = `WorkbenchTestKpiF7${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: c.cubeName, kpiMeasure: 'Total', valueType: 'raw', kpiConditions: ['[RegionD].[H1].[Region].&[North]'] },
    });
    // Delete the cube (and its class) out from under the KPI.
    deleteWorkbenchCube(app.iris, c.cubeName);
    // The value query must not silently succeed; it errors (HTTP >=400) or the
    // request fails at the transport level — either is an acceptable "not a clean 200".
    let cleanSuccess = false;
    try {
      const value = await fetch(`${app.base}/api/scbi/v1/kpi/values/${name}`);
      cleanSuccess = value.status === 200;
    } catch {
      cleanSuccess = false; // transport error is fine — not a clean success
    }
    expect(cleanSuccess, 'KPI value over a deleted cube must not return a clean 200').toBe(false);
  });

  it('F8: malformed MDX in a chained KPI condition → the SC-2643 known-defect contract (>=400)', async () => {
    const c = await cube();
    const name = `WorkbenchTestKpiF8${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    const created = await post('/api/scbi/v1/kpi/definitions', {
      name,
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: {
        namespace: 'SC',
        cube: c.cubeName,
        kpiMeasure: 'Total',
        valueType: 'raw',
        kpiConditions: ['[bogusDim].[H1].[bogusLevel].&[nope]'],
      },
    });
    expect([200, 201]).toContain(created.status);
    // KNOWN DEFECT SC-2643: should be 400; currently a 500 <INVALID OREF>. Assert >=400
    // so this stays green when SCO fixes it to 400.
    const value = await fetch(`${app.base}/api/scbi/v1/kpi/values/${name}`);
    expect(value.status).toBeGreaterThanOrEqual(400);
  });
});
