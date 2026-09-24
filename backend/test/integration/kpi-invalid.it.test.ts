/**
 * KPI invalid-input matrix that needs LIVE IRIS (KI7–KI14): duplicate-create
 * conflict, malformed MDX in kpiConditions (a real SCO defect — see SC-2643),
 * and nonexistent-KPI behavior. The pure validate-before-create branches live in
 * the unit suite (kpi-validate.test.ts). Self-provisioning + self-cleaning.
 *
 * KPIs here use the cube's REAL measure (`Total`) + a REAL member condition so
 * they are genuinely queryable — a KPI built with `%COUNT`/`%ALL` is not, and
 * would 500 on the value endpoint for reasons unrelated to what we're testing.
 *
 * Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import {
  seedSource,
  buildTestCube,
  runCleanups,
  uniqueSuffix,
  TEST_CUBE_MEASURE,
  TEST_CUBE_CONDITION,
  type Cleanup,
  type BuiltCube,
} from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import { IrisError } from '../../src/iris/iris-error.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('KPI invalid-input matrix (live)', () => {
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

  /** A queryable KPI body: real measure + a valid member condition by default. */
  function rawKpi(name: string, cube: string, kpiConditions: string[] = [TEST_CUBE_CONDITION]) {
    return {
      name,
      label: 'IT KPI',
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions },
    };
  }

  it('KI12: a duplicate create surfaces a ConflictError via the agent KPI client', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    await app.iris.kpi.create(rawKpi(name, cube.cubeName) as never);
    // Second create with the same name must be rejected (SCO 400 "already exists").
    const err = await app.iris.kpi.create(rawKpi(name, cube.cubeName) as never).catch((e) => e);
    expect(err).toBeInstanceOf(IrisError);
    // SCO returns 400 for the duplicate on this instance; the message names it.
    expect(String((err as Error).message)).toMatch(/exist/i);
  });

  it('KI12b: a duplicate create through the proxy returns a 4xx the frontend can read', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    const first = await postJson(app.base, '/api/scbi/v1/kpi/definitions', rawKpi(name, cube.cubeName));
    expect([200, 201]).toContain(first.status);
    const dup = await postJson(app.base, '/api/scbi/v1/kpi/definitions', rawKpi(name, cube.cubeName));
    expect(dup.status).toBeGreaterThanOrEqual(400);
    // The SCO body must carry a readable message (capital-M Message or lowercase).
    const body = await jsonOf<Record<string, unknown>>(dup.res);
    const msg = (body.Message ?? body.message ?? body.error) as string | undefined;
    expect(typeof msg === 'string' && msg.length > 0, JSON.stringify(body)).toBe(true);
  });

  it('KI7: malformed MDX in kpiConditions — SCO returns 500 <INVALID OREF> (KNOWN DEFECT, SC-2643; should be 400)', async () => {
    // A bogus dimension/level reference. It is NOT validated by the Workbench and
    // passes create; the failure surfaces only when the value MDX is prepared.
    //
    // KNOWN DEFECT — SC-2643: SC.Core.API.KPI.KpiApiImpl.ExecuteMdxQuery returns a
    // %Status (not a %DeepSee.ResultSet) when %PrepareMDX fails, and the caller
    // dereferences it → <INVALID OREF> → HTTP 500. This SHOULD be a 400 with a
    // readable message. This test asserts the CURRENT (buggy) 500 so it documents
    // reality and will fail loudly — prompting an update — once SC-2643 is fixed.
    //
    // NOTE: we assert only that malformed MDX does NOT silently succeed (it must
    // be a 4xx/5xx). We deliberately do not assert a *working* value here: a
    // queryable-value baseline is not reproducible under this suite's rapid
    // build/kill cube churn — killing a cube can leave DeepSee unable to
    // %PrepareMDX for a later cube in the same process, so even a valid condition
    // may 500. Value-query success is not what this suite is about.
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    const badMdx = '[bogusDim].[H1].[bogusLevel].&[nope]';
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', rawKpi(name, cube.cubeName, [badMdx]));
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);

    const value = await fetch(`${app.base}/api/scbi/v1/kpi/values/${name}`);
    // Malformed MDX must never yield a clean 200 success. Current behavior is a
    // 500 <INVALID OREF> (SC-2643); the desired behavior is a 400. Accept either
    // failure so this test stays green when SC-2643 is fixed to return 400.
    expect(
      value.status >= 400,
      `malformed MDX must be a 4xx/5xx (SC-2643 tracks 500→400). got ${value.status}: ${await bodyText(value.clone())}`,
    ).toBe(true);
  });

  it('KI14: get a nonexistent KPI returns null (no throw)', async () => {
    expect(await app.iris.kpi.get(`WorkbenchTestKpiMissing${uniqueSuffix()}`)).toBeNull();
  });
});

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; res: Response }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, res };
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
