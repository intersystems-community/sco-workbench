/**
 * IssueRestClient against a stubbed fetch. The cases that matter are the ones where
 * SCO's own behaviour is easy to get wrong: pageSize is CLAMPED server-side (so a
 * caller asking for more than 1000 must not believe it got more), the row count the
 * page needs lives in a HEADER rather than the body, and unknown query parameters
 * are silently ignored by SCO rather than rejected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IssueRestClient,
  SCO_DEFAULT_PAGE_SIZE,
  SCO_MAX_PAGE_SIZE,
} from '../../src/iris/issue-rest-client.js';
import {
  IrisAuthError,
  IrisHttpError,
  IrisProtocolError,
  ValidationError,
} from '../../src/iris/iris-error.js';

const cfg = { host: 'localhost', port: 52773, namespace: 'SC', user: 'superuser', password: 'SYS' };

function pageResponse(rows: unknown[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The URL of the single fetch the client made. */
function urlOf(fetchMock: ReturnType<typeof vi.fn>): string {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error('the client made no request');
  return String(call[0]);
}

/** The query string of the single fetch the client made. */
function queryOf(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams {
  return new URL(urlOf(fetchMock)).searchParams;
}

describe('IssueRestClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('targets the scdata API on the configured namespace and web prefix', async () => {
    fetchMock.mockResolvedValueOnce(pageResponse([]));
    await new IssueRestClient({ ...cfg, namespace: 'MY NS', prefix: '/csp/' }).list();
    expect(urlOf(fetchMock)).toBe(
      'http://localhost:52773/csp/api/MY%20NS/scdata/v1/issues',
    );
  });

  describe('paging', () => {
    it('clamps a pageSize above SCO ceiling — the caller is never told it got more', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await new IssueRestClient(cfg).list({ pageSize: 50_000 });
      expect(queryOf(fetchMock).get('pageSize')).toBe(String(SCO_MAX_PAGE_SIZE));
    });

    it('a zero, negative or fractional pageSize does not become a broken query', async () => {
      const client = new IssueRestClient(cfg);
      for (const [requested, expected] of [
        [0, SCO_DEFAULT_PAGE_SIZE],
        [-10, SCO_DEFAULT_PAGE_SIZE],
        [Number.NaN, SCO_DEFAULT_PAGE_SIZE],
        [10.7, 10],
      ] as const) {
        fetchMock.mockResolvedValueOnce(pageResponse([]));
        fetchMock.mockClear();
        await client.list({ pageSize: requested });
        expect(queryOf(fetchMock).get('pageSize')).toBe(String(expected));
      }
    });

    it('a negative pageIndex is sent as 0, not as a negative offset', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await new IssueRestClient(cfg).list({ pageIndex: -3 });
      expect(queryOf(fetchMock).get('pageIndex')).toBe('0');
    });

    it('omits paging and sort params entirely when the caller sets none', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await new IssueRestClient(cfg).list();
      expect(urlOf(fetchMock)).not.toContain('?');
    });
  });

  describe('filters', () => {
    it('rejects more than 20 filters BEFORE calling SCO (which throws its own error)', async () => {
      const filters: Record<string, string> = {};
      for (let i = 0; i < 21; i++) filters[`f${i}`] = 'x';
      await expect(new IssueRestClient(cfg).list({ filters })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts exactly 20 filters (the documented ceiling, not one below it)', async () => {
      const filters: Record<string, string> = {};
      for (let i = 0; i < 20; i++) filters[`f${i}`] = 'x';
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await new IssueRestClient(cfg).list({ filters });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('drops empty filter values — an empty value matches nothing in SCO', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await new IssueRestClient(cfg).list({ filters: { status: '', severity: 2 } });
      const q = queryOf(fetchMock);
      expect(q.has('status')).toBe(false);
      expect(q.get('severity')).toBe('2');
    });

    it('escapes filter values instead of building a broken query string', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await new IssueRestClient(cfg).list({
        filters: { triggerObjectId: 'Late & Short KPI?x=1' },
      });
      const url = urlOf(fetchMock);
      expect(url).toContain('triggerObjectId=Late+%26+Short+KPI%3Fx%3D1');
      expect(queryOf(fetchMock).get('triggerObjectId')).toBe('Late & Short KPI?x=1');
    });
  });

  describe('counts', () => {
    it('reads totalCount from the header, not from the returned rows', async () => {
      fetchMock.mockResolvedValueOnce(
        pageResponse([{ uid: 'a' }], { totalCount: '8281', returnCount: '1', pageSize: '1000', pageIndex: '0' }),
      );
      const page = await new IssueRestClient(cfg).list();
      expect(page.totalCount).toBe(8281);
      expect(page.returnCount).toBe(1);
      expect(page.rows).toHaveLength(1);
    });

    it('falls back to the row count when SCO sends no paging headers', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ uid: 'a' }, { uid: 'b' }]));
      const page = await new IssueRestClient(cfg).list();
      expect(page.totalCount).toBe(2);
      expect(page.returnCount).toBe(2);
    });

    it('ignores a non-numeric header rather than reporting NaN issues', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ uid: 'a' }], { totalCount: 'lots' }));
      expect((await new IssueRestClient(cfg).list()).totalCount).toBe(1);
    });

    it('a page past the end is an empty list with the real total, not an error', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([], { totalCount: '12', returnCount: '0' }));
      const page = await new IssueRestClient(cfg).list({ pageIndex: 999 });
      expect(page.rows).toEqual([]);
      expect(page.totalCount).toBe(12);
    });
  });

  describe('body handling', () => {
    it('an object body (SCO error envelope on a 200) yields no rows, not a crash', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ Status: 'Error' } as never));
      expect((await new IssueRestClient(cfg).list()).rows).toEqual([]);
    });

    it('a non-JSON body is an IrisProtocolError', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }));
      await expect(new IssueRestClient(cfg).list()).rejects.toBeInstanceOf(IrisProtocolError);
    });
  });

  describe('get', () => {
    it('an unknown uid is null, not an error (SCO answers 404 with a body)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ Status: 'Error', Message: 'No Issue with uid [x]' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(await new IssueRestClient(cfg).get('nope')).toBeNull();
    });

    it('encodes a uid so a slash or space cannot escape the path', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ uid: 'a/b' } as never));
      await new IssueRestClient(cfg).get('a/b c');
      expect(urlOf(fetchMock)).toMatch(/\/issues\/a%2Fb%20c$/);
    });

    it('an array body is rejected — a list is not a single issue', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ uid: 'a' }]));
      expect(await new IssueRestClient(cfg).get('a')).toBeNull();
    });

    it('a 500 propagates as an IrisHttpError carrying SCO’s message', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ Message: 'Server error' }), { status: 500 }),
      );
      const err = await new IssueRestClient({ ...cfg, retries: 1 }).get('a').catch((e) => e);
      expect(err).toBeInstanceOf(IrisHttpError);
      expect((err as IrisHttpError).upstreamStatus).toBe(500);
    });

    it('maps 401 to IrisAuthError', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
      await expect(new IssueRestClient(cfg).get('a')).rejects.toBeInstanceOf(IrisAuthError);
    });
  });
});
