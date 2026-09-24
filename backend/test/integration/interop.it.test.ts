/**
 * Interoperability deploy paths (business process onto a production; SQL-adapter
 * pipeline with Java-Gateway ref-counting) against a live IRIS. NON-INVASIVE: it
 * never stops or replaces a production you already have running — it starts its
 * own throwaway `Workbench.Test.Production` only if none is active, and stops it
 * afterward. Self-cleaning via cleanupTestArtifacts in afterAll.
 *
 * The cube / schema / KPI / data-model coverage that used to live alongside this
 * has moved to the independent, self-provisioning suites (cube.it / kpi.it /
 * data-model.it / schema.it). Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { createIrisServices, type IrisServices } from '../../src/iris/index.js';
import {
  getProductionStatus,
  addOrUpdateConfigItem,
  startProduction,
  stopProduction,
  listConfigItems,
  readConfigItemSettings,
  removeConfigItem,
} from '../../src/iris/production-ops.js';
import { cleanupTestArtifacts } from '../../src/iris/test-cleanup.js';
import {
  BUSINESS_PROCESS_CLASS,
  BUSINESS_PROCESS_CLS,
  TEST_PRODUCTION,
  TEST_PRODUCTION_CLS,
  TEST_PREEXISTING_ITEM,
  TEST_JAVA_GATEWAY_ITEM,
  TEST_SQL_SERVICE_A,
  TEST_SQL_SERVICE_B,
  JAVA_GATEWAY_CLASS,
  SQL_GENERIC_SERVICE_CLASS,
} from '../fixtures/test-classes.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('IRIS interop deploy (live)', () => {
  let iris: IrisServices;

  beforeAll(() => {
    iris = createIrisServices(loadEnv());
  });

  afterAll(async () => {
    if (!iris) return;
    await cleanupTestArtifacts(iris, {
      hostNames: [
        BUSINESS_PROCESS_CLASS,
        TEST_PREEXISTING_ITEM,
        'Workbench.Test.Added',
        TEST_SQL_SERVICE_A,
        TEST_SQL_SERVICE_B,
        TEST_JAVA_GATEWAY_ITEM,
      ],
      testProduction: TEST_PRODUCTION,
    });
    iris.close();
  });

  it('compiles a business process, deploys+enables it on a production', async () => {
    const bpCompile = await iris.atelier.importAndCompile(BUSINESS_PROCESS_CLASS, BUSINESS_PROCESS_CLS);
    expect(bpCompile.ok, bpCompile.errors.join('\n')).toBe(true);

    const prodCompile = await iris.atelier.importAndCompile(TEST_PRODUCTION, TEST_PRODUCTION_CLS);
    expect(prodCompile.ok, prodCompile.errors.join('\n')).toBe(true);
    const before = getProductionStatus(iris.native);
    const startedOurs = !before.running;
    if (startedOurs) {
      const started = startProduction(iris.native, TEST_PRODUCTION);
      expect(started.ok, started.message).toBe(true);
    }

    const NEW_ITEM = 'Workbench.Test.Added';
    const added = await addOrUpdateConfigItem(iris.native, iris.atelier, {
      productionName: TEST_PRODUCTION,
      className: BUSINESS_PROCESS_CLASS,
      name: NEW_ITEM,
    });
    expect(added.ok, added.message).toBe(true);

    const readItems = async () =>
      iris.atelier.query<{ Name: string; Enabled: number | boolean }>(
        'SELECT Name, Enabled FROM Ens_Config.Item WHERE Production = ? ORDER BY Name',
        [TEST_PRODUCTION],
      );
    let rows = await readItems();
    const byName = Object.fromEntries(rows.map((r) => [r.Name, Boolean(r.Enabled)]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining([TEST_PREEXISTING_ITEM, NEW_ITEM]));
    expect(byName[NEW_ITEM], 'new item disabled by default').toBe(false);
    expect(byName[TEST_PREEXISTING_ITEM] !== undefined, 'pre-existing item preserved').toBe(true);

    const updated = await addOrUpdateConfigItem(iris.native, iris.atelier, {
      productionName: TEST_PRODUCTION,
      className: BUSINESS_PROCESS_CLASS,
      name: NEW_ITEM,
      enabled: true,
    });
    expect(updated.ok, updated.message).toBe(true);
    rows = await readItems();
    const added2 = rows.filter((r) => r.Name === NEW_ITEM);
    expect(added2, 'no duplicate on update').toHaveLength(1);
    expect(Boolean(added2[0]!.Enabled), 'now enabled').toBe(true);

    if (startedOurs) stopProduction(iris.native, 10, 0);
  });

  it('SQL pipeline: settings upsert, list, and delete with Java Gateway ref-counting', async () => {
    const prodCompile = await iris.atelier.importAndCompile(TEST_PRODUCTION, TEST_PRODUCTION_CLS);
    expect(prodCompile.ok, prodCompile.errors.join('\n')).toBe(true);
    const before = getProductionStatus(iris.native);
    const startedOurs = !before.running;
    if (startedOurs) {
      const started = startProduction(iris.native, TEST_PRODUCTION);
      expect(started.ok, started.message).toBe(true);
    }

    const gw = await addOrUpdateConfigItem(iris.native, iris.atelier, {
      productionName: TEST_PRODUCTION,
      className: JAVA_GATEWAY_CLASS,
      name: TEST_JAVA_GATEWAY_ITEM,
      poolSize: 1,
      settings: [{ name: '%gatewayName', target: 'Host', value: '%JDBC Server' }],
    });
    expect(gw.ok, gw.message).toBe(true);

    const svcA = await addOrUpdateConfigItem(iris.native, iris.atelier, {
      productionName: TEST_PRODUCTION,
      className: SQL_GENERIC_SERVICE_CLASS,
      name: TEST_SQL_SERVICE_A,
      poolSize: 1,
      settings: [
        { name: 'DSN', target: 'Adapter', value: 'jdbc:IRIS://localhost:1972/SC' },
        { name: 'Query', target: 'Adapter', value: 'SELECT id FROM orders' },
        { name: 'JGService', target: 'Host', value: TEST_JAVA_GATEWAY_ITEM },
        { name: 'MessageClass', target: 'Host', value: BUSINESS_PROCESS_CLASS },
      ],
    });
    expect(svcA.ok, svcA.message).toBe(true);

    let sA = readConfigItemSettings(iris.native, TEST_PRODUCTION, TEST_SQL_SERVICE_A);
    const byName = (arr: typeof sA, name: string, target: 'Adapter' | 'Host') =>
      arr.find((s) => s.name === name && s.target === target)?.value;
    expect(byName(sA, 'DSN', 'Adapter')).toBe('jdbc:IRIS://localhost:1972/SC');
    expect(byName(sA, 'Query', 'Adapter')).toBe('SELECT id FROM orders');
    expect(byName(sA, 'JGService', 'Host')).toBe(TEST_JAVA_GATEWAY_ITEM);

    const svcA2 = await addOrUpdateConfigItem(iris.native, iris.atelier, {
      productionName: TEST_PRODUCTION,
      className: SQL_GENERIC_SERVICE_CLASS,
      name: TEST_SQL_SERVICE_A,
      settings: [{ name: 'Query', target: 'Adapter', value: 'SELECT id, status FROM orders' }],
    });
    expect(svcA2.ok, svcA2.message).toBe(true);
    sA = readConfigItemSettings(iris.native, TEST_PRODUCTION, TEST_SQL_SERVICE_A);
    expect(sA.filter((s) => s.name === 'Query' && s.target === 'Adapter'), 'Query not duplicated').toHaveLength(1);
    expect(byName(sA, 'Query', 'Adapter')).toBe('SELECT id, status FROM orders');
    expect(byName(sA, 'DSN', 'Adapter')).toBe('jdbc:IRIS://localhost:1972/SC');

    const svcB = await addOrUpdateConfigItem(iris.native, iris.atelier, {
      productionName: TEST_PRODUCTION,
      className: SQL_GENERIC_SERVICE_CLASS,
      name: TEST_SQL_SERVICE_B,
      poolSize: 1,
      settings: [{ name: 'JGService', target: 'Host', value: TEST_JAVA_GATEWAY_ITEM }],
    });
    expect(svcB.ok, svcB.message).toBe(true);

    const items = listConfigItems(iris.native, TEST_PRODUCTION);
    const mine = Object.fromEntries(items.map((i) => [i.name, i.className]));
    expect(mine[TEST_JAVA_GATEWAY_ITEM]).toBe(JAVA_GATEWAY_CLASS);
    expect(mine[TEST_SQL_SERVICE_A]).toBe(SQL_GENERIC_SERVICE_CLASS);
    expect(mine[TEST_SQL_SERVICE_B]).toBe(SQL_GENERIC_SERVICE_CLASS);

    const delA = await removeConfigItem(iris.native, iris.atelier, TEST_PRODUCTION, TEST_SQL_SERVICE_A);
    expect(delA.ok, delA.message).toBe(true);
    let after = listConfigItems(iris.native, TEST_PRODUCTION);
    expect(after.some((i) => i.name === TEST_JAVA_GATEWAY_ITEM), 'gateway kept while B remains').toBe(true);
    expect(after.some((i) => i.name === TEST_SQL_SERVICE_A), 'A removed').toBe(false);

    const delB = await removeConfigItem(iris.native, iris.atelier, TEST_PRODUCTION, TEST_SQL_SERVICE_B);
    expect(delB.ok, delB.message).toBe(true);
    const delGw = await removeConfigItem(iris.native, iris.atelier, TEST_PRODUCTION, TEST_JAVA_GATEWAY_ITEM);
    expect(delGw.ok, delGw.message).toBe(true);
    after = listConfigItems(iris.native, TEST_PRODUCTION);
    expect(after.some((i) => i.name === TEST_JAVA_GATEWAY_ITEM), 'gateway removed as last SQL pipeline').toBe(false);

    if (startedOurs) stopProduction(iris.native, 10, 0);
  });
});
