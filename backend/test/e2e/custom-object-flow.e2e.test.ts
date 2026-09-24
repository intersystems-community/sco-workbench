/**
 * E2E golden path — the literal multi-component chain over a CUSTOM scmodel
 * object: create object → discover its class + properties → load known rows →
 * build a cube on it → build a KPI on the cube → query cube factCount + KPI value.
 *
 * We control the data (a brand-new class, seeded with a known N), so this asserts
 * an EXACT clean-state `factCount === N` and an EXACT KPI value. Stability: this
 * file builds exactly ONE cube, so it never hits the DeepSee `%PrepareMDX`
 * poisoning that only appears after build/kill churn within one process.
 *
 * Live IRIS required; run via the path-scoped script: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import {
  createCustomObject,
  seedRowsInto,
  countRowsOf,
  minimalCubeDef,
  deleteWorkbenchCube,
  runCleanups,
  uniqueSuffix,
  type Cleanup,
} from '../integration/helpers/provision.js';
import { sweep, healCubeRegistry } from '../integration/helpers/sweep.js';
import { cubeInfo } from '../../src/iris/cube-ops.js';

const d = describe;

// Deterministic dataset: cube SUM(amount) grouped by region; KPI filters to North.
const ROWS = [
  { uid: 'r1', region: 'North', amount: 100 },
  { uid: 'r2', region: 'North', amount: 30 },
  { uid: 'r3', region: 'South', amount: 50 },
  { uid: 'r4', region: 'East', amount: 20 },
];
const TOTAL_ROWS = ROWS.length; // 4
const NORTH_TOTAL = 130; // 100 + 30 — the expected KPI value for the North member

d('E2E: custom object → cube → KPI → data → query (custom scmodel object)', () => {
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

  it('chains all five components and reads back an exact factCount + KPI value', async () => {
    // 1. Create a custom data-model object (create-only; it leaks — see helper note).
    const obj = await createCustomObject(app, [
      { name: 'region', dataType: 'String', required: true },
      { name: 'amount', dataType: 'Numeric' },
    ]);
    cleanups.push(obj.cleanup); // delete the SC.Data.* class on teardown (avoids leak/slowdown)
    // 2. Discovery seam: SCO owns the class name + adds a required `uid` PK.
    expect(obj.className, 'SCO generated a class name').toBeTruthy();
    expect(obj.props).toContain('region');
    expect(obj.props).toContain('amount');
    expect(obj.props, 'SCO adds a required uid primary key').toContain('uid');

    // 3. Load a KNOWN, clean set of rows into the brand-new class.
    const load = await seedRowsInto(app.iris, obj.className, ROWS);
    cleanups.push(load.cleanup);
    expect(load.failures, load.failures.join('; ')).toHaveLength(0);
    expect(load.saved).toBe(TOTAL_ROWS);
    // Clean state: the class is new, so its total row count equals exactly what we inserted.
    expect(await countRowsOf(app.iris, obj.className)).toBe(TOTAL_ROWS);

    // 4. Build a Workbench cube on the custom object's class, using DISCOVERED
    //    property names (region → dimension, amount → SUM measure). minimalCubeDef's
    //    dimension/measure source props (Region/Amount) are overridden to match.
    const cubeName = `WorkbenchTestCube${uniqueSuffix()}`;
    const def = minimalCubeDef(cubeName, obj.className, {
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'region', factNumber: 2 }] }],
        },
      ],
      measures: [
        { name: 'Total', sourceProperty: 'amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3 },
      ],
    } as never);
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));

    const built = await jsonOf<{ state: string; className: string; factCount: number }>(
      await post('/api/cubes/build', { definition: def }),
    );
    expect(built.state, JSON.stringify(built)).toBe('built');
    // 5. Clean-state factCount: exactly the rows we loaded (no stale/pre-existing data).
    expect(built.factCount).toBe(TOTAL_ROWS);
    expect(cubeInfo(app.iris.native, cubeName).factCount).toBe(TOTAL_ROWS);

    // 6. Build a KPI on the cube (real measure + real member condition) and read its value.
    const kpiName = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(kpiName).catch(() => {}));
    const createdKpi = await post('/api/scbi/v1/kpi/definitions', {
      name: kpiName,
      label: 'E2E KPI',
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: {
        namespace: 'SC',
        cube: cubeName,
        kpiMeasure: 'Total',
        valueType: 'raw',
        kpiConditions: ['[RegionD].[H1].[Region].&[North]'],
      },
    });
    expect([200, 201], await createdKpi.clone().text()).toContain(createdKpi.status);

    const valueRes = await fetch(`${app.base}/api/scbi/v1/kpi/values/${kpiName}`);
    expect(valueRes.status, await valueRes.clone().text()).toBe(200);
    const value = await jsonOf<{ values: Array<{ value: number }> }>(valueRes);
    const total = value.values.reduce((sum, v) => sum + Number(v.value), 0);
    // The KPI filters to the North member → SUM(amount) over North rows = 130.
    expect(total).toBe(NORTH_TOTAL);
  });

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
});
