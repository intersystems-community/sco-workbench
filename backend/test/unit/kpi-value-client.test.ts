import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScbiKpiValueClient, classifyKpiValue } from '../../src/iris/kpi-value-client.js';
import { IrisProtocolError } from '../../src/iris/iris-error.js';

const config = { host: 'h', port: 52773, namespace: 'SC', user: 'u', password: 'p' };

/** Stub the global fetch with one canned Response; capture the URL it was called with. */
function stubFetch(status: number, body: unknown, ok = status >= 200 && status < 300) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('ScbiKpiValueClient', () => {
  it('returns { status, body } for a 200 scalar envelope', async () => {
    stubFetch(200, { kpiName: 'K', values: [{ label: 'kpi', value: 35 }] });
    const client = new ScbiKpiValueClient(config);
    const res = await client.values('K');
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual([{ label: 'kpi', value: 35 }]);
  });

  it('does NOT throw on a 500 with a Status:Error body — it returns it for the core to map (SC-2643)', async () => {
    stubFetch(500, { Status: 'Error', Message: 'ERROR #5001: Empty or invalid WHERE clause' }, false);
    const client = new ScbiKpiValueClient(config);
    const res = await client.values('BadKpi');
    expect(res.status).toBe(500);
    expect(res.body.Status).toBe('Error');
  });

  it('encodes the KPI name and appends expandDimension as a query param', async () => {
    const calls = stubFetch(200, { kpiName: 'K', expandDimension: 'quantityStatus', values: [] });
    const client = new ScbiKpiValueClient(config);
    await client.values('a b', 'quantityStatus');
    expect(calls[0]).toContain('/api/SC/scbi/v1/kpi/values/a%20b');
    expect(calls[0]).toContain('expandDimension=quantityStatus');
  });

  it('throws IrisProtocolError on a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); }, text: async () => 'oops' } as unknown as Response)));
    const client = new ScbiKpiValueClient(config);
    await expect(client.values('K')).rejects.toBeInstanceOf(IrisProtocolError);
  });
});

describe('classifyKpiValue — the shared three-way value classifier (B-11)', () => {
  it('500 + Status:Error → query (SC-2643)', () => {
    expect(classifyKpiValue(500, { Status: 'Error', Message: 'ERROR #5001' })).toEqual({ kind: 'query', message: 'ERROR #5001' });
  });
  it('non-500 + Status:Error → notfound', () => {
    expect(classifyKpiValue(404, { Status: 'Error', Message: 'KPI not defined (K).' })).toEqual({ kind: 'notfound', message: 'KPI not defined (K).' });
  });
  it('non-200 without a Status:Error body → http (the third branch — must not be omitted, review #2)', () => {
    expect(classifyKpiValue(502, {})).toEqual({ kind: 'http', status: 502 });
  });
  it('200 with a non-array values → http (protocol shape)', () => {
    expect(classifyKpiValue(200, { values: undefined })).toEqual({ kind: 'http', status: 200 });
  });
  it('200 with a values array → ok', () => {
    expect(classifyKpiValue(200, { values: [{ label: 'k', value: 35 }] })).toEqual({ kind: 'ok' });
  });
});

/**
 * The SECOND failure envelope. The live SCO values endpoint reports an un-evaluatable
 * KPI as `{ errors:[{ code, error }], summary }` (%Status/Atelier style) rather than
 * `{ Status:"Error", Message }` — observed 2026-09-10 for every bad MDX condition, all
 * `#5002 <INVALID OREF>ConstructKpiValueResponse`.
 *
 * Unrecognized, those fell past `query` into `http`, so the product path answered 502
 * SCO_HTTP ("Unexpected KPI values response") — a GATEWAY fault — for what is the
 * author's own bad query, a 422. These tests pin the widening, and specifically pin the
 * DISTINCTION: a 500 that carries an IRIS error is `query`, a 500 that carries nothing
 * interpretable is still `http`. Collapsing those two would hide a genuine outage behind
 * "your query is invalid".
 */
describe('classifyKpiValue — the %Status-style { errors[], summary } envelope', () => {
  /** The verbatim live body (Arabic locale — `خطأ #5002` = "Error #5002"). */
  const liveError = {
    errors: [
      {
        code: 5002,
        domain: '%ObjectErrors',
        error: 'خطأ #5002: ObjectScript error: <INVALID OREF>ConstructKpiValueResponse+2^SC.Core.API.KPI.KpiApiImpl.1',
        id: 'ObjectScriptError',
      },
    ],
    summary: 'خطأ #5002: ObjectScript error: &lt;INVALID OREF&gt;ConstructKpiValueResponse+2^SC.Core.API.KPI.KpiApiImpl.1',
  };

  it('500 + errors[] → query, NOT http (the 502-instead-of-422 bug)', () => {
    const cls = classifyKpiValue(500, liveError);
    expect(cls.kind).toBe('query');
    // The message must carry the #NNNN code through — it is the only locale-independent
    // evidence of WHY the query failed, and the reader puts it in details.upstream.
    expect((cls as { message?: string }).message).toMatch(/#\d+/);
  });

  it('prefers `summary`, and falls back to errors[0].error when there is no summary', () => {
    expect(classifyKpiValue(500, liveError)).toEqual({ kind: 'query', message: liveError.summary });
    expect(classifyKpiValue(500, { errors: liveError.errors })).toEqual({
      kind: 'query',
      message: liveError.errors[0]!.error,
    });
  });

  it('a bare `summary` with no errors[] still counts as an IRIS error', () => {
    expect(classifyKpiValue(500, { summary: 'ERROR #5001: MDX is invalid' })).toEqual({
      kind: 'query',
      message: 'ERROR #5001: MDX is invalid',
    });
  });

  it('non-500 + errors[] → notfound, matching the Status:Error rule', () => {
    expect(classifyKpiValue(404, liveError)).toEqual({ kind: 'notfound', message: liveError.summary });
  });

  it('an EMPTY errors[] is not an error report → still http', () => {
    // `errors: []` carries no diagnosis, so calling it a query failure would invent one.
    expect(classifyKpiValue(500, { errors: [] })).toEqual({ kind: 'http', status: 500 });
  });

  it('a 500 with NO interpretable IRIS error stays http — an outage must not read as a bad query', () => {
    expect(classifyKpiValue(500, {})).toEqual({ kind: 'http', status: 500 });
    expect(classifyKpiValue(500, { kpiName: 'K' })).toEqual({ kind: 'http', status: 500 });
  });

  it('a successful 200 is unaffected by the widening', () => {
    // Regression guard: the success shape must not be re-read as an error because some
    // future body gains an empty errors[] alongside real values.
    expect(classifyKpiValue(200, { values: [{ label: 'k', value: 1 }], errors: [] })).toEqual({ kind: 'ok' });
  });
});
