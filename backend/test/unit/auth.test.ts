import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SharedSecretVerifier, resolveApiToken, createAuthMiddleware } from '../../src/server/auth.js';
import type { Env } from '../../src/config/env.js';

describe('SharedSecretVerifier', () => {
  it('accepts the exact token', () => {
    expect(new SharedSecretVerifier('s3cret-value').verify('s3cret-value')).toBe(true);
  });

  it('rejects a wrong token of equal length', () => {
    expect(new SharedSecretVerifier('s3cret-value').verify('X3cret-value')).toBe(false);
  });

  it('rejects a length mismatch by returning false, never throwing (so it is 401 not 500)', () => {
    const v = new SharedSecretVerifier('s3cret-value');
    expect(() => v.verify('short')).not.toThrow();
    expect(v.verify('short')).toBe(false);
    expect(v.verify('a-much-longer-presented-token-than-expected')).toBe(false);
    expect(v.verify('')).toBe(false);
  });
});

describe('resolveApiToken', () => {
  it('returns the configured token with generated:false', () => {
    const env = { WORKBENCH_API_TOKEN: 'fixed-token' } as unknown as Env;
    expect(resolveApiToken(env)).toEqual({ token: 'fixed-token', generated: false });
  });

  it('generates a 32-byte hex token with generated:true when unset', () => {
    const r = resolveApiToken({} as unknown as Env);
    expect(r.generated).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates when the configured value is an empty string', () => {
    expect(resolveApiToken({ WORKBENCH_API_TOKEN: '' } as unknown as Env).generated).toBe(true);
  });

  it('produces a token a verifier built from it accepts', () => {
    const { token } = resolveApiToken({} as unknown as Env);
    expect(new SharedSecretVerifier(token).verify(token)).toBe(true);
  });
});

describe('createAuthMiddleware', () => {
  async function withApp(token: string) {
    const app = express();
    app.use('/api', createAuthMiddleware(new SharedSecretVerifier(token)));
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it('401s with WWW-Authenticate and a minimal body when no token is sent', async () => {
    const { base, close } = await withApp('t0ken');
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    await close();
  });

  it('passes the request through with a valid bearer token', async () => {
    const { base, close } = await withApp('t0ken');
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: 'Bearer t0ken' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await close();
  });

  it('401s a wrong token', async () => {
    const { base, close } = await withApp('t0ken');
    const res = await fetch(`${base}/api/ping`, { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    await close();
  });
});
