/**
 * E2E golden path — the same multi-component chain, but over the REAL, existing
 * SCO data-model class `SC.Data.SalesOrder` (read-only w.r.t. the source table:
 * we never insert into it).
 *
 * Because the shared SalesOrder table's rows are uncontrolled (may be empty or
 * populated), this does NOT assert an exact `factCount` — only that the whole
 * chain wires up: discover properties → cube save/compile/build succeeds →
 * KPI builds → the value endpoint returns 200 with a numeric value. This proves
 * cube+KPI over a real SCO object works, without requiring a clean count.
 *
 * Stability: builds exactly ONE cube (see custom-object-flow for the rationale).
 *
 * Live IRIS required; run via the path-scoped script: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import {
  classPropertyNames,
  minimalCubeDef,
  deleteWorkbenchCube,
  runCleanups,
  uniqueSuffix,
  type Cleanup,
} from '../integration/helpers/provision.js';
import { sweep, healCubeRegistry } from '../integration/helpers/sweep.js';

const d = describe;

const SCO_CLASS = 'SC.Data.SalesOrder';

d('E2E: cube → KPI over a real existing SCO object (SC.Data.SalesOrder, read-only)', () => {
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

  it('builds a cube + KPI over SC.Data.SalesOrder and reads a numeric value (no exact count)', async () => {
    // 1. Discover real properties on the shipped SCO class (never assume names).
    const props = await classPropertyNames(app.iris, SCO_CLASS);
    expect(props, `${SCO_CLASS} exposes salesRegion + orderValue`).toEqual(
      expect.arrayContaining(['salesRegion', 'orderValue']),
    );

    // 2. Build a Workbench cube over the REAL SCO class (read-only on its table):
    //    dimension on salesRegion, SUM measure on orderValue.
    const cubeName = `WorkbenchTestSales${uniqueSuffix()}`;
    const def = minimalCubeDef(cubeName, SCO_CLASS, {
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'salesRegion', factNumber: 2 }] }],
        },
      ],
      measures: [
        { name: 'Total', sourceProperty: 'orderValue', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3 },
      ],
    } as never);
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));

    // 3. save/compile/build must all succeed; factCount is a number >= 0 (uncontrolled table).
    const built = await jsonOf<{ state: string; factCount: number; className: string }>(
      await post('/api/cubes/build', { definition: def }),
    );
    expect(built.state, JSON.stringify(built)).toBe('built');
    expect(built.className).toBe(`SC.Workbench.Cube.${cubeName}`);
    expect(typeof built.factCount).toBe('number');
    expect(built.factCount).toBeGreaterThanOrEqual(0);

    // 4. Build a KPI on the cube. Condition uses the dimension's `.Members` set,
    //    which resolves regardless of which region values exist in the table
    //    (no need to guess a specific member) — proven stable for this cube shape.
    const kpiName = `WorkbenchTestSalesKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(kpiName).catch(() => {}));
    const createdKpi = await post('/api/scbi/v1/kpi/definitions', {
      name: kpiName,
      label: 'E2E SalesOrder KPI',
      type: 'DeepSee',
      status: 'Active',
      deepseeKpiSpec: {
        namespace: 'SC',
        cube: cubeName,
        kpiMeasure: 'Total',
        valueType: 'raw',
        kpiConditions: ['[RegionD].[H1].[Region].Members'],
      },
    });
    expect([200, 201], await createdKpi.clone().text()).toContain(createdKpi.status);

    // 5. The value endpoint returns 200 with a numeric value (not a specific number).
    const valueRes = await fetch(`${app.base}/api/scbi/v1/kpi/values/${kpiName}`);
    expect(valueRes.status, await valueRes.clone().text()).toBe(200);
    const value = await jsonOf<{ values: Array<{ value: number | string }> }>(valueRes);
    expect(Array.isArray(value.values)).toBe(true);
    expect(value.values.length).toBeGreaterThan(0);
    expect(Number.isFinite(Number(value.values[0]!.value))).toBe(true);
  });

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
});
