/**
 * Cube lifecycle (C1–C19) against a live, clean IRIS. Every test seeds its own
 * source class + rows and cleans up in afterEach, so no test depends on another
 * and re-runs are idempotent. Exercises Atelier REST+SQL, the Native SDK, the
 * D2CLIENT structure API, and the /api/cubes REST routes end-to-end.
 *
 * Live IRIS required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, minimalCubeDef, deleteWorkbenchCube, runCleanups, type Cleanup, type SeededSource } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import { listCubes, cubeDetail, cubeStructure, readCubeDefinition } from '../../src/iris/cube-catalog-ops.js';
import { cubeInfo } from '../../src/iris/cube-ops.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('cube lifecycle (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    // Heal any orphaned cube-registry entries a prior interrupted run left, so a
    // run that STARTS dirty doesn't fail its first build in %PurgeDSTIME.
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

  /** Seed a fresh source and register its cleanup. */
  async function freshSource(seedRows = true): Promise<SeededSource> {
    const src = await seedSource(app.iris, { seedRows });
    cleanups.push(src.cleanup);
    return src;
  }

  it('C1/C2: compiles a seeded source class and seeds rows via Native', async () => {
    const src = await freshSource(true);
    // The source compiled (freshSource throws otherwise); the seed produced rows.
    const rows = await app.iris.atelier.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${sqlName(src.className)}`,
    );
    expect(Number(rows[0]?.total)).toBe(src.rowCount);
  });

  it('C3/C5: generate+compile+build a cube and verify the fact count', async () => {
    const src = await freshSource(true);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    expect(cube.factCount).toBe(src.rowCount);

    const detail = await cubeDetail(app.iris.native, app.iris.atelier, cube.cubeName);
    expect(detail.exists).toBe(true);
    expect(detail.sourceClass).toBe(src.className);
    expect(detail.factCount).toBe(src.rowCount);
  });

  it('C4: LIST finds the built Workbench cube, editable, with its source', async () => {
    const src = await freshSource(true);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);

    const cubes = await listCubes(app.iris.atelier);
    const mine = cubes.find((c) => c.cubeName === cube.cubeName);
    expect(mine, `cube ${cube.cubeName} listed`).toBeTruthy();
    expect(mine!.sourceClass).toBe(src.className);
    expect(mine!.editable).toBe(true);
  });

  it('C6: STRUCTURE returns the generated measure and dimension tree', async () => {
    const src = await freshSource(true);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);

    const structure = await cubeStructure(app.iris.deepsee, cube.cubeName);
    expect(structure.measures.some((m) => m.name === 'Total')).toBe(true);
    const regionDim = structure.dimensions.find((dd) => dd.name.toLowerCase().includes('region'));
    expect(regionDim, 'RegionD dimension present').toBeTruthy();
    expect(regionDim!.hierarchies[0]!.levels.length).toBeGreaterThan(0);
  });

  it('C7: editable definition round-trips the generated fields', async () => {
    const src = await freshSource(true);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);

    const def = await readCubeDefinition(app.iris.atelier, cube.cubeName);
    expect(def, 'Workbench cube definition parses').toBeTruthy();
    expect(def!.sourceClass).toBe(src.className);
    expect(def!.measures?.some((m) => m.name === 'Total')).toBe(true);
    expect(def!.dimensions?.some((dd) => dd.name === 'RegionD')).toBe(true);
  });

  it('C8: a default SCO built-in cube is not editable', async () => {
    const cubes = await listCubes(app.iris.atelier);
    const sc = cubes.find((c) => !c.editable && c.className.startsWith('SC.Core.Analytics.Cube.'));
    if (!sc) return; // no SCO cube listed on this instance — skip gracefully
    const scDef = await readCubeDefinition(app.iris.atelier, sc.cubeName);
    expect(scDef).toBeNull();
  });

  it('C9–C14: REST save → compile → build → detail → definition → delete', async () => {
    const src = await freshSource(true);
    const def = minimalCubeDef(`WorkbenchTestRest${suffix(src)}`, src.className);
    const cubeName = def.cubeName;
    // Ensure the generated cube is reclaimed (kill THEN delete) even if a step throws.
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));

    // C9 SAVE (draft, no IRIS)
    const saved = await postJson(app.base, '/api/cubes/save', { definition: def });
    expect(saved.status).toBe(200);
    expect((await jsonOf(saved.res)).state).toBe('draft');

    // C10 COMPILE (class into IRIS, no build)
    const compiled = await postJson(app.base, '/api/cubes/compile', { definition: def });
    const compiledBody = await jsonOf<{ state: string; className: string }>(compiled.res);
    expect(compiled.status, JSON.stringify(compiledBody)).toBe(200);
    expect(compiledBody.state).toBe('compiled');
    expect(compiledBody.className).toBe(`SC.Workbench.Cube.${cubeName}`);

    // C11 BUILD (populate)
    const built = await postJson(app.base, '/api/cubes/build', { definition: def });
    const builtBody = await jsonOf<{ state: string; factCount: number }>(built.res);
    expect(built.status, JSON.stringify(builtBody)).toBe(200);
    expect(builtBody.state).toBe('built');
    expect(builtBody.factCount).toBe(src.rowCount);

    // C12 DETAIL
    const detailRes = await fetch(`${app.base}/api/cubes/${cubeName}`);
    const { cube } = await jsonOf<{ cube: Record<string, unknown> }>(detailRes);
    expect(cube.exists).toBe(true);
    expect(cube.editable).toBe(true);
    expect(cube.state).toBe('built');

    // C13 DEFINITION
    const defRes = await fetch(`${app.base}/api/cubes/${cubeName}/definition`);
    const defBody = await jsonOf<{ editable: boolean; definition: { dimensions: { name: string }[] } }>(defRes);
    expect(defBody.editable).toBe(true);
    expect(defBody.definition.dimensions.some((dd) => dd.name === 'RegionD')).toBe(true);

    // C14 DELETE
    const del = await fetch(`${app.base}/api/cubes/${cubeName}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list = await jsonOf<{ cubes: { cubeName: string }[] }>(await fetch(`${app.base}/api/cubes`));
    expect(list.cubes.some((c) => c.cubeName === cubeName)).toBe(false);
    expect(cubeInfo(app.iris.native, cubeName).exists).toBe(false);
  });

  it('C19: builds a cube over an EMPTY source table (factCount 0)', async () => {
    const src = await freshSource(false); // no rows seeded
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    expect(cube.factCount).toBe(0);
    expect(cubeInfo(app.iris.native, cube.cubeName).exists).toBe(true);
  });

  it('C20: a SOURCELESS measure compiles AND builds (coerced to COUNT), never a <UNDEFINED>', async () => {
    const src = await freshSource(true);
    // A measure with no sourceProperty/sourceExpression — the user leaves Source
    // blank. The generator must coerce it to COUNT so it builds, rather than
    // emitting a SUM-of-nothing that crashes the build. Drive it through the REST
    // build route (the real path) and assert it lands 'built'.
    const cubeName = `WorkbenchTestNoSrc${suffix(src)}`;
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));
    const def = minimalCubeDef(cubeName, src.className, {
      measures: [{ name: 'RowCount', factName: 'MxRowCount', aggregate: 'SUM', type: 'integer', factNumber: 3 }],
    } as never);
    const res = await postJson(app.base, '/api/cubes/build', { definition: def });
    const body = await jsonOf<{ state: string; factCount: number }>(res.res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.state).toBe('built');
    expect(body.factCount).toBe(src.rowCount);
  });
});

/** Convert a class name to its default SQL schema.table form. */
function sqlName(className: string): string {
  const parts = className.split('.');
  const table = parts.pop();
  return `${parts.join('_')}.${table}`;
}

function suffix(src: SeededSource): string {
  return src.shortName.replace(/^Source/, '');
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; res: Response }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, res };
}
