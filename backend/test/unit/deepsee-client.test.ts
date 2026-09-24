import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepSeeClient } from '../../src/iris/deepsee-client.js';
import { IrisHttpError, IrisProtocolError } from '../../src/iris/iris-error.js';
import mdxSample from './fixtures/mdx-result.sample.json' with { type: 'json' };
import mdxError from './fixtures/mdx-error.sample.json' with { type: 'json' };

const cfg = { host: 'localhost', port: 52773, app: 'SC', user: 'superuser', password: 'SYS' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeepSeeClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns measures from the Result envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Info: {}, Result: { Measures: [{ name: 'Total' }] } }),
    );
    const client = new DeepSeeClient(cfg);
    const measures = await client.measures('MyCube');
    expect(measures).toEqual([{ name: 'Total' }]);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:52773/api/deepsee/v3/SC/Info/Measures/MyCube');
  });

  it('treats a missing Result as empty (no throw)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Info: { Error: { ErrorMessage: 'no cube' } } }));
    const client = new DeepSeeClient(cfg);
    expect(await client.measures('Nope')).toEqual([]);
  });

  it('throws a typed http error when a 5xx persists across all retries', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new DeepSeeClient(cfg);
    await expect(client.measures('X')).rejects.toBeInstanceOf(IrisHttpError);
  });

  it('throws a protocol error on a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    const client = new DeepSeeClient(cfg);
    await expect(client.measures('X')).rejects.toBeInstanceOf(IrisProtocolError);
  });

  it('retries an idempotent 5xx then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ Result: { Measures: [] } }));
    const client = new DeepSeeClient(cfg);
    expect(await client.measures('X')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('DeepSeeClient.mdxExecute', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the MDX to the Data/MDXExecute surface and returns the parsed envelope', async () => {
    // mdxSample is a REAL D2CLIENT envelope captured live (SalesOrderCube, SCO
    // integration_test image) — see the Task-4 gate capture.
    fetchMock.mockResolvedValueOnce(jsonResponse(mdxSample));
    const client = new DeepSeeClient(cfg);
    const res = await client.mdxExecute('SELECT {[Measures].[totalOrderValue]} ON 0 FROM [SalesOrderCube]');
    expect(res).toBeDefined();
    expect((res as { Result?: unknown }).Result).toBeDefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:52773/api/deepsee/v3/SC/Data/MDXExecute');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      MDX: 'SELECT {[Measures].[totalOrderValue]} ON 0 FROM [SalesOrderCube]',
    });
  });

  it('throws a typed http error when the Data surface returns a 5xx across retries', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new DeepSeeClient(cfg);
    await expect(client.mdxExecute('SELECT 1')).rejects.toBeInstanceOf(IrisHttpError);
  });

  it('throws a protocol error on a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not json', { status: 200 }));
    const client = new DeepSeeClient(cfg);
    await expect(client.mdxExecute('SELECT 1')).rejects.toBeInstanceOf(IrisProtocolError);
  });

  it('surfaces an MDX-rejection body (Info.Error present) so the runner can map it to QueryError', async () => {
    // mdxError is the REAL error envelope (bad measure): Info.Error is a populated
    // object, not the empty string success carries. mdxExecute returns it as-is;
    // CubeQueryRunner (Task 6) decides QueryError.
    fetchMock.mockResolvedValueOnce(jsonResponse(mdxError));
    const client = new DeepSeeClient(cfg);
    const res = (await client.mdxExecute('SELECT {[Measures].[nope]} ON 0 FROM [SalesOrderCube]')) as {
      Info?: { Error?: unknown };
    };
    expect(res.Info?.Error).toBeTruthy();
  });
});
