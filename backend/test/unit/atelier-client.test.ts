import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AtelierClient } from '../../src/iris/atelier-client.js';
import { IrisAuthError, IrisProtocolError } from '../../src/iris/iris-error.js';

const cfg = {
  host: 'localhost',
  port: 52773,
  namespace: 'SC',
  user: 'superuser',
  password: 'SYS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AtelierClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('importClass PUTs source as a line array with Basic auth and ignoreConflict', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: { errors: [] }, console: [], result: { name: 'A.B.cls' } }),
    );
    const client = new AtelierClient(cfg);
    const src = 'Class A.B Extends %RegisteredObject\n{\n}';
    const res = await client.importClass('A.B', src);

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:52773/api/atelier/v1/SC/doc/A.B.cls?ignoreConflict=1');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('superuser:SYS').toString('base64'));
    const body = JSON.parse(init.body);
    expect(body.enc).toBe(false);
    expect(body.content).toEqual(['Class A.B Extends %RegisteredObject', '{', '}']);
  });

  it('compile POSTs a JSON array of class filenames and parses console diagnostics', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: { errors: [] },
        console: ['Compiling class A.B', 'Compilation finished successfully in 0.01s.'],
        result: {},
      }),
    );
    const client = new AtelierClient(cfg);
    const res = await client.compile(['A.B']);

    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:52773/api/atelier/v1/SC/action/compile');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(['A.B.cls']);
  });

  it('surfaces compile errors from the console', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: { errors: [] },
        console: ['ERROR: A.B.cls(2) : SyntaxError', 'Compilation finished with errors.'],
        result: {},
      }),
    );
    const client = new AtelierClient(cfg);
    const res = await client.compile(['A.B']);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/SyntaxError/);
  });

  it('readClass GETs the document and returns joined source', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: { errors: [] },
        console: [],
        result: { name: 'A.B.cls', content: ['Class A.B', '{', '}'] },
      }),
    );
    const client = new AtelierClient(cfg);
    const src = await client.readClass('A.B');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:52773/api/atelier/v1/SC/doc/A.B.cls');
    expect(init.method).toBe('GET');
    expect(src).toBe('Class A.B\n{\n}');
  });

  it('importAndCompile does PUT, a verification GET, then POST and returns the compile result', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: { errors: [] }, console: [], result: { name: 'A.B.cls' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: { errors: [] },
          console: [],
          result: { name: 'A.B.cls', content: ['Class A.B', '{', '}'] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: { errors: [] },
          console: ['Compilation finished successfully in 0.01s.'],
          result: {},
        }),
      );
    const client = new AtelierClient(cfg);
    const res = await client.importAndCompile('A.B', 'Class A.B\n{\n}');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![1].method).toBe('PUT');
    expect(fetchMock.mock.calls[1]![1].method).toBe('GET');
    expect(fetchMock.mock.calls[2]![1].method).toBe('POST');
  });

  it('throws a typed auth error on HTTP 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const client = new AtelierClient(cfg);
    await expect(client.compile(['A.B'])).rejects.toThrow(/401/);
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await expect(client.compile(['A.B'])).rejects.toBeInstanceOf(IrisAuthError);
  });

  it('throws a protocol error on a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>500</html>', { status: 200 }));
    const client = new AtelierClient(cfg);
    await expect(client.compile(['A.B'])).rejects.toBeInstanceOf(IrisProtocolError);
  });

  it('throws a protocol error when a query reports status.errors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: { errors: ['ERROR #5540: SQLCODE -30'] }, console: [], result: {} }),
    );
    const client = new AtelierClient(cfg);
    await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(IrisProtocolError);
  });

  it('honors a web prefix when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: { errors: [] }, console: [], result: {} }),
    );
    const client = new AtelierClient({ ...cfg, prefix: 'iris' });
    await client.compile(['A.B']);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:52773/iris/api/atelier/v1/SC/action/compile');
  });
});
