/**
 * Self-provisioning primitives for the live-IRIS integration suites.
 *
 * The suites assume a CLEAN SCO instance: default SCO cubes/data model exist,
 * but there are NO user KPIs, NO custom (Workbench) cubes, and tables may be
 * empty. So each test builds exactly what it needs here, with a run-unique name,
 * and registers a cleanup so nothing is left behind — even if the test throws.
 *
 * All artifacts live under the `Workbench.Test` package so the afterAll sweep
 * ([sweep.ts]) can reclaim anything a per-test cleanup missed.
 */
import type { IrisServices } from '../../../src/iris/index.js';
import { generateCubeClass, cubeClassName } from '../../../src/cube/cube-generator.js';
import { buildCube, killCube } from '../../../src/iris/cube-ops.js';
import type { CubeDefinition, CubeDimension } from '../../../src/cube/cube-definition.model.js';

/**
 * Remove a Workbench cube in the CORRECT order: %KillCube first (deregisters it
 * from the DeepSee cube registry + drops fact data), THEN delete the class.
 * Deleting the class first orphans the registry entry (^DeepSee.Cubes), and a
 * single orphan makes EVERY later %BuildCube fail in %PurgeDSTIME. Use this in
 * every test cleanup instead of a bare %SYSTEM.OBJ.Delete. Tolerant of absence.
 */
export function deleteWorkbenchCube(iris: IrisServices, cubeName: string): void {
  try {
    killCube(iris.native, cubeName);
  } catch {
    /* tolerant: cube may not exist / already killed */
  }
  try {
    iris.native.callValue('%SYSTEM.OBJ', 'Delete', cubeClassName(cubeName), 'd');
  } catch {
    /* tolerant */
  }
}

/** Package all test classes live under (matches the sweep + cleanupTestArtifacts). */
export const TEST_PACKAGE = 'Workbench.Test';

/**
 * A per-run stamp keeps names unique across repeat/parallel runs. `WORKBENCH_IT_STAMP`
 * can pin it in CI; otherwise a process-based suffix is used. NOT time-based
 * (kept deterministic within a run) — a monotonic counter guarantees uniqueness
 * within the process.
 */
const STAMP = process.env.WORKBENCH_IT_STAMP || `IT${process.pid % 100000}`;
let counter = 0;
/** A fresh, unique, IRIS-identifier-safe suffix for one artifact. */
export function uniqueSuffix(): string {
  counter += 1;
  return `${STAMP}x${counter}`;
}

/**
 * Process token for `storageSafeSuffix`, as a number below 36^3 so it renders in
 * 3 base-36 chars. Derived from the pinned stamp when CI sets one (so two pinned
 * runs still differ), otherwise from the pid.
 */
const PROC36 = ((): number => {
  const pin = process.env.WORKBENCH_IT_STAMP;
  if (!pin) return process.pid % 46656;
  let h = 0;
  for (let i = 0; i < pin.length; i += 1) h = (h * 31 + pin.charCodeAt(i)) % 46656;
  return h;
})();

/**
 * A unique suffix for a class that will CARRY STORAGE (i.e. `Extends %Persistent`).
 * Use this instead of `uniqueSuffix` for those, and keep the prefix it is appended
 * to at SIX CHARACTERS OR FEWER.
 *
 * Why: IRIS derives a persistent class's default storage global from only the
 * FIRST 11 CHARACTERS of the class name plus a weak 5-char hash of the remainder.
 * `uniqueSuffix` puts its entropy past that boundary — `Workbench.Test.SourceIT27639x1`
 * and `…SourceIT27635x4` are identical through `SourceIT276`, and their remainders
 * hash to the same value often enough to bite in practice, so the second class
 * fails to compile with:
 *
 *   #5564: Storage reference '^WorkbenchF784.SourceIT2767529D' used in
 *   'Workbench.Test.SourceIT27639x1.cls' is already registered for use by
 *   'Workbench.Test.SourceIT27635x4.cls'
 *
 * vitest gives each test file its own worker and worker pids are consecutive, so
 * those leading digits match constantly — this was failing ~1 run in 3.
 *
 * The fix is to fit the whole distinguishing part inside the 11-char budget:
 * `PROC36 * 1296 + counter` maxes out at exactly 36^5 - 1, so this is ALWAYS 5
 * base-36 chars, making `Source` + suffix an 11-char name that survives
 * truncation intact and yields a unique global by construction.
 */
export function storageSafeSuffix(): string {
  counter += 1;
  return (PROC36 * 1296 + (counter % 1296)).toString(36).padStart(5, '0');
}

/** A cleanup thunk; safe to call once, tolerant of already-absent artifacts. */
export type Cleanup = () => Promise<void> | void;

/**
 * Run a set of cleanups in REVERSE registration order, each guarded so one
 * failure never blocks the rest. Use in afterEach with the cleanups a test
 * registered. Returns a log of any errors (for optional visibility).
 */
export async function runCleanups(cleanups: Cleanup[]): Promise<string[]> {
  const errors: string[] = [];
  for (const fn of [...cleanups].reverse()) {
    try {
      await fn();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return errors;
}

/** A source persistent class provisioned for a test. */
export interface SeededSource {
  /** Fully-qualified class name, e.g. `Workbench.Test.SourceIT1`. */
  className: string;
  /** Short SQL-friendly name segment. */
  shortName: string;
  /** Rows seeded (0 when `seedRows:false`). */
  rowCount: number;
  cleanup: Cleanup;
}

const SOURCE_ROWS = 20;

/**
 * Import + compile a unique persistent class with a `Seed()` that inserts a
 * deterministic set of rows, then (unless `seedRows:false`) seed it. Pass
 * `seedRows:false` for the empty-table baseline test.
 */
export async function seedSource(
  iris: IrisServices,
  opts: { seedRows?: boolean } = {},
): Promise<SeededSource> {
  const seedRows = opts.seedRows !== false;
  // storageSafeSuffix, NOT uniqueSuffix: this class is %Persistent, so its name
  // must be unique within the first 11 chars — `Source` + 5 = exactly 11.
  const className = `${TEST_PACKAGE}.Source${storageSafeSuffix()}`;
  const source = sourceClass(className);
  const compiled = await iris.atelier.importAndCompile(className, source);
  if (!compiled.ok) {
    throw new Error(`Failed to compile test source ${className}: ${compiled.errors.join('; ')}`);
  }
  let rowCount = 0;
  if (seedRows) {
    const status = iris.native.callValue(className, 'Seed');
    const decoded = iris.native.decodeStatus(status);
    if (!decoded.ok) throw new Error(`Seed failed for ${className}: ${decoded.text}`);
    rowCount = SOURCE_ROWS;
  }
  return {
    className,
    shortName: className.split('.').pop() as string,
    rowCount,
    cleanup: () => {
      try {
        iris.native.callValue('%SYSTEM.OBJ', 'Delete', className, 'd');
      } catch {
        /* tolerant: already gone */
      }
    },
  };
}

/** A Workbench cube provisioned (compiled + built) for a test. */
export interface BuiltCube {
  cubeName: string;
  className: string;
  factCount: number;
  cleanup: Cleanup;
}

/**
 * Generate + compile + build a minimal Workbench cube over `source`. The cube
 * has one data dimension (Region) and one SUM measure (Amount). Returns the
 * built cube plus a cleanup that kills the cube data and deletes the class.
 */
export async function buildTestCube(
  iris: IrisServices,
  source: SeededSource,
  overrides: Partial<CubeDefinition> = {},
): Promise<BuiltCube> {
  const cubeName = `WorkbenchTestCube${uniqueSuffix()}`;
  const def = minimalCubeDef(cubeName, source.className, overrides);
  const className = cubeClassName(cubeName);
  const cls = generateCubeClass(def);
  const compiled = await iris.atelier.importAndCompile(className, cls);
  if (!compiled.ok) {
    throw new Error(`Failed to compile cube ${cubeName}: ${compiled.errors.join('; ')}`);
  }
  const built = buildCube(iris.native, cubeName);
  if (!built.ok) throw new Error(`Failed to build cube ${cubeName}: ${built.message}`);
  return {
    cubeName,
    className,
    factCount: built.factCount ?? 0,
    // Correct order: %KillCube (deregister + drop data) BEFORE deleting the class.
    cleanup: () => deleteWorkbenchCube(iris, cubeName),
  };
}

/** A KPI created via the SCO scbi REST client for a test. */
export interface MadeKpi {
  name: string;
  cleanup: Cleanup;
}

/**
 * The measure and a valid MDX member condition for the cube `buildTestCube`
 * creates (measure `Total`, dimension `RegionD.[H1].[Region]`, seeded with
 * North/South/East members). Using a REAL measure + a REAL member reference is
 * essential: a KPI built with `%COUNT` / `%ALL` is NOT queryable — the scbi
 * value endpoint 500s on those pseudo-inputs (unrelated to SC-2643). These match
 * how the product's own UI builds a KPI, so the KPI is genuinely queryable.
 */
export const TEST_CUBE_MEASURE = 'Total';
export const TEST_CUBE_CONDITION = '[RegionD].[H1].[Region].&[North]';

/**
 * Create a queryable raw KPI over `cube` via the SCO KPI REST client, and
 * register a cleanup that deletes it. Uses the cube's real `Total` measure and a
 * valid member condition so `GET /kpi/values/{name}` actually returns a value.
 */
export async function makeTestKpi(iris: IrisServices, cube: BuiltCube): Promise<MadeKpi> {
  const name = `WorkbenchTestKpi${uniqueSuffix()}`;
  await iris.kpi.create({
    name,
    label: 'IT KPI',
    type: 'DeepSee',
    status: 'Active',
    deepseeKpiSpec: {
      namespace: iris.namespace,
      cube: cube.cubeName,
      kpiMeasure: TEST_CUBE_MEASURE,
      valueType: 'raw',
      kpiConditions: [TEST_CUBE_CONDITION],
    },
  } as never);
  return {
    name,
    cleanup: async () => {
      try {
        await iris.kpi.delete(name);
      } catch {
        /* tolerant: already gone */
      }
    },
  };
}

/**
 * The default Region data dimension `minimalCubeDef` ships — one leaf level over the
 * source's `Region` property. Exported so a test that overrides `dimensions` can keep
 * Region alongside an added dimension (the override REPLACES the array, it does not merge).
 */
export const REGION_DIMENSION: CubeDimension = {
  name: 'RegionD',
  type: 'data',
  hasAll: true,
  hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }],
};

/**
 * A data dimension over the source's NULLABLE `Segment` property (every third seeded row
 * leaves it unset — see `sourceClass`'s `Seed`). With no `nullReplacement`, IRIS forms a
 * real `<null>` member, so `is null` / `is not null` conditions have rows on BOTH sides.
 * Use with `buildTestCube(..., { dimensions: [REGION_DIMENSION, NULLABLE_SEGMENT_DIMENSION] })`.
 */
export const NULLABLE_SEGMENT_DIMENSION: CubeDimension = {
  name: 'SegmentD',
  type: 'data',
  hasAll: true,
  hierarchies: [{ name: 'H1', levels: [{ name: 'Segment', sourceProperty: 'Segment', factNumber: 4 }] }],
};

/** MDX level spec for `NULLABLE_SEGMENT_DIMENSION`'s single Segment level. */
export const TEST_CUBE_NULLABLE_LEVEL = '[SegmentD].[H1].[Segment]';

/** Minimal cube definition over a source class: Region dimension + Amount SUM measure. */
export function minimalCubeDef(
  cubeName: string,
  sourceClass: string,
  overrides: Partial<CubeDefinition> = {},
): CubeDefinition {
  return {
    cubeName,
    sourceClass,
    description: 'Integration-test cube',
    // Deep-copy the shared REGION_DIMENSION: a test that mutates its dimension in place
    // (e.g. cube-invalid's CI3 sets levels[0].factNumber = 1) would otherwise corrupt the
    // module-level singleton and poison every later minimalCubeDef consumer.
    dimensions: [structuredClone(REGION_DIMENSION)],
    measures: [
      { name: 'Total', sourceProperty: 'Amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3 },
    ],
    ...overrides,
  } as CubeDefinition;
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E multi-component helpers (custom scmodel object + generic row loader)
// ─────────────────────────────────────────────────────────────────────────────

/** One attribute of a custom scmodel object, as the create API expects it. */
export interface CustomAttr {
  name: string;
  dataType: 'String' | 'Integer' | 'Boolean' | 'Numeric' | 'DateTime' | 'Date';
  required?: boolean;
  description?: string;
}

/** A custom scmodel object created for a test. */
export interface CustomObject {
  objectName: string;
  /** SCO-generated persistent class, discovered from the create/detail response (e.g. `SC.Data.<objectName>`). */
  className: string;
  /** Real IRIS property names on the class (attributes + SCO auto-fields like `uid`). */
  props: string[];
  /**
   * Remove the object. The scmodel REST API is create-only, but deleting the
   * generated `SC.Data.<name>` class directly (data + class) DOES remove it from
   * the scmodel object list — verified against live IRIS. Without this, every run
   * would leak a custom object and the scmodel create/list call (which enumerates
   * ALL custom objects) slows until it times out. Tolerant of absence.
   */
  cleanup: Cleanup;
}

/**
 * Create a custom data-model object via the SCO scmodel API (through the app
 * proxy, so auth + the real path are exercised), then DISCOVER its generated
 * class name and real property names by reading the object detail + `%Dictionary`
 * (`listProperties`). This discovery is itself a tested seam: SCO owns the class
 * name (`SC.Data.<objectName>`) and adds required fields (notably a `uid` primary
 * key) beyond the attributes you send.
 *
 * NOTE: scmodel is CREATE-ONLY — the object cannot be deleted via the API, so it
 * LEAKS (unique-named, disposable). No cleanup is registered for the object
 * itself; callers should still clean up any cube/KPI/loader built on top of it.
 */
export async function createCustomObject(
  app: { base: string; iris: IrisServices },
  attributes: CustomAttr[],
  opts: { objectName?: string } = {},
): Promise<CustomObject> {
  const iris = app.iris;
  const objectName = opts.objectName ?? `WorkbenchTestObj${uniqueSuffix()}`;
  const body = {
    objectName,
    description: 'e2e custom object',
    attributes: attributes.map((a) => ({
      name: a.name,
      dataType: a.dataType,
      required: a.required ? 1 : 0,
      description: a.description ?? a.name,
    })),
  };
  const created = await fetch(`${app.base}/api/scmodel/v1/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (![200, 201].includes(created.status)) {
    throw new Error(`createCustomObject(${objectName}) failed: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`);
  }
  const detailRes = await fetch(`${app.base}/api/scmodel/v1/objects/${encodeURIComponent(objectName)}`);
  const detail = (await detailRes.json()) as { className?: string };
  const className = detail.className;
  if (!className) {
    throw new Error(`createCustomObject(${objectName}): no className in detail response`);
  }
  // Discover the REAL IRIS property names (attributes + SCO auto-fields like uid).
  const props = await classPropertyNames(iris, className);
  const cleanup: Cleanup = () => {
    try {
      // Deleting the generated class removes the object from the scmodel list too.
      // Flags 'd-d' = delete class + data, and don't recompile dependent classes
      // (matches what reliably deletes these in bulk; plain 'd' can leave some).
      iris.native.callValue('%SYSTEM.OBJ', 'Delete', className, 'd-d');
    } catch {
      /* tolerant: already gone */
    }
  };
  return { objectName, className, props, cleanup };
}

/** Resolve the real IRIS property names on a class (attributes + SCO auto-fields). */
export async function classPropertyNames(iris: IrisServices, className: string): Promise<string[]> {
  const { listProperties } = await import('../../../src/iris/schema-ops.js');
  const props = await listProperties(iris.atelier, className);
  return props.map((p) => p.name);
}

/** A row loaded into a target class: property name → value. `uid` is auto-filled if omitted. */
export type LoadRow = Record<string, string | number | boolean>;

/** Result of a generic load: rows attempted vs. saved, plus a cleanup for the loader class. */
export interface LoadResult {
  attempted: number;
  saved: number;
  /** Per-row `%Status` decode failures (empty on full success). */
  failures: string[];
  cleanup: Cleanup;
}

/**
 * Insert rows into a PRE-EXISTING persistent class (e.g. a custom scmodel object)
 * generically. No existing seeder does this — every other one authors a class
 * with its own `Seed()`. This compiles a throwaway `Workbench.Test.Loader<suffix>`
 * whose `LoadOne` classmethod does `%New()` / `$PROPERTY(obj,k)=v` per field /
 * `%Save()`, invoked over the Native SDK, so any compiled class can be loaded.
 *
 * SCO custom objects have a REQUIRED `uid` primary key — if a row omits `uid`, a
 * unique one is generated. Each row's `%Status` is decoded: a failed save (e.g. a
 * type mismatch) is recorded in `failures` rather than throwing, so callers can
 * assert partial-failure behavior. `saved` is the count that actually persisted.
 */
export async function seedRowsInto(
  iris: IrisServices,
  className: string,
  rows: LoadRow[],
): Promise<LoadResult> {
  const loaderCls = `${TEST_PACKAGE}.Loader${uniqueSuffix()}`;
  const src = `Class ${loaderCls} Extends %RegisteredObject
{

/// Set each field from a two-column "key\\x01value\\x02key\\x01value" packed string,
/// then %Save(). Returns the %Status so the caller can decode per-row failures.
ClassMethod LoadOne(cls As %String, packed As %String) As %Status
{
    Set obj = $CLASSMETHOD(cls, "%New")
    For i=1:1:$Length(packed, $Char(2)) {
        Set pair = $Piece(packed, $Char(2), i)
        Continue:pair=""
        Set key = $Piece(pair, $Char(1), 1)
        Set val = $Piece(pair, $Char(1), 2)
        Set $PROPERTY(obj, key) = val
    }
    Quit obj.%Save()
}

}`;
  const compiled = await iris.atelier.importAndCompile(loaderCls, src);
  if (!compiled.ok) {
    throw new Error(`seedRowsInto: loader compile failed: ${compiled.errors.join('; ')}`);
  }
  const cleanup: Cleanup = () => {
    try {
      iris.native.callValue('%SYSTEM.OBJ', 'Delete', loaderCls, 'd');
    } catch {
      /* tolerant */
    }
  };

  const failures: string[] = [];
  let saved = 0;
  rows.forEach((row, idx) => {
    const withUid: LoadRow = 'uid' in row ? row : { uid: `${loaderCls}-${idx}`, ...row };
    // Pack fields as key\x01value pairs joined by \x02 (avoids arg-count limits and
    // keeps types simple — IRIS coerces on property set / validates on %Save).
    const packed = Object.entries(withUid)
      .map(([k, v]) => `${k}${String.fromCharCode(1)}${String(v)}`)
      .join(String.fromCharCode(2));
    const status = iris.native.callValue(loaderCls, 'LoadOne', className, packed);
    const decoded = iris.native.decodeStatus(status);
    if (decoded.ok) saved += 1;
    else failures.push(decoded.text);
  });

  return { attempted: rows.length, saved, failures, cleanup };
}

/** Exact live row count of a persistent class via SQL COUNT(*) (clean-state check). */
export async function countRowsOf(iris: IrisServices, className: string): Promise<number> {
  const parts = className.split('.');
  const table = `${parts.slice(0, -1).join('_')}.${parts[parts.length - 1]}`;
  const rows = await iris.atelier.query<{ cnt: number | string }>(`SELECT COUNT(*) AS cnt FROM ${table}`);
  return Number(rows[0]?.cnt ?? 0);
}

/** A tiny persistent class with a Seed() inserting deterministic rows. */
function sourceClass(className: string): string {
  return `Class ${className} Extends %Persistent
{

Property Region As %String;

Property Product As %String;

Property Segment As %String;

Property Amount As %Numeric;

Property SaleDate As %Date;

/// Populate ${SOURCE_ROWS} deterministic sample rows for cube tests.
ClassMethod Seed() As %Status
{
    Do ..%KillExtent()
    Set regions = $ListBuild("North","South","East","East")
    Set products = $ListBuild("Widget","Gadget","Gizmo","Doohickey")
    For i=1:1:${SOURCE_ROWS} {
        Set obj = ..%New()
        Set obj.Region = $List(regions, (i#4)+1)
        Set obj.Product = $List(products, (i#4)+1)
        If (i#3)'=0 { Set obj.Segment = $List($ListBuild("Retail","Wholesale"),(i#2)+1) }
        Set obj.Amount = (i*10)+((i#3)*5)
        Set obj.SaleDate = +$Horolog - (i*3)
        Set sc = obj.%Save()
        If $$$ISERR(sc) Return sc
    }
    Return $$$OK
}

}`;
}
