import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { checkScoPreflight, MIN_SCO_VERSION } from '../../src/iris/sco-preflight.js';
import { createPreflightRouter } from '../../src/server/preflight-routes.js';
import type { Env } from '../../src/config/env.js';

/**
 * The setup preflight. Its whole value is CLASSIFICATION: one probe of SCO's
 * `/backend-version` has to tell a stopped instance apart from a bad password, a
 * wrong namespace, and an unsupported build, because each one has a different fix
 * and the user sees only the screen this drives.
 *
 * Every branch here is pinned against a real HTTP server standing in for SCO,
 * returning the statuses a live 1.7.3 instance was measured to return:
 * 200 + `1.7.3` healthy, 401 for bad credentials, 404 for a wrong namespace.
 *
 * Fail-closed is asserted explicitly: no unexpected shape may yield `ok: true`.
 */
const servers: Server[] = [];

afterEach(async () => {
  // `closeAllConnections()` FIRST, and it is load-bearing: the timeout test leaves a
  // request the fake server never answers, and plain `close()` waits for in-flight
  // connections to finish — so without this the teardown hangs, leaking a listener
  // into the rest of the suite.
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections?.();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
  vi.unstubAllGlobals();
});

/** Stand up a fake SCO that answers the version endpoint however the test wants. */
async function fakeSco(handler: (req: express.Request, res: express.Response) => void): Promise<number> {
  const app = express();
  app.get('/api/:ns/scdata/v1/backend-version', handler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const config = (port: number, over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  namespace: 'SC',
  user: 'superuser',
  password: 'secret',
  minimumVersion: '1.7.3',
  timeoutMs: 2_000,
  ...over,
});

describe('checkScoPreflight — the healthy path', () => {
  it('passes on 200 + a version at the minimum', async () => {
    const port = await fakeSco((_req, res) => res.type('text/plain').send('1.7.3'));
    const r = await checkScoPreflight(config(port));
    expect(r.ok).toBe(true);
    expect(r.version).toBe('1.7.3');
    expect(r.reason).toBeUndefined();
  });

  it('passes on a newer version, including one with a build suffix', async () => {
    const port = await fakeSco((_req, res) => res.type('text/plain').send('1.10.0-202609231521\n'));
    const r = await checkScoPreflight(config(port));
    expect(r.ok).toBe(true);
    // 1.10.0 is NEWER than 1.7.3 — a string comparison would get this wrong.
    expect(r.version).toBe('1.10.0-202609231521');
  });

  it('sends HTTP Basic credentials (the endpoint requires SC_Data_API:READ)', async () => {
    let seen = '';
    const port = await fakeSco((req, res) => {
      seen = req.headers.authorization ?? '';
      res.type('text/plain').send('1.7.3');
    });
    await checkScoPreflight(config(port));
    expect(seen).toBe('Basic ' + Buffer.from('superuser:secret').toString('base64'));
  });

  it('probes the namespaced scdata path, honouring a web prefix', async () => {
    const port = await fakeSco((_req, res) => res.type('text/plain').send('1.7.3'));
    const plain = await checkScoPreflight(config(port, { namespace: 'SCPROD' }));
    expect(plain.endpoint).toContain('/api/SCPROD/scdata/v1/backend-version');
    const prefixed = await checkScoPreflight(config(port, { prefix: 'sco' }));
    expect(prefixed.endpoint).toContain('/sco/api/SC/scdata/v1/backend-version');
  });

  it('never echoes the password in the result the UI renders', async () => {
    const port = await fakeSco((_req, res) => res.type('text/plain').send('1.7.3'));
    const r = await checkScoPreflight(config(port, { password: 'sup3rs3cret' }));
    expect(JSON.stringify(r)).not.toContain('sup3rs3cret');
    // The user IS echoed, so the guidance can name it.
    expect(r.user).toBe('superuser');
  });
});

describe('checkScoPreflight — each failure gets its own reason', () => {
  it('401 → unauthenticated (bad credentials, or no SC_Data_API:READ)', async () => {
    const port = await fakeSco((_req, res) => res.status(401).send('Unauthorized'));
    const r = await checkScoPreflight(config(port));
    expect(r).toMatchObject({ ok: false, reason: 'unauthenticated', detail: 'HTTP 401' });
  });

  it('403 → unauthenticated too: a valid login without the privilege is the same fix', async () => {
    const port = await fakeSco((_req, res) => res.status(403).send('Forbidden'));
    const r = await checkScoPreflight(config(port));
    expect(r.reason).toBe('unauthenticated');
  });

  it('404 → api-not-found (wrong namespace, or SCO not installed there)', async () => {
    const app = express();
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const r = await checkScoPreflight(config((server.address() as AddressInfo).port));
    expect(r).toMatchObject({ ok: false, reason: 'api-not-found' });
  });

  it('another 5xx → http-error, carrying the status', async () => {
    const port = await fakeSco((_req, res) => res.status(500).send('boom'));
    const r = await checkScoPreflight(config(port));
    expect(r).toMatchObject({ ok: false, reason: 'http-error', detail: 'HTTP 500' });
  });

  it('nothing listening → unreachable', async () => {
    // Bind then immediately close, so the port is real but refuses.
    const server = await new Promise<Server>((resolve) => {
      const s = express().listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const r = await checkScoPreflight(config(port));
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(r.detail).toBeTruthy();
  });

  it('a hang → timeout, not unreachable (a starting instance needs a different hint)', async () => {
    const port = await fakeSco(() => { /* never responds */ });
    const r = await checkScoPreflight(config(port, { timeoutMs: 150 }));
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('200 but an older version → version-too-old, reporting what it found', async () => {
    const port = await fakeSco((_req, res) => res.type('text/plain').send('1.7.2'));
    const r = await checkScoPreflight(config(port));
    expect(r).toMatchObject({ ok: false, reason: 'version-too-old', version: '1.7.2' });
    // The minimum rides along so the UI doesn't hardcode it.
    expect(r.minimumVersion).toBe('1.7.3');
  });

  it('200 with a non-version body → version-unreadable, with the body bounded', async () => {
    // A proxy login page is the realistic case, and it can be huge; this string is
    // rendered in the UI, so it must not be pasted in whole.
    const port = await fakeSco((_req, res) => res.type('text/html').send('<html>' + 'x'.repeat(5000) + '</html>'));
    const r = await checkScoPreflight(config(port));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('version-unreadable');
    expect(r.detail!.length).toBeLessThan(120);
  });

  it('200 with an empty body → version-unreadable, not a pass', async () => {
    const port = await fakeSco((_req, res) => res.type('text/plain').send(''));
    const r = await checkScoPreflight(config(port));
    expect(r).toMatchObject({ ok: false, reason: 'version-unreadable' });
  });

  it('fails CLOSED: no failure branch ever reports ok', async () => {
    const statuses = [400, 401, 403, 404, 418, 500, 502, 503];
    for (const status of statuses) {
      const port = await fakeSco((_req, res) => res.status(status).send('no'));
      const r = await checkScoPreflight(config(port));
      expect(r.ok, `HTTP ${status} must not pass`).toBe(false);
      expect(r.reason, `HTTP ${status} must name a reason`).toBeTruthy();
    }
  });
});

describe('GET /api/preflight', () => {
  async function mount(scoPort: number, over: Partial<Env> = {}): Promise<string> {
    const env = {
      SCO_HOST: '127.0.0.1',
      SCO_WEB_PORT: scoPort,
      SCO_NAMESPACE: 'SC',
      SCO_USER: 'superuser',
      SCO_PASSWORD: 'secret',
      SCO_WEB_PREFIX: '',
      ...over,
    } as unknown as Env;
    const app = express();
    app.use('/api/preflight', createPreflightRouter(env));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('answers 200 with ok:true on a healthy instance', async () => {
    const scoPort = await fakeSco((_req, res) => res.type('text/plain').send('1.7.3'));
    const base = await mount(scoPort);
    const res = await fetch(`${base}/api/preflight`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: '1.7.3', minimumVersion: '1.7.3' });
  });

  /**
   * 200 even when BLOCKED, deliberately: the status says "a diagnosis was produced",
   * and the body says what it is. A 503 would force the SPA to read its verdict out
   * of an error handler, where "SCO is down" and "the Workbench server is down"
   * become indistinguishable — and those are different screens.
   */
  it('answers 200 with ok:false when the check BLOCKS, so the SPA reads a verdict not an error', async () => {
    const scoPort = await fakeSco((_req, res) => res.status(401).send('nope'));
    const base = await mount(scoPort);
    const res = await fetch(`${base}/api/preflight`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'unauthenticated' });
  });

  it('is never cached — Retry after a fix must see the new answer', async () => {
    const scoPort = await fakeSco((_req, res) => res.type('text/plain').send('1.7.3'));
    const base = await mount(scoPort);
    const res = await fetch(`${base}/api/preflight`);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  /**
   * The minimum is a BUILD constant, not configuration: it states which SCO API this
   * Workbench was written against, and an operator lowering it would not conjure the
   * missing endpoints. This pins that the route reports the build's value and that no
   * environment variable can move it.
   */
  it('reports the build minimum, which no env var can override', async () => {
    const scoPort = await fakeSco((_req, res) => res.type('text/plain').send('1.7.3'));
    const base = await mount(scoPort, {
      SCO_MIN_VERSION: '99.0.0',
      SCO_PREFLIGHT_TIMEOUT_MS: 1,
    } as unknown as Partial<Env>);
    const body = await (await fetch(`${base}/api/preflight`)).json();
    // A stray SCO_MIN_VERSION in the environment is ignored: still the build's 1.7.3,
    // so a 1.7.3 instance passes rather than being blocked by a typo'd variable.
    expect(body).toMatchObject({ ok: true, minimumVersion: MIN_SCO_VERSION });
    expect(MIN_SCO_VERSION).toBe('1.7.3');
  });
});
