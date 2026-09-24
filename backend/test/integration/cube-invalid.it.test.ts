/**
 * Cube invalid-input & compile-failure matrix (CI1–CI16) against live IRIS.
 * `validateCubeDefinition` only checks a handful of structural rules; everything
 * else (bad aggregate, nonexistent property, bad expression) is emitted verbatim
 * and fails at IRIS COMPILE (422). Each test drives the real /api/cubes routes so
 * the full validate → resolve → generate → compile pipeline and the typed error
 * envelope are exercised. Self-provisioning + self-cleaning on a clean instance.
 *
 * Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, minimalCubeDef, deleteWorkbenchCube, runCleanups, type Cleanup, type SeededSource } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('cube invalid-input matrix (live)', () => {
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

  /** Seed a source and a generated cube class cleanup for a unique cube name. */
  async function ctx(): Promise<{ src: SeededSource; cubeName: string }> {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cubeName = `WorkbenchTestInvalid${src.shortName.replace(/^Source/, '')}`;
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));
    return { src, cubeName };
  }

  const compile = (def: unknown) =>
    fetch(`${app.base}/api/cubes/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: def }),
    });

  it('CI1: blank cubeName → 400 VALIDATION with the exact message', async () => {
    const res = await compile({ cubeName: '', sourceClass: 'SC.Data.SalesOrder', dimensions: [], measures: [] });
    expect(res.status).toBe(400);
    // Missing cubeName is caught by the route guard before the pipeline.
    const body = await jsonOf<{ error: string; code: string }>(res);
    expect(body.error).toMatch(/cubeName/i);
  });

  it('CI2: blank sourceClass → 400 VALIDATION "sourceClass is required."', async () => {
    const { cubeName } = await ctx();
    const def = { cubeName, sourceClass: '', dimensions: [], measures: [] };
    const res = await compile(def);
    expect(res.status).toBe(400);
    const body = await jsonOf<{ code: string; problems?: string[] }>(res);
    expect(body.code).toBe('VALIDATION');
    expect(body.problems).toContain('sourceClass is required.');
  });

  it('CI3: level factNumber < 2 → 400 with the "facts start at 2" message', async () => {
    const { src, cubeName } = await ctx();
    const def = minimalCubeDef(cubeName, src.className);
    def.dimensions![0]!.hierarchies[0]!.levels[0]!.factNumber = 1;
    const res = await compile(def);
    expect(res.status).toBe(400);
    const body = await jsonOf<{ code: string; problems: string[] }>(res);
    expect(body.code).toBe('VALIDATION');
    expect(body.problems.join('\n')).toMatch(/factNumber 1 is invalid/);
  });

  it('CI4: duplicate factNumber across two levels → 400 "Duplicate factNumber"', async () => {
    const { src, cubeName } = await ctx();
    const def = minimalCubeDef(cubeName, src.className);
    // Add a second level colliding on factNumber 2 with the first.
    def.dimensions![0]!.hierarchies[0]!.levels.push({ name: 'Product', sourceProperty: 'Product', factNumber: 2 });
    const res = await compile(def);
    expect(res.status).toBe(400);
    const body = await jsonOf<{ problems: string[] }>(res);
    expect(body.problems.join('\n')).toMatch(/Duplicate factNumber 2/);
  });

  it('CI6: an aggregate outside SUM/COUNT/AVG/MIN/MAX passes validation but fails IRIS compile (422)', async () => {
    const { src, cubeName } = await ctx();
    const def = minimalCubeDef(cubeName, src.className) as CubeDefinition;
    // MEDIAN is not a valid %DeepSee aggregate — validation lets it through.
    (def.measures![0] as { aggregate: string }).aggregate = 'MEDIAN';
    const res = await compile(def);
    expect(res.status, await res.clone().text()).toBe(422);
    const body = await jsonOf<{ code: string; console?: string[]; details?: string[] }>(res);
    expect(body.code).toBe('COMPILE_FAILED');
    // The compiler diagnostics ride along for the UI to show.
    expect((body.console ?? []).length + (body.details ?? []).length).toBeGreaterThan(0);
  });

  it('CI10: a level sourceProperty referencing a nonexistent field fails IRIS compile (422)', async () => {
    const { src, cubeName } = await ctx();
    const def = minimalCubeDef(cubeName, src.className);
    def.dimensions![0]!.hierarchies[0]!.levels[0]!.sourceProperty = 'NoSuchProperty';
    const res = await compile(def);
    expect(res.status, await res.clone().text()).toBe(422);
    expect((await jsonOf<{ code: string }>(res)).code).toBe('COMPILE_FAILED');
  });

  it('CI13: a nonexistent source class → 404 NOT_FOUND with candidates', async () => {
    const { cubeName } = await ctx();
    const def = minimalCubeDef(cubeName, 'SC.Data.SalesOrderZZZ');
    const res = await compile(def);
    expect(res.status).toBe(404);
    const body = await jsonOf<{ code: string; candidates: string[] }>(res);
    expect(body.code).toBe('NOT_FOUND');
    expect(Array.isArray(body.candidates)).toBe(true);
  });
});
