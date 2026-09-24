import { describe, it, expect, beforeEach } from 'vitest';
import { rememberSetCookies, withStoredCookies, resetCookieJar } from '../../src/iris/cookie-jar.js';

/** A response carrying the given set-cookie headers (real Headers.getSetCookie). */
function setCookie(...cookies: string[]): Response {
  const headers = new Headers();
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response('ok', { status: 200, headers });
}

const ATELIER = 'http://iris:52773/api/atelier/v1/SC/doc/A.B.cls';
const SESSION = 'CSPSESSIONID-SP-52773-UP-api-atelier-=abc123; path=/api/atelier/; httpOnly; sameSite=strict';

describe('cookie jar', () => {
  beforeEach(() => {
    resetCookieJar();
  });

  it('stores a CSP cookie and sends it on a later request under its path', () => {
    rememberSetCookies(setCookie(SESSION), ATELIER);
    const init = withStoredCookies({ method: 'GET' }, ATELIER);
    expect((init.headers as Record<string, string>).Cookie).toBe(
      'CSPSESSIONID-SP-52773-UP-api-atelier-=abc123',
    );
  });

  it('omits a cookie whose path is not a prefix of the request path', () => {
    rememberSetCookies(setCookie(SESSION), ATELIER);
    const init = { method: 'GET' };
    // /api/deepsee is a different application; the atelier-scoped cookie must not go.
    expect(withStoredCookies(init, 'http://iris:52773/api/deepsee/v3/Info/Cubes')).toBe(init);
  });

  it('overwrites the stored value when IRIS re-issues the same cookie name', () => {
    rememberSetCookies(setCookie(SESSION), ATELIER);
    rememberSetCookies(
      setCookie('CSPSESSIONID-SP-52773-UP-api-atelier-=rotated9; path=/api/atelier/'),
      ATELIER,
    );
    const init = withStoredCookies({ method: 'GET' }, ATELIER);
    const sent = (init.headers as Record<string, string>).Cookie;
    expect(sent).toBe('CSPSESSIONID-SP-52773-UP-api-atelier-=rotated9');
    expect(sent).not.toContain('abc123');
  });

  it('does not send a cookie stored for a different origin', () => {
    rememberSetCookies(setCookie(SESSION), ATELIER);
    const init = { method: 'GET' };
    // Same path, different host and port — both must miss.
    expect(withStoredCookies(init, 'http://elsewhere:52773/api/atelier/v1/SC/doc/A.B.cls')).toBe(init);
    expect(withStoredCookies(init, 'http://iris:9999/api/atelier/v1/SC/doc/A.B.cls')).toBe(init);
  });

  it('ignores a Set-Cookie whose name is not CSP-prefixed', () => {
    rememberSetCookies(setCookie('tracking=xyz; path=/'), ATELIER);
    const init = { method: 'GET' };
    expect(withStoredCookies(init, ATELIER)).toBe(init);
  });

  it('ignores an empty value, a malformed header, and a response with no headers', () => {
    // Deletion cookie: must not be echoed back.
    rememberSetCookies(setCookie('CSPSESSIONID-x=; path=/api/atelier/'), ATELIER);
    rememberSetCookies(setCookie('CSPnoEqualsSign'), ATELIER);
    // Hand-rolled fake with no `headers` at all (as other unit suites stub fetch).
    const bare = { ok: true, status: 200 } as unknown as Response;
    expect(() => rememberSetCookies(bare, ATELIER)).not.toThrow();
    // An unparseable URL must not throw either.
    expect(() => rememberSetCookies(setCookie(SESSION), 'not a url')).not.toThrow();
    const init = { method: 'GET' };
    expect(withStoredCookies(init, ATELIER)).toBe(init);
    expect(withStoredCookies(init, 'not a url')).toBe(init);
  });

  it('sends both the path-scoped session cookie and the root-scoped CSPWSERVERID', () => {
    rememberSetCookies(setCookie(SESSION, 'CSPWSERVERID=00000f9a; path=/'), ATELIER);
    const init = withStoredCookies({ method: 'GET' }, ATELIER);
    const sent = (init.headers as Record<string, string>).Cookie;
    expect(sent).toContain('CSPSESSIONID-SP-52773-UP-api-atelier-=abc123');
    expect(sent).toContain('CSPWSERVERID=00000f9a');
    // The root-scoped one alone applies to an unrelated path.
    const other = withStoredCookies({ method: 'GET' }, 'http://iris:52773/api/deepsee/v3/Info/Cubes');
    expect((other.headers as Record<string, string>).Cookie).toBe('CSPWSERVERID=00000f9a');
  });

  it("keeps the caller's own Cookie header and preserves other headers", () => {
    rememberSetCookies(setCookie(SESSION), ATELIER);
    const mine = { method: 'GET', headers: { cookie: 'mine=1' } };
    expect(withStoredCookies(mine, ATELIER)).toBe(mine);
    // Existing headers survive the merge, and init is not mutated in place.
    const original = { method: 'PUT', headers: { Authorization: 'Basic x', Connection: 'close' } };
    const merged = withStoredCookies(original, ATELIER);
    const headers = merged.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic x');
    expect(headers.Connection).toBe('close');
    expect(headers.Cookie).toContain('abc123');
    expect(original.headers).not.toHaveProperty('Cookie');
  });

  it('accepts a Headers instance without dropping the stored cookie', () => {
    rememberSetCookies(setCookie(SESSION), ATELIER);
    const merged = withStoredCookies({ method: 'GET', headers: new Headers({ Connection: 'close' }) }, ATELIER);
    const headers = merged.headers as Headers;
    expect(headers.get('cookie')).toContain('abc123');
    expect(headers.get('connection')).toBe('close');
  });
});
