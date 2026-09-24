import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KpiRestClient } from '../../src/iris/kpi-rest-client.js';
import {
  IrisAuthError,
  IrisHttpError,
  IrisProtocolError,
  NotFoundError,
  ConflictError,
} from '../../src/iris/iris-error.js';

const cfg = { host: 'localhost', port: 52773, namespace: 'SC', user: 'superuser', password: 'SYS' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('KpiRestClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list returns [] for a non-array body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }));
    const client = new KpiRestClient(cfg);
    expect(await client.list()).toEqual([]);
  });

  it('get returns null when the body carries no name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = new KpiRestClient(cfg);
    expect(await client.get('Nope')).toBeNull();
  });

  it('surfaces the SCO error body on a 400 (capital-M Message) as an IrisHttpError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Status: 'Error', Message: 'KPI already exists' }, 400),
    );
    const client = new KpiRestClient(cfg);
    const err = await client.create({ name: 'Dup' } as never).catch((e) => e);
    expect(err).toBeInstanceOf(IrisHttpError);
    expect(err.message).toMatch(/already exists/);
    expect((err as IrisHttpError).upstreamStatus).toBe(400);
  });

  it('maps 401 to IrisAuthError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const client = new KpiRestClient(cfg);
    await expect(client.list()).rejects.toBeInstanceOf(IrisAuthError);
  });

  it('get() normalizes a 404 (SCO "no such KPI") to null', async () => {
    // SCO returns 404 { Status, Message } for a missing KPI; get() must honor
    // its documented "returns null if absent" contract.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Status: 'Error', Message: 'No Kpi with given name' }), { status: 404 }),
    );
    const client = new KpiRestClient(cfg);
    expect(await client.get('X')).toBeNull();
  });

  it('maps a 404 on a non-get call to NotFoundError, and 409 to ConflictError', async () => {
    const client = new KpiRestClient(cfg);
    fetchMock.mockResolvedValue(new Response('gone', { status: 404 }));
    await expect(client.update('X', { name: 'X' } as never)).rejects.toBeInstanceOf(NotFoundError);

    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }));
    await expect(client.create({ name: 'X' } as never)).rejects.toBeInstanceOf(ConflictError);
  });

  it('does NOT retry a POST create on a transient 5xx (avoids duplicate KPIs)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Message: 'busy' }, 503));
    const client = new KpiRestClient(cfg);
    await expect(client.create({ name: 'X' } as never)).rejects.toBeInstanceOf(IrisHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns void on a 204 delete', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new KpiRestClient(cfg);
    await expect(client.delete('X')).resolves.toBeUndefined();
  });

  it('throws a protocol error on a non-JSON success body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    const client = new KpiRestClient(cfg);
    await expect(client.list()).rejects.toBeInstanceOf(IrisProtocolError);
  });
});
