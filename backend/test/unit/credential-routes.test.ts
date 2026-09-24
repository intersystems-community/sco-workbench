import { describe, it, expect, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createCredentialRouter } from '../../src/server/credential-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import { IntegrationCaseRepository } from '../../src/db/integration-cases.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { encryptSecret } from '../../src/util/crypto-secret.js';
import type { IrisServices } from '../../src/iris/index.js';

/** Records the SetCredential call so we can assert what reached IRIS. */
interface FakeCalls {
  setCredential: Array<{ name: string; username: string; password: string; overwrite: unknown }>;
}

/**
 * Fake IrisServices whose `native.callValue` handles Ens.Config.Credentials.SetCredential.
 * `failStatus` forces a non-OK %Status so we can assert the failure envelope.
 */
function fakeIris(opts?: { failStatus?: boolean }): { iris: IrisServices; calls: FakeCalls } {
  const calls: FakeCalls = { setCredential: [] };
  const iris = {
    namespace: 'SC',
    close: () => {},
    native: {
      callValue: (cls: string, method: string, ...args: unknown[]) => {
        if (cls === 'Ens.Config.Credentials' && method === 'SetCredential') {
          calls.setCredential.push({
            name: String(args[0]),
            username: String(args[1]),
            password: String(args[2]),
            overwrite: args[3],
          });
          return opts?.failStatus ? '0 dup' : '1';
        }
        return undefined;
      },
      decodeStatus: (status: unknown) =>
        status === '1' || status === 1 ? { ok: true, text: 'OK' } : { ok: false, text: 'ERROR #5810: credential exists' },
    },
  } as unknown as IrisServices;
  return { iris, calls };
}

function startApp(iris: IrisServices): { server: Server; base: string } {
  const app: Express = express();
  app.use(express.json());
  app.use('/api/data-integration/credentials', createCredentialRouter(iris));
  app.use(errorEnvelope(false));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function postJson(base: string, body: unknown) {
  const res = await fetch(`${base}/api/data-integration/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('credential routes', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('upserts a credential in IRIS and returns ok (overwrite=1 for idempotent re-deploy)', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, {
      name: 'SC_Location_abc123',
      username: 'SuperUser',
      password: 'SYS',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, name: 'SC_Location_abc123' });
    expect(calls.setCredential).toHaveLength(1);
    // overwrite flag is 1 so re-deploying the same pipeline updates in place.
    expect(calls.setCredential[0]).toMatchObject({ name: 'SC_Location_abc123', username: 'SuperUser', password: 'SYS', overwrite: 1 });
  });

  it('surfaces a non-OK %Status as an error envelope (does not silently succeed)', async () => {
    const { iris } = fakeIris({ failStatus: true });
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, { name: 'x', username: 'u', password: 'p' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toMatch(/#5810|credential/i);
  });

  it('rejects a missing name with 400 VALIDATION', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, { username: 'u', password: 'p' });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION');
  });

  it('accepts an empty password (a key-only entry still carries a username)', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status } = await postJson(started.base, { name: 'k', username: 'ubuntu', password: '' });
    expect(status).toBe(200);
    expect(calls.setCredential[0]).toMatchObject({ username: 'ubuntu', password: '' });
  });
});

/** Start an app whose credential router is wired to a case repo (the Deploy path). */
function startAppWithCases(iris: IrisServices): { server: Server; base: string; repo: IntegrationCaseRepository } {
  const app: Express = express();
  app.use(express.json());
  const repo = new IntegrationCaseRepository(openDatabase(':memory:'));
  app.use('/api/data-integration/credentials', createCredentialRouter(iris, repo));
  app.use(errorEnvelope(false));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, repo };
}

async function postFromCase(base: string, id: string) {
  const res = await fetch(`${base}/api/data-integration/credentials/from-case/${id}`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as any };
}

describe('credential routes — from a saved case (Deploy path)', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('creates the credential from the DECRYPTED password stored on the case', async () => {
    const { iris, calls } = fakeIris();
    const app = startAppWithCases(iris);
    server = app.server;
    // Persist a case exactly as the case router would: password encrypted at rest.
    app.repo.upsert('job1', 'My SQL', 'draft', {
      source: {
        type: 'database',
        dbCredentialName: 'SC_sql_abc',
        dbUsername: 'SuperUser',
        dbPassword: encryptSecret('S3cret'),
      },
    });

    const { status, body } = await postFromCase(app.base, 'job1');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, name: 'SC_sql_abc' });
    // The PLAINTEXT reached IRIS — never the ciphertext.
    expect(calls.setCredential).toHaveLength(1);
    expect(calls.setCredential[0]).toMatchObject({ name: 'SC_sql_abc', username: 'SuperUser', password: 'S3cret', overwrite: 1 });
  });

  it('is a no-op (name:null) for an adapter with no credential (cloud/file)', async () => {
    const { iris, calls } = fakeIris();
    const app = startAppWithCases(iris);
    server = app.server;
    app.repo.upsert('job2', 'S3', 'draft', { source: { type: 'cloud', cloudBucket: 'b' } });

    const { status, body } = await postFromCase(app.base, 'job2');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, name: null });
    expect(calls.setCredential).toHaveLength(0);
  });

  it('404s (validation) for an unknown case id', async () => {
    const { iris } = fakeIris();
    const app = startAppWithCases(iris);
    server = app.server;
    const { status } = await postFromCase(app.base, 'nope');
    expect(status).toBe(400);
  });
});
