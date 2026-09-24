/**
 * Vitest globalSetup for the live-IRIS test runs (integration + e2e). Runs a FULL
 * sweep ONCE before any suite starts and ONCE after all suites finish, so the run
 * begins and ends on a clean baseline.
 *
 * Why a full sweep, not just a cube-registry heal: a PRIOR run that was
 * interrupted (Ctrl-C) or crashed can leave `Workbench.Test.*` classes behind.
 * Their auto-assigned storage global is derived from a hash of the class name,
 * and a freshly-generated source class in the new run can hash-COLLIDE with a
 * leftover one — IRIS then refuses to compile it with
 * "#5564: Storage reference '…' is already registered for use by '…'". Deleting
 * the whole `Workbench.Test.*` package up front (what `sweep` does, along with
 * healing the cube registry and dropping stamped KPIs / custom objects) makes the
 * suite robust to an interrupted previous run.
 *
 * There is no env flag: the test tier is selected by PATH via the npm scripts
 * (`test:unit` → test/unit, `test:it` → test/integration, `test:e2e` → test/e2e).
 * The default `vitest run` include is scoped to `test/unit`, which does not need
 * this. This globalSetup is registered globally, so it is TOLERANT-ALWAYS: it
 * attempts the sweep and, if IRIS is unreachable (e.g. someone points a runner at
 * it without a live instance), swallows the failure and no-ops. It builds its own
 * IrisServices and closes them.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const clean = async () => {
    try {
      const { loadEnv } = await import('../../../src/config/env.js');
      const { createIrisServices } = await import('../../../src/iris/index.js');
      const { sweep } = await import('./sweep.js');
      const iris = createIrisServices(loadEnv());
      try {
        await sweep(iris);
      } finally {
        iris.close();
      }
    } catch {
      /* tolerant: never fail the run on hygiene / missing IRIS */
    }
  };

  await clean();
  // Returned teardown runs after the whole suite completes.
  return clean;
}
