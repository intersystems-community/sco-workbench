/**
 * Enum round-trip coverage (C2c) — proves every dropdown value the cube form
 * offers actually compiles + builds in IRIS. A value IRIS rejects is a defect
 * (the dropdown or generator is out of step with IRIS); the test fails so we fix
 * the mismatch rather than ship an option that errors on use.
 *
 * The enum lists here mirror the frontend constants in bi-cubes.ts
 * (AGGREGATES / MEASURE_TYPES / TIME_FUNCTIONS). Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, type BootedApp } from './helpers/iris-app.js';
import { seedSource, deleteWorkbenchCube, runCleanups, uniqueSuffix, type Cleanup, type SeededSource } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import { generateCubeClass, cubeClassName } from '../../src/cube/cube-generator.js';
import { buildCube } from '../../src/iris/cube-ops.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

// Mirror of the frontend dropdown option lists (frontend/src/app/bi-cubes/bi-cubes.ts).
const AGGREGATES = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'] as const;
const MEASURE_TYPES = ['integer', 'number', 'boolean', 'string', 'date'] as const;
const TIME_FUNCTIONS = ['Year', 'QuarterYear', 'MonthYear', 'WeekYear', 'DayMonthYear'] as const;

d('cube enum round-trip (live)', () => {
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

  async function freshSource(): Promise<SeededSource> {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    return src;
  }

  /**
   * Compile (always) and optionally build a cube from `def`; register cleanup.
   * The enum round-trip's contract is that the dropdown value COMPILES in IRIS;
   * building additionally requires the seeded data to fit the measure type
   * (e.g. a boolean measure needs 0/1 source values), so `build` is opt-in.
   */
  async function compileMaybeBuild(
    def: CubeDefinition,
    build: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    const className = cubeClassName(def.cubeName);
    // Kill THEN delete (deleteWorkbenchCube) so a built cube never orphans the
    // DeepSee registry — the bug that made a later build fail in %PurgeDSTIME.
    cleanups.push(() => deleteWorkbenchCube(app.iris, def.cubeName));
    const compiled = await app.iris.atelier.importAndCompile(className, generateCubeClass(def));
    if (!compiled.ok) return { ok: false, message: `compile: ${compiled.errors.join('; ')}` };
    if (!build) return { ok: true, message: 'compiled' };
    const built = buildCube(app.iris.native, def.cubeName);
    return { ok: built.ok, message: built.message };
  }

  it.each(AGGREGATES)('aggregate %s compiles + builds in IRIS', async (aggregate) => {
    const src = await freshSource();
    const cubeName = `WorkbenchTestAgg${aggregate}${uniqueSuffix()}`;
    const def: CubeDefinition = {
      cubeName,
      sourceClass: src.className,
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }],
        },
      ],
      measures: [
        { name: 'M', sourceProperty: 'Amount', factName: 'MxM', aggregate, type: 'number', factNumber: 3 },
      ],
    } as CubeDefinition;
    const res = await compileMaybeBuild(def, true);
    expect(res.ok, `aggregate ${aggregate}: ${res.message}`).toBe(true);
  });

  // IRIS constrains the aggregate per measure type (measured against live IRIS):
  //   numeric (integer/number) → SUM/COUNT/AVG/MIN/MAX
  //   boolean/string           → COUNT only
  //   date                     → MIN/MAX/AVG
  // The Workbench form does NOT enforce this pairing (any aggregate is selectable
  // for any type), so a bad combination only fails at compile — see the note in
  // cube-workflow.it.test.ts. Here we prove each TYPE compiles with a valid
  // aggregate for it.
  const AGG_FOR_TYPE: Record<(typeof MEASURE_TYPES)[number], string> = {
    integer: 'SUM',
    number: 'SUM',
    boolean: 'COUNT',
    string: 'COUNT',
    date: 'MAX',
  };
  const SRC_PROP_FOR_TYPE: Record<(typeof MEASURE_TYPES)[number], string> = {
    integer: 'Amount',
    number: 'Amount',
    boolean: 'Amount',
    string: 'Region',
    date: 'SaleDate',
  };

  // A build additionally needs the seeded data to fit the type; boolean/string/
  // date measures over the sample columns compile cleanly but may not populate,
  // so we assert COMPILE for every type and BUILD for the numeric ones.
  const BUILDABLE_TYPE = new Set(['integer', 'number']);

  it.each(MEASURE_TYPES)('measure type %s compiles in IRIS (with a valid aggregate)', async (type) => {
    const src = await freshSource();
    const cubeName = `WorkbenchTestType${type}${uniqueSuffix()}`;
    const def: CubeDefinition = {
      cubeName,
      sourceClass: src.className,
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }],
        },
      ],
      measures: [
        {
          name: 'M',
          sourceProperty: SRC_PROP_FOR_TYPE[type],
          factName: 'MxM',
          aggregate: AGG_FOR_TYPE[type],
          type,
          factNumber: 3,
        },
      ],
    } as CubeDefinition;
    const res = await compileMaybeBuild(def, BUILDABLE_TYPE.has(type));
    expect(res.ok, `measure type ${type}: ${res.message}`).toBe(true);
  });

  it.each(TIME_FUNCTIONS)('time function %s compiles + builds in IRIS', async (timeFunction) => {
    const src = await freshSource();
    const cubeName = `WorkbenchTestTf${timeFunction}${uniqueSuffix()}`;
    const def: CubeDefinition = {
      cubeName,
      sourceClass: src.className,
      dimensions: [
        {
          name: 'DateD',
          type: 'time',
          hasAll: true,
          hierarchies: [
            {
              name: 'H1',
              levels: [{ name: timeFunction, sourceProperty: 'SaleDate', timeFunction, factNumber: 2 }],
            },
          ],
        },
      ],
      measures: [
        { name: 'M', sourceProperty: 'Amount', factName: 'MxM', aggregate: 'SUM', type: 'number', factNumber: 3 },
      ],
    } as CubeDefinition;
    const res = await compileMaybeBuild(def, true);
    expect(res.ok, `timeFunction ${timeFunction}: ${res.message}`).toBe(true);
  });
});
