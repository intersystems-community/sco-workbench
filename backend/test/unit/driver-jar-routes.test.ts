import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriverJarRouter } from '../../src/server/driver-jar-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import type { IrisServices } from '../../src/iris/index.js';
import type { Env } from '../../src/config/env.js';

const PG_JAR = 'postgresql-42.7.13.jar';
const DRIVER_DIR = '/usr/irissys/dev/java/lib';

/** Records what reached IRIS so we can assert whether a push actually happened. */
interface FakeCalls {
  /** Class-method calls: (class, method, args). */
  classCalls: Array<[string, string, unknown[]]>;
  /** %Stream.FileBinary method calls, in order. */
  streamCalls: string[];
}

/**
 * Fake IrisServices covering the calls the route + putFileToIris make:
 *   - callValue('%Library.File','Exists') → driven by `opts.exists`
 *   - callValue('%Library.File','CreateDirectoryChain') → 1
 *   - callValue('%SYSTEM.Encryption','Base64Decode') → passthrough
 *   - callObject('%Stream.FileBinary','%New') → a fake stream (invokeString → OK)
 */
function fakeIris(opts?: { exists?: boolean }): { iris: IrisServices; calls: FakeCalls } {
  const calls: FakeCalls = { classCalls: [], streamCalls: [] };
  const stream = {
    invokeString: (method: string, ..._args: unknown[]) => {
      calls.streamCalls.push(method);
      return '1';
    },
  };
  const iris = {
    namespace: 'SC',
    close: () => {},
    native: {
      callValue: (cls: string, method: string, ...args: unknown[]) => {
        calls.classCalls.push([cls, method, args]);
        if (cls === '%Library.File' && method === 'Exists') return opts?.exists ? 1 : 0;
        if (cls === '%Library.File' && method === 'CreateDirectoryChain') return 1;
        if (cls === '%SYSTEM.Encryption' && method === 'Base64Decode') return args[0];
        return '1';
      },
      callObject: (cls: string, method: string) => {
        calls.classCalls.push([cls, method, []]);
        return cls === '%Stream.FileBinary' && method === '%New' ? stream : null;
      },
      decodeStatus: (status: unknown) =>
        status === '1' || status === 1 ? { ok: true, text: 'OK' } : { ok: false, text: 'ERROR' },
    },
  } as unknown as IrisServices;
  return { iris, calls };
}

let libDir: string;
beforeAll(() => {
  // A real dir with a real (dummy) PostgreSQL jar so the route's readFile succeeds.
  libDir = mkdtempSync(join(tmpdir(), 'jdbc-lib-'));
  writeFileSync(join(libDir, PG_JAR), 'FAKE-JAR-BYTES');
});
afterAll(() => rmSync(libDir, { recursive: true, force: true }));

function startApp(iris: IrisServices, jdbcLibDir = libDir): { server: Server; base: string } {
  const env = { JDBC_LIB_DIR: jdbcLibDir, JDBC_POSTGRESQL_DRIVER_DIR: DRIVER_DIR } as unknown as Env;
  const app: Express = express();
  app.use(express.json());
  app.use('/api/data-integration/driver-jar', createDriverJarRouter(iris, env));
  app.use(errorEnvelope(false));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function postJson(base: string, body: unknown) {
  const res = await fetch(`${base}/api/data-integration/driver-jar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Did a file-push happen? A push always creates the parent dir chain first. */
function pushed(calls: FakeCalls): boolean {
  return calls.classCalls.some((c) => c[0] === '%Library.File' && c[1] === 'CreateDirectoryChain');
}

describe('driver-jar routes', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('rejects an unknown database type with 400 and stages nothing (no silent deploy)', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, { dbType: 'MySQL' });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION');
    // Fail loud BEFORE any IRIS work — no existence check, no push.
    expect(calls.classCalls).toHaveLength(0);
  });

  it('rejects a missing dbType with 400 VALIDATION', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, {});
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION');
  });

  it('stages nothing for IRIS (its driver is always on the gateway) and returns an empty path', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, { dbType: 'IRIS' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, irisPath: '' });
    expect(pushed(calls)).toBe(false);
  });

  it('pushes the PostgreSQL jar into IRIS when absent and returns its in-container path', async () => {
    const { iris, calls } = fakeIris({ exists: false });
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, { dbType: 'PostgreSQL' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, irisPath: `${DRIVER_DIR}/${PG_JAR}` });
    // A real push happened: dir chain created, stream written+saved.
    expect(pushed(calls)).toBe(true);
    expect(calls.streamCalls).toEqual(['FilenameSet', 'Write', '%Save']);
  });

  it('is idempotent: skips the push when the jar is already staged', async () => {
    const { iris, calls } = fakeIris({ exists: true });
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, { dbType: 'PostgreSQL' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, irisPath: `${DRIVER_DIR}/${PG_JAR}` });
    // Existence was checked, but nothing was written.
    expect(pushed(calls)).toBe(false);
    expect(calls.streamCalls).toEqual([]);
  });

  it('surfaces an error when the driver jar is missing from JDBC_LIB_DIR (does not report success)', async () => {
    const { iris } = fakeIris({ exists: false });
    // Point JDBC_LIB_DIR at an empty dir so the jar read fails.
    const emptyDir = mkdtempSync(join(tmpdir(), 'jdbc-empty-'));
    const started = startApp(iris, emptyDir);
    server = started.server;

    const { status, body } = await postJson(started.base, { dbType: 'PostgreSQL' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
