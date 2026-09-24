/**
 * Cube state-divergence workflows (W1–W5, W11) against live IRIS — the messy
 * multi-step sequences that surface Workbench bugs. Each test asserts the
 * INTENDED invariant; the companion fixes for these landed alongside the suite
 * (save no longer resets a built cube's state; the SCO-collision guard runs
 * before the draft is created; cube names are validated as identifiers).
 *
 * Self-provisioning + self-cleaning. Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, minimalCubeDef, deleteWorkbenchCube, runCleanups, type Cleanup, type SeededSource } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('cube state-divergence workflows (live)', () => {
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

  function registerCubeCleanup(cubeName: string): void {
    cleanups.push(() => deleteWorkbenchCube(app.iris, cubeName));
  }

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('W1: re-saving a built cube unchanged does NOT reset its state to draft', async () => {
    const src = await freshSource();
    const def = minimalCubeDef(`WorkbenchTestWf${src.shortName.replace(/^Source/, '')}`, src.className);
    registerCubeCleanup(def.cubeName);

    const built = await jsonOf<{ state: string }>((await post('/api/cubes/build', { definition: def })) as Response);
    expect(built.state).toBe('built');

    // A bare Save with the identical definition (e.g. a queued auto-save) must
    // preserve 'built' — the IRIS cube + data still exist.
    const saved = await jsonOf<{ state: string }>((await post('/api/cubes/save', { definition: def })) as Response);
    expect(saved.state, 'unchanged re-save must not clobber built state').toBe('built');

    // And the list agrees.
    const list = await jsonOf<{ cubes: Array<{ cubeName: string; state: string }> }>(
      await fetch(`${app.base}/api/cubes`),
    );
    expect(list.cubes.find((c) => c.cubeName === def.cubeName)?.state).toBe('built');
  });

  it('W1b: saving an EDITED definition does drop the cube back to draft', async () => {
    const src = await freshSource();
    const def = minimalCubeDef(`WorkbenchTestWf${src.shortName.replace(/^Source/, '')}`, src.className);
    registerCubeCleanup(def.cubeName);
    await post('/api/cubes/build', { definition: def });

    const edited: CubeDefinition = { ...def, description: 'edited — now stale' };
    const saved = await jsonOf<{ state: string }>((await post('/api/cubes/save', { definition: edited })) as Response);
    expect(saved.state, 'an edit invalidates the built cube').toBe('draft');
  });

  it('W3: compiling a cube whose name collides with an SCO built-in is refused WITHOUT creating a draft', async () => {
    // Find a real SCO cube (read-only). Skip gracefully if none present.
    const list = await jsonOf<{ cubes: Array<{ cubeName: string; editable: boolean }> }>(
      await fetch(`${app.base}/api/cubes`),
    );
    const sc = list.cubes.find((c) => !c.editable);
    if (!sc) return;

    const src = await freshSource();
    const def = minimalCubeDef(sc.cubeName, src.className);
    const res = await post('/api/cubes/compile', { definition: def });
    expect(res.status).toBe(403);

    // The refusal must NOT have created a draft row that would then supersede the
    // SCO cube's state in the list (showing a built-in as 'draft').
    const after = await jsonOf<{ cubes: Array<{ cubeName: string; state: string; editable: boolean }> }>(
      await fetch(`${app.base}/api/cubes`),
    );
    const entry = after.cubes.find((c) => c.cubeName === sc.cubeName);
    expect(entry?.editable).toBe(false);
    expect(entry?.state, 'SCO built-in must not be shown as a draft').not.toBe('draft');
  });

  it('W4: a cube name with a space/dot is rejected with a clear 400 (never mis-targets a class)', async () => {
    const src = await freshSource();
    for (const badName of ['My Cube', 'Cube.SalesOrder', 'a-b']) {
      const def = minimalCubeDef('placeholder', src.className);
      (def as { cubeName: string }).cubeName = badName;
      const res = await post('/api/cubes/compile', { definition: def });
      expect(res.status, `name "${badName}" should be rejected`).toBe(400);
      const body = await jsonOf<{ code: string; problems?: string[] }>(res);
      expect(body.code).toBe('VALIDATION');
    }
  });

  it('W-agg: the form allows an aggregate/type pairing IRIS rejects — surfaced as a clean 422', async () => {
    // Documents a real UX gap: the cube form lets a user pick SUM for a boolean
    // measure, which IRIS rejects at compile. The Workbench must surface that as
    // a clean typed 422, not a crash. (Fixing the FORM to constrain the pairing
    // is a frontend follow-up; the backend contract is the clean error.)
    const src = await freshSource();
    const def = minimalCubeDef(`WorkbenchTestAggBad${src.shortName.replace(/^Source/, '')}`, src.className);
    registerCubeCleanup(def.cubeName);
    (def.measures![0] as { type: string; aggregate: string }).type = 'boolean';
    (def.measures![0] as { aggregate: string }).aggregate = 'SUM';
    const res = await post('/api/cubes/compile', { definition: def });
    expect(res.status).toBe(422);
    expect((await jsonOf<{ code: string }>(res)).code).toBe('COMPILE_FAILED');
  });
});
