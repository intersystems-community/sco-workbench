import { irisFetch, redact } from './http.js';
import { IrisProtocolError } from './iris-error.js';

export interface KpiValueConfig {
  host: string;
  port: number;
  namespace: string;
  user: string;
  password: string;
  /** Optional web-app path prefix in front of /api (no leading/trailing slash). */
  prefix?: string;
  timeoutMs?: number;
  retries?: number;
}

/** The scbi kpi/values envelope. `values[]` is the success shape (`value` is
 *  `number | null` — a NULL-under-SUM stays null). Failure arrives in one of TWO
 *  shapes, and BOTH are declared here because the live endpoint has been observed
 *  emitting each (see `irisErrorText`):
 *    A. `{ Status:"Error", Message:"…#NNNN…" }`      — the SCO-style envelope
 *    B. `{ errors:[{ code, error, … }], summary }`   — the %Status/Atelier-style envelope */
export interface RawKpiValuesBody {
  kpiName?: string;
  expandDimension?: string;
  values?: { label: string; value: number | null }[];
  /** Shape A: `"Error"` when the call failed. */
  Status?: string;
  /** Shape A: the error text, carrying an IRIS `#NNNN` code. */
  Message?: string;
  /** Shape B: one entry per IRIS error; `error` carries the `#NNNN` text. */
  errors?: { code?: number; domain?: string; error?: string; id?: string; params?: unknown[] }[];
  /** Shape B: the flattened error text (same `#NNNN` content as `errors[0].error`). */
  summary?: string;
}

/** The completed HTTP exchange, status + parsed body. A 500/404 is NOT an exception here. */
export interface RawKpiValuesResult {
  status: number;
  body: RawKpiValuesBody;
}

/** The classification of a completed KPI-values exchange. `ok` is the success shape;
 *  every other kind is a domain error each reader reacts to differently (D3 throws a
 *  typed error, health degrades). Defined ONCE here so the two readers cannot fork on
 *  "what is a value error" (B-11). Mirrors the three-way branch in KpiValueReader. */
export type KpiValueClass =
  | { kind: 'ok' }
  | { kind: 'query'; message?: string }      // 500 + Status:Error  → SC-2643 un-evaluatable
  | { kind: 'notfound'; message?: string }   // non-500 + Status:Error → missing KPI
  | { kind: 'http'; status: number };        // non-200 / non-array values → protocol/HTTP fault

/**
 * The error text IRIS reported, from EITHER failure envelope — or undefined when the
 * body carries no error at all.
 *
 * Two shapes exist because the live SCO endpoint has emitted both, and which one you
 * get is not ours to control:
 *
 *   A. `{ Status:"Error", Message:"…#NNNN…" }` — what this classifier originally
 *      keyed on, and what the unit tests pin.
 *   B. `{ errors:[{ code:5002, error:"…#5002 … <INVALID OREF>…" }], summary:"…" }` —
 *      observed live on 2026-09-10 for EVERY un-evaluatable KPI condition (a bad MDX
 *      fragment, a non-MDX string, even a blank one), all of them
 *      `#5002 <INVALID OREF>ConstructKpiValueResponse`.
 *
 * Shape B used to be unreachable — kpi-values.ts still carries the note that
 * `<INVALID OREF>` "does not appear on the live instance (verified 2026-08-23)" — so
 * recognizing only shape A was correct when it was written. It no longer is: with
 * shape B unrecognized, every un-evaluatable KPI fell past the `query` branch into
 * `http`, and the product path answered **502 SCO_HTTP "Unexpected KPI values
 * response"** — a gateway fault, blaming the plumbing — for what is a 422
 * QUERY_FAILED: the author's own query. Matching BOTH shapes is what keeps the
 * classification about the CAUSE rather than about which envelope IRIS chose.
 *
 * `errors` must be non-empty to count: an empty array is not an error report.
 *
 * Exported so the SC-2701 integration probe harvests the `#NNNN` text through the SAME
 * extraction the product uses. Reading `body.Message` directly is what left that harness
 * reporting `raw #=undefined` against this envelope, and a test instrument that cannot
 * see the evidence it exists to collect is worse than no instrument.
 */
export function irisErrorText(body: RawKpiValuesBody): string | undefined {
  if (body.Status === 'Error') return body.Message;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return body.summary ?? body.errors[0]?.error;
  }
  if (body.summary) return body.summary;
  return undefined;
}

export function classifyKpiValue(status: number, body: RawKpiValuesBody): KpiValueClass {
  // A PURE WIDENING of the original two-line branch: wherever `body.Status === 'Error'`
  // was the trigger, "IRIS reported an error in either envelope" now is. A body carrying
  // neither envelope classifies exactly as before, so `ok` and genuine protocol faults
  // are untouched — the only responses that move are the ones that were being called a
  // gateway fault while carrying a perfectly clear IRIS error.
  const error = irisErrorText(body);
  // 500 + an IRIS error = the endpoint RAN and could not evaluate this KPI: the query is
  // at fault, not the connection.
  if (status === 500 && error !== undefined) return { kind: 'query', message: error };
  // An IRIS error on any other status is the missing-KPI family. It keys on the BODY, not
  // the HTTP code, because the sibling listings endpoint reports it inside a 200.
  if (error !== undefined) return { kind: 'notfound', message: error };
  if (status !== 200 || !Array.isArray(body.values)) return { kind: 'http', status };
  return { kind: 'ok' };
}

/** Port: read a KPI's values, optionally expanded over one of its dimensions. */
export interface KpiValueClient {
  values(kpi: string, expandDimension?: string): Promise<RawKpiValuesResult>;
}

/**
 * Reads SCO's Business KPI VALUES endpoint (`GET /api/{ns}/scbi/v1/kpi/values/{name}`) —
 * the values sibling of `KpiRestClient` (which owns definitions). Basic auth is injected
 * server-side. Unlike `KpiRestClient.request`, this does NOT map a non-2xx status to a
 * typed error: a `500`/`404` from this endpoint is a DOMAIN signal (SC-2643 / not-found)
 * the KpiValueReader must inspect (`body.Status`), so the client returns `{ status, body }`
 * verbatim — exactly as `DeepSeeClient.mdxExecute` returns `Info.Error` in a 200 and lets
 * the runner decide. `retryOn5xx` is false: the dominant 500 (SC-2643) is deterministic, so
 * retrying it wastes latency; a transient socket drop still gets irisFetch's socket-retry.
 */
export class ScbiKpiValueClient implements KpiValueClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(config: KpiValueConfig) {
    const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
    this.base = `http://${config.host}:${config.port}${prefix}/api/${encodeURIComponent(config.namespace)}/scbi/v1`;
    this.authHeader = 'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs;
    this.retries = config.retries;
  }

  async values(kpi: string, expandDimension?: string): Promise<RawKpiValuesResult> {
    const qs = expandDimension ? `?expandDimension=${encodeURIComponent(expandDimension)}` : '';
    const url = `${this.base}/kpi/values/${encodeURIComponent(kpi)}${qs}`;
    const res = await irisFetch(
      url,
      { method: 'GET', headers: { Authorization: this.authHeader, Connection: 'close' } },
      { timeoutMs: this.timeoutMs, attempts: this.retries, retryOn5xx: false, op: 'KPI values' },
    );
    let body: RawKpiValuesBody;
    try {
      body = (await res.json()) as RawKpiValuesBody;
    } catch (err) {
      throw new IrisProtocolError(`KPI values returned a non-JSON body: GET ${redact(url)}`, { cause: err });
    }
    return { status: res.status, body };
  }
}
