/**
 * Cube BUILD-error surfacing + the source-properties route, against a live IRIS.
 *
 * Two seams this covers:
 *  - When %BuildCube fails per-row, the /api/cubes/build response must carry the
 *    REAL deduped row errors (BUILD_FAILED envelope with samples/total/distinct),
 *    NOT IRIS's "Do ##class(...).%PrintBuildErrors(...)" pointer.
 *  - GET /api/cubes/source-properties?class=… lists the real properties of ANY
 *    compiled class (custom or SCO built-in), resolving a short or full name.
 *
 * Live IRIS required; run via the path-scoped script: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import {
  seedSource,
  minimalCubeDef,
  deleteWorkbenchCube,
  runCleanups,
  type Cleanup,
  type SeededSource,
} from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';

const d = describe;

d('cube build-error surfacing + source-properties (live)', () => {
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

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('BE1: a per-row build failure returns BUILD_FAILED with the REAL deduped errors, not the %PrintBuildErrors hint', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    // An INTEGER measure over the String `Region` column ("North"/"South"/…) makes
    // EVERY fact row fail datatype validation at build time — the same shape as
    // the reported SALESORDER currency case.
    const cubeName = `WorkbenchTestBuildErr${suffix(src)}`;
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));
    const def = minimalCubeDef(cubeName, src.className, {
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }],
        },
      ],
      measures: [
        // type integer but sourced from a non-numeric String → row validation fails.
        { name: 'BadInt', sourceProperty: 'Region', factName: 'MxBadInt', aggregate: 'MAX', type: 'integer', factNumber: 3 },
      ],
    } as never);

    const res = await post('/api/cubes/build', { definition: def });
    const body = await jsonOf<{
      code: string;
      error: string;
      total?: number;
      distinct?: number;
      samples?: Array<{ message: string; count: number }>;
    }>(res);

    // It compiled (the class is valid) but the build failed per-row → 422 BUILD_FAILED.
    expect(res.status, JSON.stringify(body)).toBe(422);
    expect(body.code).toBe('BUILD_FAILED');
    // The message must NOT tell the user to run a classmethod themselves.
    expect(body.error).not.toMatch(/%PrintBuildErrors/i);
    expect(body.error).not.toMatch(/For more detailed information/i);
    // It MUST carry the real, actionable row errors.
    expect(Array.isArray(body.samples)).toBe(true);
    expect(body.samples!.length).toBeGreaterThan(0);
    expect((body.total ?? 0)).toBeGreaterThan(0);
    // The deduped sample is a genuine IRIS validation message.
    expect(body.samples![0]!.message).toMatch(/failed validation|Datatype|inserting\/updating fact/i);
    // And the message body echoes those errors (foldable in the UI).
    expect(body.error).toMatch(/failed validation|Datatype|row error/i);
  });

  it('SP1: source-properties resolves a custom class and lists its real properties', async () => {
    const src = await seedSource(app.iris, { seedRows: false });
    cleanups.push(src.cleanup);
    const res = await fetch(`${app.base}/api/cubes/source-properties?class=${encodeURIComponent(src.className)}`);
    const body = await jsonOf<{ className: string; properties: Array<{ name: string; type?: string }> }>(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.className).toBe(src.className);
    const names = body.properties.map((p) => p.name);
    // The seeded source declares Region/Product/Amount/SaleDate.
    expect(names).toContain('Region');
    expect(names).toContain('Amount');
    // System %-properties are filtered out.
    expect(names.every((n) => !n.startsWith('%'))).toBe(true);
  });

  it('SP2: source-properties works for a real SCO built-in class (not just custom objects)', async () => {
    // The whole point of the new route: a real SCO source class has properties too.
    const res = await fetch(`${app.base}/api/cubes/source-properties?class=${encodeURIComponent('SC.Data.SalesOrder')}`);
    if (res.status === 404) return; // instance without SalesOrder — skip gracefully
    const body = await jsonOf<{ className: string; properties: Array<{ name: string }> }>(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.className).toBe('SC.Data.SalesOrder');
    expect(body.properties.length).toBeGreaterThan(0);
  });

  it('SP3: source-properties 404s (with candidates) for a class that does not exist', async () => {
    const res = await fetch(`${app.base}/api/cubes/source-properties?class=SC.Data.NoSuchClassXYZ`);
    expect(res.status).toBe(404);
    const body = await jsonOf<{ code: string; candidates?: string[] }>(res);
    expect(body.code).toBe('NOT_FOUND');
    expect(Array.isArray(body.candidates)).toBe(true);
  });

  it('SP4: source-properties 400s when the class query param is missing', async () => {
    const res = await fetch(`${app.base}/api/cubes/source-properties`);
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe('VALIDATION');
  });
});

function suffix(src: SeededSource): string {
  return src.shortName.replace(/^Source/, '');
}
