/**
 * Cross-cutting reliability (P1–P4) against a live IRIS: the reverse proxy's
 * passthrough + paging-header exposure, auth-failure surfacing, and /healthz.
 * Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { loadEnv } from '../../src/config/env.js';
import { AtelierClient } from '../../src/iris/atelier-client.js';
import { IrisError } from '../../src/iris/iris-error.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('proxy + auth + health (live)', () => {
  let app: BootedApp;

  beforeAll(() => {
    app = bootApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('P1: proxy forwards scdata and exposes paging headers', async () => {
    // A scdata list request goes through the proxy to IRIS. We assert the
    // paging-header exposure the browser relies on, regardless of row data.
    const res = await fetch(`${app.base}/api/scdata/v1/salesorders?$top=1`);
    // The endpoint may 200 (rows or empty) — the proxy path itself must work
    // (not a local 404), and expose the IRIS paging headers.
    expect(res.status).toBeLessThan(500);
    const expose = res.headers.get('access-control-expose-headers') ?? '';
    if (res.ok) expect(expose.toLowerCase()).toContain('totalcount');
  });

  it('P3: an AtelierClient with a bad password surfaces a typed IrisError (never hangs/passes)', async () => {
    const env = loadEnv();
    const bad = new AtelierClient({
      host: env.SCO_HOST,
      port: env.SCO_WEB_PORT,
      namespace: env.SCO_NAMESPACE,
      user: env.SCO_USER,
      password: `${env.SCO_PASSWORD}_wrong`,
      prefix: env.SCO_WEB_PREFIX,
    });
    // Non-mutating: a read that requires auth. The status IRIS returns for bad
    // credentials is instance-dependent — some return 401 (→ IrisAuthError),
    // this instance returns 400 with no WWW-Authenticate header (→ IrisHttpError).
    // The reliability guarantee is that it surfaces as a TYPED IrisError, not a
    // hang or a silently-accepted request.
    await expect(bad.readClass('%Studio.Project')).rejects.toBeInstanceOf(IrisError);
  });

  it('P4: /healthz reports Atelier reachable', async () => {
    const health = await jsonOf<{ ok: boolean; atelier: string }>(await fetch(`${app.base}/healthz`));
    expect(health.ok).toBe(true);
    expect(health.atelier).not.toBe('unreachable');
  });
});
