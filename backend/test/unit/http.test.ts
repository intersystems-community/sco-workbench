import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { irisFetch, redact, safeText } from '../../src/iris/http.js';
import { IrisTimeoutError, IrisUnreachableError } from '../../src/iris/iris-error.js';
import { resetCookieJar } from '../../src/iris/cookie-jar.js';

/** A response carrying a CSP session cookie, as IRIS Atelier sends. */
function withSession(value: string, status = 200): Response {
  const headers = new Headers();
  headers.append('set-cookie', `CSPSESSIONID-SP-52773-UP-x-=${value}; path=/`);
  return new Response('ok', { status, headers });
}

describe('irisFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The jar is process-wide; clear it so cases can't leak cookies into each other.
    resetCookieJar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response on a completed 2xx exchange', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await irisFetch('http://iris/x', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a non-2xx response without throwing (caller maps it)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const res = await irisFetch('http://iris/x', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('retries an idempotent 5xx when retryOn5xx, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await irisFetch('http://iris/x', { method: 'GET' }, { retryOn5xx: true });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 5xx when retryOn5xx is off (POST-create semantics)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const res = await irisFetch('http://iris/x', { method: 'POST' }, { retryOn5xx: false });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient socket error, then throws IrisUnreachableError after all attempts', async () => {
    const sock = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    fetchMock.mockRejectedValue(sock);
    await expect(
      irisFetch('http://iris/x', { method: 'GET' }, { attempts: 2 }),
    ).rejects.toBeInstanceOf(IrisUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws IrisTimeoutError when every attempt times out', async () => {
    // fetch that respects the abort signal: rejects with an AbortError when aborted.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    await expect(
      irisFetch('http://iris/x', { method: 'GET' }, { attempts: 1, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(IrisTimeoutError);
  });

  it('replays the CSP session cookie from a previous response (one session, not one per call)', async () => {
    fetchMock
      .mockResolvedValueOnce(withSession('first'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await irisFetch('http://iris/x', { method: 'GET', headers: { Connection: 'close' } });
    await irisFetch('http://iris/x', { method: 'GET', headers: { Connection: 'close' } });

    // The first request had nothing stored yet; the second replays the session.
    const [, firstInit] = fetchMock.mock.calls[0]!;
    expect(firstInit.headers.Cookie).toBeUndefined();
    const [, secondInit] = fetchMock.mock.calls[1]!;
    expect(secondInit.headers.Cookie).toBe('CSPSESSIONID-SP-52773-UP-x-=first');
    // The caller's own headers are still intact.
    expect(secondInit.headers.Connection).toBe('close');
  });

  it('captures a rotated cookie from a retried 5xx so the retry sends the new value', async () => {
    // IRIS re-issues its cookie on every response, including a 5xx.
    fetchMock
      .mockResolvedValueOnce(withSession('stale', 503))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await irisFetch('http://iris/x', { method: 'GET' }, { retryOn5xx: true });

    expect(res.status).toBe(200);
    const [, retryInit] = fetchMock.mock.calls[1]!;
    expect(retryInit.headers.Cookie).toBe('CSPSESSIONID-SP-52773-UP-x-=stale');
  });
});

describe('redact / safeText', () => {
  it('strips the query string', () => {
    expect(redact('http://iris/x?ignoreConflict=1')).toBe('http://iris/x');
    expect(redact('http://iris/x')).toBe('http://iris/x');
  });

  it('reads a body without throwing and caps length', async () => {
    expect(await safeText(new Response('hello'))).toBe('hello');
    const big = 'a'.repeat(1000);
    expect((await safeText(new Response(big))).length).toBe(500);
  });
});
