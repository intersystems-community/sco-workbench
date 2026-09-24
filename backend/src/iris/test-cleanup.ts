import type { IrisServices } from './index.js';
import { killCube } from './cube-ops.js';
import { getProductionStatus, removeConfigItem, stopProduction } from './production-ops.js';

/**
 * Remove all temporary `Workbench.Test.*` artifacts from IRIS. Idempotent and
 * safe to run repeatedly. Only touches the Workbench.Test package, the test
 * cube, and the test production — nothing else.
 *
 * Returns a log of the actions taken so tests and the CLI can report them.
 */
export interface CleanupOptions {
  cubeName?: string;
  hostNames?: string[];
  testProduction?: string;
  packageName?: string;
}

const DEFAULTS = {
  cubeName: 'WorkbenchTestSource',
  hostNames: ['Workbench.Test.BS', 'Workbench.Test.BP'],
  testProduction: 'Workbench.Test.Production',
  packageName: 'Workbench.Test',
};

export async function cleanupTestArtifacts(iris: IrisServices, opts: CleanupOptions = {}): Promise<string[]> {
  const cubeName = opts.cubeName ?? DEFAULTS.cubeName;
  const hostNames = opts.hostNames ?? DEFAULTS.hostNames;
  const testProduction = opts.testProduction ?? DEFAULTS.testProduction;
  const packageName = opts.packageName ?? DEFAULTS.packageName;
  const log: string[] = [];
  const native = iris.native;

  // 1. Remove interop items from whatever production is active, then stop the
  //    throwaway test production if it is the active one.
  try {
    const status = getProductionStatus(native);
    if (status.productionName) {
      for (const host of hostNames) {
        const res = await removeConfigItem(native, iris.atelier, status.productionName, host);
        log.push(res.message);
      }
      if (status.productionName === testProduction && status.running) {
        const stopped = stopProduction(native, 10, 0);
        log.push(stopped.message);
      }
    } else {
      log.push('No active production; skipped interop cleanup.');
    }
  } catch (err) {
    log.push(`Production cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Drop each TEST cube's fact/index data, then delete its class (killing
  //    first, while the fact class exists, avoids orphaned fact globals). We
  //    target the specific cubes the suites create — NOT the whole
  //    SC.Workbench.Cube.* package — so a legitimate example/user cube seeded
  //    via `npm run seed:example-cube` is preserved.
  const TEST_CUBES = [cubeName, 'WorkbenchTestRestCube', 'WorkbenchTestCrud'];
  for (const c of TEST_CUBES) {
    try {
      const res = killCube(native, c);
      log.push(res.message);
    } catch (err) {
      log.push(`Cube kill (${c}) skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const status = native.callValue('%SYSTEM.OBJ', 'Delete', `SC.Workbench.Cube.${c}`, 'd');
      const decoded = native.decodeStatus(status);
      log.push(decoded.ok ? `Deleted cube class ${c}.` : `Delete of cube ${c} reported: ${decoded.text}`);
    } catch (err) {
      log.push(`Delete of cube ${c} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Delete the remaining test classes (interop hosts, source, test
  //    production) under the Workbench.Test package. "d" = delete class + code.
  try {
    const status = native.callValue('%SYSTEM.OBJ', 'Delete', `${packageName}.*`, 'd');
    const decoded = native.decodeStatus(status);
    log.push(decoded.ok ? `Deleted ${packageName}.*.` : `Delete of ${packageName}.* reported: ${decoded.text}`);
  } catch (err) {
    log.push(`Delete of ${packageName}.* skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Delete leftover custom data-model objects created by the e2e suites. The
  //    scmodel API is create-only, so the e2e tests delete the generated
  //    `SC.Data.WorkbenchTest*` class in their own cleanup — this is the manual /
  //    backstop purge for any that a crashed run left behind (deleting the class
  //    also removes the object from the scmodel list). Uses a LITERAL %STARTSWITH
  //    (a bound parameter does not match here) — the prefix is a constant.
  try {
    const objs = await iris.atelier.query<{ Name: string }>(
      `SELECT Name FROM %Dictionary.CompiledClass WHERE Name %STARTSWITH 'SC.Data.WorkbenchTest'`,
    );
    let removed = 0;
    for (const o of objs) {
      try {
        native.callValue('%SYSTEM.OBJ', 'Delete', o.Name, 'd-d');
        removed += 1;
      } catch {
        /* tolerant */
      }
    }
    log.push(`Deleted ${removed}/${objs.length} SC.Data.WorkbenchTest* custom objects.`);
  } catch (err) {
    log.push(`Custom-object cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return log;
}
