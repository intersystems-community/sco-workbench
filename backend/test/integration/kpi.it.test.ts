/**
 * KPI CRUD (K1–K13) against a live, clean IRIS. Each test that needs a cube
 * builds its own (KPIs reference the Workbench cube the SAME test built — never
 * populated SCO data), and cleans up KPI + cube + source in afterEach.
 *
 * Exercises the SCO scbi REST path both through the backend proxy (the Angular
 * app's path) and through the agent KPI client (iris.kpi), plus the local draft
 * store. Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, runCleanups, uniqueSuffix, TEST_CUBE_MEASURE, TEST_CUBE_CONDITION, REGION_DIMENSION, NULLABLE_SEGMENT_DIMENSION, TEST_CUBE_NULLABLE_LEVEL, type Cleanup, type BuiltCube } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import { composeCondition } from '../../src/dashboard/condition-mdx.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('KPI CRUD (live)', () => {
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

  /** Build a source + cube for a KPI to reference; register cleanups. */
  async function cubeForKpi(): Promise<BuiltCube> {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    return cube;
  }

  /**
   * A KPI definition body over the given cube. Uses the cube's real `Total`
   * measure and a valid member condition (not `%COUNT`/`%ALL`, which are not
   * queryable) so the KPI matches how the product actually builds one.
   */
  function kpiDef(name: string, cube: string, extra: Record<string, unknown> = {}) {
    return {
      name,
      label: 'IT KPI',
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: {
        namespace: 'SC',
        cube,
        kpiMeasure: TEST_CUBE_MEASURE,
        valueType: 'raw',
        kpiConditions: [TEST_CUBE_CONDITION],
      },
      ...extra,
    };
  }

  it('K1–K4: create → read → update → delete a raw KPI via the proxy', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    // K1 CREATE
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', kpiDef(name, cube.cubeName));
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);

    // K2 READ (in the list)
    const list = await kpiList(app.base);
    expect(list.some((k) => k.name === name)).toBe(true);

    // K3 UPDATE (relabel)
    const upd = await fetch(`${app.base}/api/scbi/v1/kpi/definitions/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kpiDef(name, cube.cubeName, { label: 'IT KPI (renamed)' })),
    });
    expect(upd.status).toBe(200);
    const after = await jsonOf<{ label: string }>(await fetch(`${app.base}/api/scbi/v1/kpi/definitions/${name}`));
    expect(after.label).toBe('IT KPI (renamed)');

    // K4 DELETE
    const del = await fetch(`${app.base}/api/scbi/v1/kpi/definitions/${name}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list2 = await kpiList(app.base);
    expect(list2.some((k) => k.name === name)).toBe(false);
  });

  it('K5/K6: percentage round-trip with baseConditions, then flip to raw', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    const pct = {
      name,
      label: 'IT Pct',
      type: 'DeepSee',
      status: 'Active',
      watchingThreshold: 5,
      warningThreshold: 10,
      issueKpi: true,
      defaultIssueSeverity: 2,
      deepseeKpiSpec: {
        namespace: 'SC',
        cube: cube.cubeName,
        kpiMeasure: TEST_CUBE_MEASURE,
        valueType: 'percentage',
        // numerator: North region; denominator: all regions (a superset member).
        kpiConditions: [TEST_CUBE_CONDITION],
        baseConditions: ['[RegionD].[H1].[Region].&[South]'],
      },
    };
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', pct);
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);

    const got = await jsonOf<{ watchingThreshold: number; deepseeKpiSpec: { valueType: string; baseConditions?: string[] } }>(
      await fetch(`${app.base}/api/scbi/v1/kpi/definitions/${name}`),
    );
    expect(got.watchingThreshold).toBe(5);
    expect(got.deepseeKpiSpec.valueType).toBe('percentage');
    expect((got.deepseeKpiSpec.baseConditions ?? []).length).toBeGreaterThan(0);

    // K6 flip to raw
    const raw = { ...pct, deepseeKpiSpec: { ...pct.deepseeKpiSpec, valueType: 'raw' } } as Record<string, unknown>;
    delete (raw.deepseeKpiSpec as Record<string, unknown>).baseConditions;
    const upd = await fetch(`${app.base}/api/scbi/v1/kpi/definitions/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(raw),
    });
    expect(upd.status).toBe(200);
    const afterFlip = await jsonOf<{ deepseeKpiSpec: { valueType: string } }>(
      await fetch(`${app.base}/api/scbi/v1/kpi/definitions/${name}`),
    );
    expect(afterFlip.deepseeKpiSpec.valueType).toBe('raw');
  });

  it('I1 / SC-2662 AC#1 (Agent mode): a KPI condition COMPOSED by the shared composeCondition composer round-trips to a real value (guided placement is unreachable-malformed)', async () => {
    // I1 (SC-2666) + SC-2662 AC#1: the reshaped guided KPI form composes a condition via
    // composeCondition(sel, 'is') — the SAME composer the frontend ships (and the byte-mirror
    // the FE spec pins). This proves the Agent/guided path fills the DeepSee spec non-blank
    // end-to-end: the composed condition reads a real number — no `<INVALID OREF>`. It is the
    // deliberate contrast to kpi-invalid.it.test.ts KI7, which feeds a HAND-TYPED malformed MDX
    // and asserts the SC-2643 500: guided input is unreachable-malformed by construction,
    // free-text can still be malformed.
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    // Compose the North-region condition the way the RESHAPED guided form does — via the shared
    // composeCondition('is') composer the UI ships, not a bare memberRef. Proves the Agent/guided
    // path fills the DeepSee spec non-blank through the SAME code.
    const composed = composeCondition(
      { dim: 'RegionD', levelSpec: '[RegionD].[H1].[Region]', member: 'North', key: 'North' },
      'is',
    );
    // The composed reference is byte-identical to the verified queryable fixture — the guided form
    // produces exactly the string the product's own valid conditions use.
    expect(composed).toBe(TEST_CUBE_CONDITION);

    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', kpiDef(name, cube.cubeName, {
      deepseeKpiSpec: {
        namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE,
        valueType: 'raw', kpiConditions: [composed],
      },
    }));
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);

    // The value read must succeed with a real number — the composed condition is valid MDX.
    const res = await fetch(`${app.base}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: name }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    expect(data.meta.dimensionKind).toBe('scalar');
    const numeric = data.series[0]!.data.filter((v) => typeof v === 'number');
    expect(numeric.length, JSON.stringify(data)).toBeGreaterThan(0);
  });

  /**
   * Create a raw KPI with the given kpiConditions over `cube`, read its scalar value through the
   * dashboard chart-data proxy, and return the number. An empty `kpiConditions` array reads the
   * UNFILTERED total — the true baseline every A-ladder assertion compares against.
   */
  async function readKpiValue(cube: BuiltCube, kpiConditions: string[]): Promise<number> {
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', kpiDef(name, cube.cubeName, {
      deepseeKpiSpec: { namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions },
    }));
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);
    const res = await fetch(`${app.base}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: name }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    return data.series[0]!.data.find((v): v is number => typeof v === 'number')!;
  }

  it('A-ladder: is one of / is not / is not one of round-trip to real filtered values on RegionD', async () => {
    const cube = await cubeForKpi();
    const lvl = '[RegionD].[H1].[Region]';
    const north = { dim: 'RegionD', levelSpec: lvl, member: 'North', key: 'North' };
    const south = { dim: 'RegionD', levelSpec: lvl, member: 'South', key: 'South' };
    const baseline = await readKpiValue(cube, []);   // no condition = the unfiltered total (the true baseline)
    expect(baseline).toBeGreaterThan(0);
    // is not North differs from is North (both valid, disjoint slices of the same total)
    const isNorth = await readKpiValue(cube, [composeCondition(north, 'is')]);
    const notNorth = await readKpiValue(cube, [composeCondition(north, 'isNot')]);
    expect(isNorth).toBeGreaterThan(0);
    expect(notNorth).not.toBe(isNorth);
    expect(notNorth).not.toBe(baseline);           // isNot removes North → below the total
    // is one of {North,South} sits between one region and the total; is not one of is its complement
    const oneOf = await readKpiValue(cube, [composeCondition([north, south], 'isOneOf')]);
    const notOneOf = await readKpiValue(cube, [composeCondition([north, south], 'isNotOneOf')]);
    expect(oneOf).toBeGreaterThan(isNorth);        // {North,South} ⊇ {North}
    expect(notOneOf).not.toBe(baseline);           // complement of {North,South} → below the total
  });

  it('dropdown-flow string round-trips to a real scalar, and a same-level merge is value-inert beyond the union', async () => {
    const cube = await cubeForKpi();
    const lvl = '[RegionD].[H1].[Region]';
    const north = { dim: 'RegionD', levelSpec: lvl, member: 'North', key: 'North' };
    const south = { dim: 'RegionD', levelSpec: lvl, member: 'South', key: 'South' };
    // The string the dropdown-only FE flow composes (setConditionLevel → selectConditionMember →
    // composeCondition(...,'is')) reads a real, non-empty slice.
    const isNorth = await readKpiValue(cube, [composeCondition(north, 'is')]);
    expect(isNorth).toBeGreaterThan(0);
    // A same-level merge produces exactly the union set — value-inert beyond the union: the merged
    // {North,South} KPI equals a hand-authored isOneOf {North,South} KPI.
    const merged = await readKpiValue(cube, [composeCondition([north, south], 'isOneOf')]);
    const handAuthored = await readKpiValue(cube, [composeCondition([south, north], 'isOneOf')]);
    expect(merged).toBe(handAuthored);               // order-invariant union → same value
    expect(merged).toBeGreaterThanOrEqual(isNorth);  // {North,South} ⊇ {North}
  });

  it('Item 1 (SC-2666): a TYPED member value round-trips through the shared composer to a real scalar; a non-member key returns 200 + empty, never an error', async () => {
    const cube = await cubeForKpi();
    const lvl = '[RegionD].[H1].[Region]';
    const baseline = await readKpiValue(cube, []);            // unfiltered total
    expect(baseline).toBeGreaterThan(0);

    // A value the builder produces by TYPING is byte-identical to a picked one (same composeCondition),
    // so this one assertion characterizes the typed-value path — no separate cube or fixture needed.
    const typed = composeCondition({ dim: 'RegionD', levelSpec: lvl, member: 'North', key: 'North' }, 'is');
    const north = await readKpiValue(cube, [typed]);
    expect(north).toBeGreaterThan(0);                         // a real, non-empty slice
    expect(north).not.toBe(baseline);                        // and genuinely filtered

    // A typed key that is NOT a member of this cube's Region level: SCO accepts the ref and returns a 200
    // with an empty/zero slice, NOT a 4xx/5xx. The backend passes the condition through unparsed, so the FE
    // advisory (analyzeConditions unknownMember) is the only signal — this pins that there is no server error.
    const nowhere = composeCondition({ dim: 'RegionD', levelSpec: lvl, member: 'Nowhere', key: 'Nowhere' }, 'is');
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', kpiDef(name, cube.cubeName, {
      deepseeKpiSpec: { namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions: [nowhere] },
    }));
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);
    const res = await fetch(`${app.base}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: name }),
    });
    expect(res.status, await res.clone().text()).toBe(200);   // accepted, NOT an error
    const data = await jsonOf<ChartData>(res);
    const numbers = data.series[0]!.data.filter((v): v is number => typeof v === 'number');
    expect(numbers.every((v) => v === 0)).toBe(true);         // silently empty/zero, never a thrown error
  });

  it('is not null keeps the non-null rows on a NULLABLE level (differs from is null and from the baseline)', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src, { dimensions: [REGION_DIMENSION, NULLABLE_SEGMENT_DIMENSION] });
    cleanups.push(cube.cleanup);
    const seg = { dim: 'SegmentD', levelSpec: TEST_CUBE_NULLABLE_LEVEL, member: 'x' };
    const baseline = await readKpiValue(cube, []);                                 // unfiltered total
    const notNull = await readKpiValue(cube, [composeCondition(seg, 'isNotNull')]);
    const isNull = await readKpiValue(cube, [composeCondition(seg, 'isNull')]);
    expect(notNull).toBeGreaterThan(0);          // some rows are non-null
    expect(isNull).toBeGreaterThan(0);           // some rows ARE null (the fixture seeds both, every 3rd row)
    expect(notNull).not.toBe(isNull);            // is-not-null is not a no-op on a nullable level
    expect(notNull).not.toBe(baseline);          // and it removes the null rows → below the total
  });

  it('K8: lists KPI base objects from SC.Core.API.Data.*ApiImpl', async () => {
    const body = await jsonOf<{ baseObjects: string[] }>(await fetch(`${app.base}/api/kpi-drafts/base-objects`));
    expect(Array.isArray(body.baseObjects)).toBe(true);
    expect(body.baseObjects).toContain('SalesOrder');
    expect(body.baseObjects.every((n) => !n.includes('.') && !n.endsWith('ApiImpl'))).toBe(true);
  });

  it('K9: agent KPI client CRUD round-trips (create/get/delete via iris.kpi)', async () => {
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));

    await app.iris.kpi.create(kpiDef(name, cube.cubeName) as never);
    const got = await app.iris.kpi.get(name);
    expect(got?.name).toBe(name);
    await app.iris.kpi.delete(name);
    expect(await app.iris.kpi.get(name)).toBeNull();
  });

  it('K10: get a nonexistent KPI returns null', async () => {
    expect(await app.iris.kpi.get(`NoSuchKpi${uniqueSuffix()}`)).toBeNull();
  });

  it('K11–K13: KPI draft save → rename cleans old → delete (local, no IRIS)', async () => {
    const a = `WorkbenchDraftKpiA${uniqueSuffix()}`;
    const b = `WorkbenchDraftKpiB${uniqueSuffix()}`;
    const draft = (name: string) => ({ name, type: 'DeepSee', deepseeKpiSpec: { cube: 'X', valueType: 'raw' } });

    const save = await postJson(app.base, '/api/kpi-drafts/save', { definition: draft(a) });
    expect(save.status).toBe(200);
    let list = await jsonOf<{ drafts: Array<{ kpiName: string }> }>(await fetch(`${app.base}/api/kpi-drafts`));
    expect(list.drafts.some((x) => x.kpiName === a)).toBe(true);

    await postJson(app.base, '/api/kpi-drafts/save', { definition: draft(b), originalName: a });
    list = await jsonOf<{ drafts: Array<{ kpiName: string }> }>(await fetch(`${app.base}/api/kpi-drafts`));
    expect(list.drafts.some((x) => x.kpiName === a)).toBe(false);
    expect(list.drafts.some((x) => x.kpiName === b)).toBe(true);

    const del = await fetch(`${app.base}/api/kpi-drafts/${b}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    list = await jsonOf<{ drafts: Array<{ kpiName: string }> }>(await fetch(`${app.base}/api/kpi-drafts`));
    expect(list.drafts.some((x) => x.kpiName === b)).toBe(false);
  });

  it('D7/SC-2663: a percentage KPI carries meta.unit="percent" and reads on the 0–100 scale (ring crux)', async () => {
    // numerator === denominator (both North) → the true percentage is exactly 100%. On the assumed
    // 0–100 wire the value is 100; a 0–1 wire would return 1 — the design's predicted-failure signal
    // (spec §Item 1, "percentage value SCALE unconfirmed"). Karsten's :3000 look is the visual confirm.
    const cube = await cubeForKpi();
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    const pct = kpiDef(name, cube.cubeName, {
      deepseeKpiSpec: {
        namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'percentage',
        kpiConditions: [TEST_CUBE_CONDITION],                 // numerator: North
        baseConditions: [TEST_CUBE_CONDITION],                // denominator: North → ratio 1.0 = 100%
      },
    });
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', pct);
    expect([200, 201], await bodyText(created.res.clone())).toContain(created.status);

    const res = await fetch(`${app.base}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: name }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(res);
    expect(data.meta.dimensionKind).toBe('scalar');
    expect(data.meta.unit).toBe('percent');                  // the plumbing reaches the wire
    const value = data.series[0]!.data.find((v): v is number => typeof v === 'number')!;
    expect(value).toBe(100);                                 // 0–100 scale hypothesis; 1 ⇒ 0–1 wire (finding)
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

/**
 * Read the KPI definition list through the proxy, coercing a non-array body to
 * `[]` — exactly what the production client (KpiRestClient.list) and the Angular
 * app do. The raw proxied SCO response is occasionally a non-array (an error/
 * status envelope during churn); the test shouldn't crash with
 * "some is not a function" on that transient shape — an empty list is the correct
 * "KPI not present" answer for the delete check, and a present-KPI assertion
 * still fails loudly if the list genuinely came back empty.
 */
async function kpiList(base: string): Promise<Array<{ name: string }>> {
  const body = await jsonOf<unknown>(await fetch(`${base}/api/scbi/v1/kpi/definitions`));
  return Array.isArray(body) ? (body as Array<{ name: string }>) : [];
}
