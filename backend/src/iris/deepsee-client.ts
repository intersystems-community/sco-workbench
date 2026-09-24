/**
 * Minimal client for the IRIS Business Intelligence "D2CLIENT" REST API
 * (`/api/deepsee/v3/{app}/Info/...`) — the same read-only surface the Angular
 * app hits through the proxy, but called server-side so cube detail (measures,
 * dimensions, listings) can be assembled and unit-tested in the backend.
 *
 * These Info endpoints are READ-ONLY: D2CLIENT has no REST endpoint to create,
 * update, or delete a cube DEFINITION (a cube is an ObjectScript class), so cube
 * write-CRUD stays class-generation + compile. This client only reads structure.
 */
import { irisFetch, redact, safeText } from './http.js';
import { httpStatusToError } from './normalize-error.js';
import { IrisProtocolError } from './iris-error.js';

export interface DeepSeeConfig {
  host: string;
  port: number;
  /** The DeepSee "application" segment in the path — the IRIS namespace (e.g. "SC"). */
  app: string;
  user: string;
  password: string;
  prefix?: string;
  /** Per-request timeout in ms (default from irisFetch: 30000). */
  timeoutMs?: number;
  /** Total attempts including the first (default from irisFetch: 3). */
  retries?: number;
}

/** A measure as returned by /Info/Measures/{cube}. */
export interface RawMeasure {
  name?: string;
  caption?: string;
  type?: string;
  hidden?: number | boolean;
  factName?: string;
}

/** A filter entry as returned by /Info/Filters/{cube} — one per level, MDX-encoded. */
export interface RawFilter {
  caption?: string;
  /** MDX spec, e.g. "[orderPlacedDate].[H1].[Year]". */
  value?: string;
  type?: string;
}

/** A listing as returned by /Info/Listings/{cube}. */
export interface RawListing {
  name?: string;
  fields?: string;
  order?: string;
  type?: string;
  source?: string;
}

/**
 * The raw D2CLIENT MDX-execute envelope, as returned by `POST /Data/MDXExecute`.
 * Shape confirmed by a live capture against the SCO integration_test image (Task-4
 * gate): `Info.Error` is the empty string `""` on success and a populated object
 * (`{ ErrorCode, ErrorMessage }`) on a genuinely malformed query; `Result.Axes[]`
 * carries the tuple members (Axis_1 = columns/measures, Axis_2 = rows), and
 * `Result.CellData[]` is a flat, row-major list of `{ ValueLogical, ValueFormatted }`.
 * The runner (Task 6) walks this; the client only parses and returns it verbatim.
 *
 * A CROSSJOIN row tuple carries one `Members` entry per crossed dimension. IRIS
 * orders those entries in the REVERSE of the CROSSJOIN() argument order, so their
 * position is NOT a reliable row-vs-series signal. Each tuple also carries a
 * self-describing `MemberInfo[]`, positionally aligned to `Members[]`, whose
 * `dimName` names the SCO dimension the member belongs to — that is the
 * authoritative way to attribute a member to the row or series axis (live IRIS
 * always includes it; the runner falls back to position only when it is absent).
 */
export interface RawMdxMemberInfo {
  /** Internal positional tuple id (e.g. "Member_1") — NOT the MDX member key. */
  memberID?: string;
  /**
   * The MDX member KEY — the value that goes inside `&[...]` in a member reference
   * (e.g. "Battery"). This is what a KPI condition's key-form needs; `memberID` is
   * an internal id and must NOT be used for that. Live IRIS includes it in the
   * MEMBERS response alongside `text`/`Name`.
   */
  memberKey?: string;
  dimName?: string;
  levelName?: string;
}
export interface RawMdxResult {
  Info?: { Error?: unknown; ColCount?: number; RowCount?: number };
  Result?: {
    Axes?: Array<{ Tuples?: Array<{ Members?: Array<{ Name?: string }>; MemberInfo?: RawMdxMemberInfo[] }> }>;
    CellData?: Array<{ ValueLogical?: unknown; ValueFormatted?: unknown }>;
  } & Record<string, unknown>;
}

export class DeepSeeClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(config: DeepSeeConfig) {
    const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
    this.base = `http://${config.host}:${config.port}${prefix}/api/deepsee/v3/${encodeURIComponent(
      config.app,
    )}`;
    this.authHeader = 'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs;
    this.retries = config.retries;
  }

  /** GET /Info/Measures/{cube} → the cube's measures. */
  async measures(cube: string): Promise<RawMeasure[]> {
    const res = await this.get(`/Info/Measures/${encodeURIComponent(cube)}`);
    return (res.Result?.Measures as RawMeasure[]) ?? [];
  }

  /** GET /Info/Filters/{cube} → one entry per dimension level (MDX-encoded). */
  async filters(cube: string): Promise<RawFilter[]> {
    const res = await this.get(`/Info/Filters/${encodeURIComponent(cube)}`);
    return (res.Result?.Filters as RawFilter[]) ?? [];
  }

  /** GET /Info/Listings/{cube} → the cube's listings. */
  async listings(cube: string): Promise<RawListing[]> {
    const res = await this.get(`/Info/Listings/${encodeURIComponent(cube)}`);
    return (res.Result?.Listings as RawListing[]) ?? [];
  }

  /**
   * POST an MDX statement to the D2CLIENT REST data surface and return the parsed
   * envelope. This is the workbench's FIRST cube-VALUE read — only `/Info/*`
   * metadata existed before. The endpoint (`/Data/MDXExecute`) and body shape
   * (`{ MDX }`) are confirmed by a live capture (Task-4 gate); the route is present
   * identically across the DeepSee REST v1/v2/v3 apps, and needs NO InterSystems
   * classes installed beyond the cube itself. Reuses the shared irisFetch (timeout
   * + 5xx retry) exactly like get(). A domain-level MDX rejection is reported inside
   * `Info.Error` (HTTP is still 200) — NOT thrown here; CubeQueryRunner decides the
   * QueryError, mirroring how get() leaves an empty Result to the caller.
   */
  async mdxExecute(mdx: string): Promise<RawMdxResult> {
    const url = `${this.base}/Data/MDXExecute`;
    const res = await irisFetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Connection: 'close',
        },
        body: JSON.stringify({ MDX: mdx }),
      },
      { timeoutMs: this.timeoutMs, attempts: this.retries, retryOn5xx: true, op: 'DeepSee MDX execute' },
    );
    if (!res.ok) {
      const text = await safeText(res);
      throw httpStatusToError(res.status, text, { op: 'DeepSee MDX execute', url: redact(url) });
    }
    try {
      return (await res.json()) as RawMdxResult;
    } catch (err) {
      throw new IrisProtocolError(`DeepSee MDX execute returned a non-JSON body: POST ${redact(url)}`, {
        cause: err,
      });
    }
  }

  /** Low-level GET returning the parsed D2CLIENT envelope ({ Info, Result }). */
  private async get(path: string): Promise<D2Response> {
    const url = `${this.base}${path}`;
    // GET is idempotent → the shared helper adds the timeout + transient/5xx
    // retry this client previously lacked entirely.
    const res = await irisFetch(
      url,
      { method: 'GET', headers: { Authorization: this.authHeader, Connection: 'close' } },
      { timeoutMs: this.timeoutMs, attempts: this.retries, retryOn5xx: true, op: 'DeepSee request' },
    );
    if (!res.ok) {
      const text = await safeText(res);
      throw httpStatusToError(res.status, text, { op: 'DeepSee request', url: redact(url) });
    }
    let json: D2Response;
    try {
      json = (await res.json()) as D2Response;
    } catch (err) {
      throw new IrisProtocolError(`DeepSee request returned a non-JSON body: GET ${redact(url)}`, {
        cause: err,
      });
    }
    // D2CLIENT reports domain errors inside Info.Error rather than an HTTP code.
    // Not thrown: "no listings/measures for X" is a normal empty case; the caller
    // treats a missing Result as empty.
    return json;
  }
}

interface D2Response {
  Info?: { Error?: unknown };
  Result?: Record<string, unknown>;
}
