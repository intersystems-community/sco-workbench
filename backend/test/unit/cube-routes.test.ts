import { describe, it, expect, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createCubeRouter } from '../../src/server/cube-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import type { IrisServices } from '../../src/iris/index.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { CubeDraftRepository } from '../../src/db/cube-drafts.js';

/** Parse a fetch response body as `any` for terse assertions. */
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

/**
 * Route-level tests for /api/cubes. We mount ONLY the cube router on a tiny
 * Express app with a fake IrisServices, so no real IRIS/Bedrock is touched.
 */

interface FakeCalls {
  compiled: Array<{ className: string; source: string }>;
  built: string[];
  killed: string[];
  deletedClasses: string[];
}

/** Build a fake IrisServices; behavior tuned per test via `opts`. */
function fakeIris(opts: {
  cubes?: Array<{ Name: string; DependsOn?: string }>;
  compileOk?: boolean;
  buildOk?: boolean;
  exists?: boolean;
}): { iris: IrisServices; calls: FakeCalls } {
  const calls: FakeCalls = { compiled: [], built: [], killed: [], deletedClasses: [] };
  const cubes = opts.cubes ?? [];
  const compileOk = opts.compileOk ?? true;
  const buildOk = opts.buildOk ?? true;

  const iris = {
    namespace: 'SC',
    close: () => {},
    atelier: {
      query: async (sql: string, params?: unknown[]) => {
        // resolveClass() does an exact-name lookup with a bound parameter; echo
        // the requested class back so any source class "resolves" in tests.
        if (params && params.length && /WHERE\s+Name\s*=\s*\?/i.test(sql)) {
          return [{ Name: String(params[0]) }];
        }
        // Otherwise it's the cube-list / cube-subclass query.
        return cubes;
      },
      readClass: async () => '',
      importAndCompile: async (className: string, source: string) => {
        calls.compiled.push({ className, source });
        return compileOk
          ? { ok: true, errors: [], console: [] }
          : { ok: false, errors: ['ERROR: parse'], console: ['line 1: oops'] };
      },
    },
    native: {
      callValue: (_cls: string, method: string, ...args: unknown[]) => {
        if (method === '%BuildCube') {
          calls.built.push(String(args[0]));
          return buildOk ? 1 : '0 build-err';
        }
        if (method === '%GetCubeFactCount') return 42;
        if (method === '%CubeExists') {
          // A cube "exists" only if it's in the seeded dictionary list (realistic),
          // unless a test forces it via opts.exists.
          if (opts.exists !== undefined) return opts.exists ? 1 : 0;
          const short = String(args[0]);
          return cubes.some((c) => c.Name.split('.').pop() === short) ? 1 : 0;
        }
        if (method === '%KillCube') {
          calls.killed.push(String(args[0]));
          return 1;
        }
        if (method === 'Delete') {
          calls.deletedClasses.push(String(args[0]));
          return 1;
        }
        if (method === '%GetCubeFactClass') return `${args[0]}.Fact`;
        return undefined;
      },
      decodeStatus: (status: unknown) =>
        status === 1 ? { ok: true, text: 'OK' } : { ok: false, text: 'ERROR #5001: failed' },
      // buildCube drains the connection after building (releases the DeepSee build
      // lock so the next MDX read does not hit "#5001: locked for rebuilding").
      drainConnectionState: () => {},
    },
  } as unknown as IrisServices;

  return { iris, calls };
}

function startApp(iris: IrisServices): { app: Express; server: Server; base: string } {
  const app = express();
  app.use(express.json());
  const db = openDatabase(':memory:');
  app.use('/api/cubes', createCubeRouter(iris, new CubeDraftRepository(db)));
  app.use(errorEnvelope(false));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { app, server, base: `http://127.0.0.1:${port}` };
}

const MIN_DEF = {
  cubeName: 'WidgetCube',
  sourceClass: 'Workbench.Test.Widget',
  measures: [{ name: 'Total', sourceProperty: 'Amount', factName: 'Total', aggregate: 'SUM', type: 'number', factNumber: 2 }],
};

describe('cube routes', () => {
  let server: Server | undefined;
  let base = '';

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('GET /api/cubes lists cubes from the dictionary', async () => {
    const { iris } = fakeIris({
      cubes: [{ Name: 'SC.Core.Analytics.Cube.SalesOrderCube', DependsOn: 'SC.Data.SalesOrder' }],
    });
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes`);
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body.cubes).toHaveLength(1);
    expect(body.cubes[0]).toMatchObject({ cubeName: 'SalesOrderCube', sourceClass: 'SC.Data.SalesOrder' });
  });

  it('GET /api/cubes/:name returns detail with state=built', async () => {
    const { iris } = fakeIris({ cubes: [{ Name: 'SC.Workbench.Cube.WidgetCube', DependsOn: 'W.Src' }] });
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/WidgetCube`);
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body.cube).toMatchObject({ cubeName: 'WidgetCube', exists: true, factCount: 42, state: 'built' });
  });

  it('POST /api/cubes/save persists a draft without touching IRIS', async () => {
    const { iris, calls } = fakeIris({});
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { cubeName: 'DraftCube', sourceClass: 'X' } }),
    });
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, cubeName: 'DraftCube', state: 'draft' });
    expect(calls.compiled).toHaveLength(0); // save never compiles
    // The draft now shows up in the list as state=draft.
    const list = await jsonBody(await fetch(`${base}/api/cubes`));
    expect(list.cubes.find((c: any) => c.cubeName === 'DraftCube')?.state).toBe('draft');
  });

  it('save-draft over a cube already built in IRIS re-lists it as draft (not built)', async () => {
    // The cube exists in IRIS (so it would otherwise read "built"), but saving a
    // draft records the current working state — the list must reflect 'draft'.
    const { iris } = fakeIris({ cubes: [{ Name: 'SC.Workbench.Cube.WidgetCube', DependsOn: 'W.Src' }] });
    ({ server, base } = startApp(iris));

    const before = await jsonBody(await fetch(`${base}/api/cubes`));
    expect(before.cubes.find((c: any) => c.cubeName === 'WidgetCube')?.state).toBe('built');

    const save = await fetch(`${base}/api/cubes/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { cubeName: 'WidgetCube', sourceClass: 'W.Src' } }),
    });
    expect((await jsonBody(save)).state).toBe('draft');

    const after = await jsonBody(await fetch(`${base}/api/cubes`));
    expect(after.cubes.find((c: any) => c.cubeName === 'WidgetCube')?.state).toBe('draft');
  });

  it('W1: re-saving an unchanged built cube preserves state=built (no silent reset)', async () => {
    const { iris } = fakeIris({});
    ({ server, base } = startApp(iris));
    // Build first → draft row advances to 'built'.
    const built = await jsonBody(
      await fetch(`${base}/api/cubes/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: MIN_DEF }),
      }),
    );
    expect(built.state).toBe('built');
    // A bare Save with the SAME definition must not clobber 'built'.
    const saved = await jsonBody(
      await fetch(`${base}/api/cubes/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: MIN_DEF }),
      }),
    );
    expect(saved.state).toBe('built');
  });

  it('W1b: saving an EDITED definition drops a built cube back to draft', async () => {
    const { iris } = fakeIris({});
    ({ server, base } = startApp(iris));
    await fetch(`${base}/api/cubes/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: MIN_DEF }),
    });
    const saved = await jsonBody(
      await fetch(`${base}/api/cubes/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: { ...MIN_DEF, description: 'edited' } }),
      }),
    );
    expect(saved.state).toBe('draft');
  });

  it('W4: a cube name that is not a valid identifier is rejected (400 VALIDATION)', async () => {
    const { iris } = fakeIris({});
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { ...MIN_DEF, cubeName: 'Bad Name' } }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.code).toBe('VALIDATION');
    expect((body.problems ?? []).join('\n')).toMatch(/invalid/i);
  });

  it('POST /api/cubes/compile saves + compiles (no build) → state compiled', async () => {
    const { iris, calls } = fakeIris({});
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: MIN_DEF }),
    });
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, state: 'compiled', className: 'SC.Workbench.Cube.WidgetCube' });
    expect(calls.compiled).toHaveLength(1);
    expect(calls.built).toHaveLength(0); // compile does NOT build
  });

  it('POST /api/cubes/build saves + compiles + builds → state built', async () => {
    const { iris, calls } = fakeIris({});
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: MIN_DEF }),
    });
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, state: 'built', factCount: 42 });
    expect(calls.compiled).toHaveLength(1);
    expect(calls.built).toEqual(['WidgetCube']);
  });

  it('POST /api/cubes/build returns 422 with compiler details when compile fails (and never builds)', async () => {
    const { iris, calls } = fakeIris({ compileOk: false });
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: MIN_DEF }),
    });
    const body = await jsonBody(res);
    expect(res.status).toBe(422);
    expect(body.details).toContain('ERROR: parse');
    expect(calls.built).toHaveLength(0);
  });

  it('POST /api/cubes/build returns 400 when the definition is missing', async () => {
    const { iris } = fakeIris({});
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/cubes/:name kills data then deletes the class', async () => {
    // The route resolves the class from the dictionary, so seed it as a
    // Workbench cube (deletable).
    const { iris, calls } = fakeIris({
      cubes: [{ Name: 'SC.Workbench.Cube.WidgetCube', DependsOn: 'W.Src' }],
    });
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/WidgetCube`, { method: 'DELETE' });
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls.killed).toEqual(['WidgetCube']);
    expect(calls.deletedClasses).toEqual(['SC.Workbench.Cube.WidgetCube']);
  });

  it('DELETE refuses an SCO built-in cube (403, no delete calls)', async () => {
    const { iris, calls } = fakeIris({
      cubes: [{ Name: 'SC.Core.Analytics.Cube.SalesOrderCube', DependsOn: 'SC.Data.SalesOrder' }],
    });
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/SalesOrderCube`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(calls.deletedClasses).toHaveLength(0);
  });

  it('GET /api/cubes/:name/definition returns 403 for a non-Workbench cube', async () => {
    const { iris } = fakeIris({
      cubes: [{ Name: 'SC.Core.Analytics.Cube.SalesOrderCube', DependsOn: 'SC.Data.SalesOrder' }],
    });
    ({ server, base } = startApp(iris));
    const res = await fetch(`${base}/api/cubes/SalesOrderCube/definition`);
    const body = await jsonBody(res);
    expect(res.status).toBe(403);
    expect(body.editable).toBe(false);
  });

  it('a draft-only cube (no IRIS class) is reported editable with state=draft', async () => {
    // No cubes in IRIS; just a saved draft. cubeDetail can't resolve a class, but
    // the draft makes it a Workbench-owned editable cube — must NOT show read-only.
    const { iris } = fakeIris({});
    ({ server, base } = startApp(iris));
    await fetch(`${base}/api/cubes/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { cubeName: 'DraftOnly', sourceClass: 'X.Y' } }),
    });
    const { cube } = await jsonBody(await fetch(`${base}/api/cubes/DraftOnly`));
    expect(cube.editable).toBe(true);
    expect(cube.state).toBe('draft');
    // And its definition loads from the draft (editable), not a 403.
    const def = await jsonBody(await fetch(`${base}/api/cubes/DraftOnly/definition`));
    expect(def.editable).toBe(true);
  });

  it('renaming a draft cleans up the old draft (no duplicate)', async () => {
    const { iris } = fakeIris({});
    ({ server, base } = startApp(iris));
    // Save under the old name, then save the rename with originalName.
    await fetch(`${base}/api/cubes/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { cubeName: 'OldName', sourceClass: 'X.Y' } }),
    });
    await fetch(`${base}/api/cubes/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { cubeName: 'NewName', sourceClass: 'X.Y' }, originalName: 'OldName' }),
    });
    const list = await jsonBody(await fetch(`${base}/api/cubes`));
    const names = list.cubes.map((c: any) => c.cubeName);
    expect(names).toContain('NewName');
    expect(names).not.toContain('OldName'); // old draft removed — no duplicate
  });
});
