// backend/test/unit/connection-test-routes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createConnectionTestRouter } from '../../src/server/connection-test-routes.js';

/**
 * Router-level contract for Test Connection. The per-adapter connection logic has
 * its own unit tests with injectable clients (ftp-test / sftp-test / s3-test), so
 * what is asserted HERE is the thing only the route decides: which failures are a
 * 4xx (a malformed request) versus a 200 `{ ok:false }` (a normal failed test the
 * UI renders).
 *
 * Only paths that short-circuit BEFORE any network call are exercised, so this file
 * never touches a live server: a successful test needs a real target and belongs to
 * the integration tier.
 */
async function startApp(): Promise<{ server: Server; baseUrl: string }> {
  const app: Express = express();
  app.use(express.json());
  app.use('/test-connection', createConnectionTestRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('POST /test-connection/cloud (AWS S3)', () => {
  it('400s when bucket/region or credentials are absent from the body', async () => {
    const app = await startApp();
    server = app.server;
    for (const config of [undefined, {}, { bucket: 'b' }, { bucket: 'b', region: 'us-east-1' }]) {
      const { status, body } = await post(app.baseUrl, '/test-connection/cloud', { adapter: 'Cloud', config });
      expect(status, JSON.stringify(config)).toBe(400);
      expect(body.error).toBeTruthy();
    }
  });

  it('returns 200 { ok:false } for a credentials file it cannot read', async () => {
    const app = await startApp();
    server = app.server;
    // The request is well-formed; the uploaded FILE is the problem. That is a
    // failed test, not a protocol error — and it must never reach the network.
    const { status, body } = await post(app.baseUrl, '/test-connection/cloud', {
      adapter: 'Cloud',
      config: { bucket: 'b', region: 'us-east-1', credentialsFileContent: 'not a credentials file' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('AWS credentials file');
  });

  it('returns 200 { ok:false } when the named profile is missing from a valid file', async () => {
    const app = await startApp();
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/test-connection/cloud', {
      adapter: 'Cloud',
      config: {
        bucket: 'b',
        region: 'us-east-1',
        credentialsFileContent: '[default]\naws_access_key_id=AK\naws_secret_access_key=s\n',
        credentialsProfile: 'prod',
      },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('"prod"');
  });
});
