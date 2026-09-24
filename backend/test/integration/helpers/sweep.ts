/**
 * afterAll backstop: remove any `Workbench.Test.*` artifacts a per-test cleanup
 * missed (e.g. a teardown that itself threw), so the instance is left as clean
 * as it was found. Tolerant of already-absent artifacts. Also drops any KPI
 * definitions whose name carries the run stamp.
 */
import type { IrisServices } from '../../../src/iris/index.js';

/**
 * Delete the whole `Workbench.Test.*` package (classes, cubes, fact data via the
 * cube kill that cleanupTestArtifacts performs) and any run-stamped KPI defs.
 * `namePrefix` matches the KPI/cube names the provisioners generate
 * (`WorkbenchTest*`).
 */
export async function sweep(iris: IrisServices, namePrefix = 'WorkbenchTest'): Promise<void> {
  // 1. Drop the non-cube test classes (interop hosts, sources, productions).
  //    Cube classes are NOT deleted here — deleting a cube class with a raw
  //    %SYSTEM.OBJ.Delete (no %KillCube) orphans its ^DeepSee.Cubes registry
  //    entry, which then makes EVERY later %BuildCube fail in %PurgeDSTIME with
  //    "<CLASS DOES NOT EXIST>". Cube classes are removed by healCubeRegistry in
  //    step 3, which kills (deregisters) BEFORE deleting.
  try {
    iris.native.callValue('%SYSTEM.OBJ', 'Delete', 'Workbench.Test.*', 'd');
  } catch {
    /* tolerant */
  }
  // 2. Delete any leftover run-stamped KPI definitions.
  try {
    const kpis = await iris.kpi.list();
    for (const kpi of kpis) {
      if (typeof kpi.name === 'string' && kpi.name.startsWith(namePrefix)) {
        await iris.kpi.delete(kpi.name).catch(() => {});
      }
    }
  } catch {
    /* tolerant: KPI API may be unreachable during teardown */
  }
  // 2b. Backstop for custom scmodel objects. The scmodel API is create-only, so
  //     the e2e suites delete the generated `SC.Data.<name>` class in their own
  //     cleanup — but as a safety net (a missed per-test cleanup would otherwise
  //     leak an object and slow the scmodel list call on every future run), drop
  //     any leftover `SC.Data.<namePrefix>*` classes here too. Deleting the class
  //     removes the object from the scmodel list (verified against live IRIS).
  try {
    // NOTE: %STARTSWITH with a BOUND parameter does not match here (returns 0);
    // a literal does. `namePrefix` is our own constant (not user input), so it is
    // safe to inline. Single-quotes are stripped defensively.
    const safePrefix = `SC.Data.${namePrefix}`.replace(/'/g, '');
    const objs = await iris.atelier.query<{ Name: string }>(
      `SELECT Name FROM %Dictionary.CompiledClass WHERE Name %STARTSWITH '${safePrefix}'`,
    );
    for (const o of objs) {
      try {
        iris.native.callValue('%SYSTEM.OBJ', 'Delete', o.Name, 'd-d');
      } catch {
        /* tolerant */
      }
    }
  } catch {
    /* tolerant */
  }
  // 3. Deregister + delete every lingering test cube via the registry heal. This
  //    runs LAST so it is the sole remover of cube classes — nothing after it can
  //    re-orphan the registry. It kills (deregisters + drops data) each cube
  //    before deleting its class, leaving the registry clean.
  try {
    await healCubeRegistry(iris, namePrefix);
  } catch {
    /* tolerant: registry shape differences must never fail teardown */
  }
}

/**
 * Heal the DeepSee cube registry: walk `^DeepSee.Cubes("cubes", <CUBENAME>)` and,
 * for every test cube (name starting with `namePrefix`, upper-cased in the
 * registry), do a best-effort `%KillCube`, force-remove the registry entries, and
 * delete the cube class. This clears the orphaned-registry state a crashed or
 * interrupted run can leave, which otherwise makes EVERY later `%BuildCube` fail
 * in `%PurgeDSTIME` with "<CLASS DOES NOT EXIST>".
 *
 * Run this BOTH at suite start (`beforeAll`, so a run that begins dirty self-heals
 * before the first build) AND at the end (`afterAll` sweep). The helper lives
 * under `Workbench.Test.*` so the package delete removes it.
 */
export async function healCubeRegistry(iris: IrisServices, namePrefix = 'WorkbenchTest'): Promise<void> {
  const helperClass = 'Workbench.Test.SweepHelper';
  const upper = namePrefix.toUpperCase();
  const src = `Class ${helperClass} Extends %RegisteredObject
{
ClassMethod Purge(prefix As %String) As %Integer
{
  Set n=0, names=""
  Set k="" For { Set k=$Order(^DeepSee.Cubes("cubes",k)) Quit:k=""  If ($ZConvert(k,"U")[prefix) { Set names=names_k_$Char(1) } }
  For i=1:1:$Length(names,$Char(1))-1 {
    Set cubeName=$Piece(names,$Char(1),i)
    Set cls=$Get(^DeepSee.Cubes("cubes",cubeName))
    Try { Do ##class(%DeepSee.Utils).%KillCube(cubeName) } Catch {}
    Kill ^DeepSee.Cubes("cubes",cubeName)
    If cls'="" { Kill ^DeepSee.Cubes("classes",$ZConvert(cls,"U"))  Try { Do ##class(%SYSTEM.OBJ).Delete(cls,"d-d") } Catch {} }
    Set n=n+1
  }
  Quit n
}
}`;
  const compiled = await iris.atelier.importAndCompile(helperClass, src);
  if (!compiled.ok) return;
  try {
    iris.native.callValue(helperClass, 'Purge', upper);
  } catch {
    /* tolerant */
  } finally {
    // Remove the throwaway helper so heal leaves nothing behind (it lives under
    // Workbench.Test but must be gone even when heal runs without a later sweep).
    try {
      iris.native.callValue('%SYSTEM.OBJ', 'Delete', helperClass, 'd-d');
    } catch {
      /* tolerant */
    }
  }
}
