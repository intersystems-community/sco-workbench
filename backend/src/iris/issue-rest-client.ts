import { irisFetch, redact, safeText } from './http.js';
import { httpStatusToError } from './normalize-error.js';
import { IrisProtocolError, NotFoundError, ValidationError } from './iris-error.js';

export interface IssueRestConfig {
  host: string;
  port: number;
  namespace: string;
  user: string;
  password: string;
  /** Optional web-app path prefix in front of /api (no leading/trailing slash). */
  prefix?: string;
  /** Per-request timeout in ms (default from irisFetch: 30000). */
  timeoutMs?: number;
  /** Total attempts including the first (default from irisFetch: 3). */
  retries?: number;
}

/** SCO clamps pageSize to this (SC.Core.API.ApiBaseImpl MAXPAGESIZE = 1000). */
export const SCO_MAX_PAGE_SIZE = 1000;
/** SCO's page size when the request omits pageSize (DEFAULTPAGESIZE = 100). */
export const SCO_DEFAULT_PAGE_SIZE = 100;
/**
 * SCO throws "Only 20 filters can be applied to a search." above this. Its real
 * limit is 20 BOUND PARAMETERS, not 20 attributes: a comma-separated value or a
 * `min..max` range spends one per value. This is a cheap upper guard, so a caller
 * can still trip SCO's limit with one many-valued filter.
 */
export const SCO_MAX_FILTERS = 20;

/**
 * One issue as SCO returns it. Every field is optional: the API omits empty
 * values rather than sending null (`if value '= "" do obj.%Set(...)`), so an
 * unanalyzed issue simply has no `urgency`/`issueData` key at all.
 */
export interface ScoIssue {
  uid?: string;
  /** Present only on the single-issue read (GetIssueById adds the row ID). */
  ID?: string;
  description?: string;
  severity?: number;
  urgency?: number;
  status?: string;
  triggerType?: string;
  triggerObjectId?: string;
  impactedObjectType?: string;
  impactedObjectId?: string;
  issueData?: string;
  resolutionNote?: string;
  recordCreatedTime?: string;
  /** Present only on the single-issue read, when an analysis has run. */
  latestAnalysis?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScoIssuePage {
  rows: ScoIssue[];
  /** From the totalCount response header — rows matching the filter, not the page. */
  totalCount: number;
  /** From the returnCount response header — rows in THIS page. */
  returnCount: number;
  pageSize: number;
  pageIndex: number;
}

export interface ScoIssueQuery {
  /** Attribute name → value. A comma in a value makes SCO build an SQL IN list. */
  filters?: Record<string, string | number>;
  pageSize?: number;
  pageIndex?: number;
  /** Attribute name, `-name` for descending. Default: `-recordCreatedTime`. */
  sortBy?: string;
}

/**
 * Client for SCO's Issue data API — the same endpoints the SCO UI uses
 * (`SC.Core.API.Data.IssueApiImpl`), over the web port, base `/api/{ns}/scdata/v1`:
 *   GET /issues              — paged + filtered + sorted list
 *   GET /issues/{uid}        — one issue, plus its ID and latestAnalysis
 *
 * Filtering is server-side because the API is paged and capped: 12k+ issues cannot
 * be pulled into the browser to filter there. Any attribute of the class is a valid
 * query parameter and matches by equality; UNKNOWN parameters are silently ignored
 * (SCO iterates its own attribute list, not the request), so a typo'd filter returns
 * everything rather than erroring — callers must pass real attribute names.
 *
 * Basic auth is injected server-side and never reaches the browser.
 */
export class IssueRestClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(config: IssueRestConfig) {
    const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
    this.base = `http://${config.host}:${config.port}${prefix}/api/${encodeURIComponent(
      config.namespace,
    )}/scdata/v1`;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs;
    this.retries = config.retries;
  }

  /**
   * List issues. pageSize is clamped to SCO_MAX_PAGE_SIZE here as well as by SCO,
   * so the caller's `rows.length` never silently disagrees with what it asked for.
   */
  async list(query: ScoIssueQuery = {}): Promise<ScoIssuePage> {
    const filters = query.filters ?? {};
    const names = Object.keys(filters);
    if (names.length > SCO_MAX_FILTERS) {
      throw new ValidationError(
        `SCO accepts at most ${SCO_MAX_FILTERS} filters per search; got ${names.length}.`,
      );
    }
    const params = new URLSearchParams();
    for (const name of names) {
      const value = filters[name];
      if (value === undefined || value === '') continue;
      params.set(name, String(value));
    }
    const pageSize = clampPageSize(query.pageSize);
    if (pageSize !== undefined) params.set('pageSize', String(pageSize));
    if (query.pageIndex !== undefined) params.set('pageIndex', String(pageIndex(query.pageIndex)));
    if (query.sortBy) params.set('sortBy', query.sortBy);

    const qs = params.toString();
    const res = await this.request(`/issues${qs ? `?${qs}` : ''}`);
    const rows = Array.isArray(res.body) ? (res.body as ScoIssue[]) : [];
    return {
      rows,
      totalCount: headerNumber(res.headers, 'totalcount', rows.length),
      returnCount: headerNumber(res.headers, 'returncount', rows.length),
      pageSize: headerNumber(res.headers, 'pagesize', pageSize ?? SCO_DEFAULT_PAGE_SIZE),
      pageIndex: headerNumber(res.headers, 'pageindex', query.pageIndex ?? 0),
    };
  }

  /** Read one issue by uid. Returns null when SCO reports it absent (404). */
  async get(uid: string): Promise<ScoIssue | null> {
    try {
      const res = await this.request(`/issues/${encodeURIComponent(uid)}`);
      const body = res.body;
      return body && typeof body === 'object' && !Array.isArray(body) ? (body as ScoIssue) : null;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * GET with the paging headers preserved — the row count the UI needs lives in
   * `totalCount`, not the body. Reads are idempotent, so a transient 5xx retries.
   */
  private async request(path: string): Promise<{ body: unknown; headers: Headers }> {
    const url = `${this.base}${path}`;
    const res = await irisFetch(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          Connection: 'close',
        },
      },
      { timeoutMs: this.timeoutMs, attempts: this.retries, retryOn5xx: true, op: 'issue request' },
    );
    if (!res.ok) {
      throw httpStatusToError(res.status, await safeText(res), {
        op: 'issue request',
        url: redact(url),
      });
    }
    try {
      return { body: await res.json(), headers: res.headers };
    } catch (err) {
      throw new IrisProtocolError(
        `Issue request returned a non-JSON body: GET ${redact(url)}`,
        { cause: err },
      );
    }
  }
}

/** Clamp to SCO's ceiling; a non-positive or non-finite request falls back to the default. */
function clampPageSize(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  if (!Number.isFinite(requested) || requested < 1) return SCO_DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(requested), SCO_MAX_PAGE_SIZE);
}

function pageIndex(requested: number): number {
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
}

/** SCO's paging headers are decimal strings; a missing or junk value uses the fallback. */
function headerNumber(headers: Headers, name: string, fallback: number): number {
  const raw = headers.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
