import {
  parseCompileResult,
  parseImportResult,
  toMessage,
  type AtelierResponse,
  type ParsedResult,
} from './errors.js';
import { irisFetch, redact, safeText } from './http.js';
import { httpStatusToError } from './normalize-error.js';
import { IrisProtocolError } from './iris-error.js';
import type { SqlQueryOptions } from './schema-ops.js';

export interface AtelierConfig {
  host: string;
  port: number;
  namespace: string;
  user: string;
  password: string;
  /** Optional web-app path prefix in front of /api/atelier (no leading/trailing slash). */
  prefix?: string;
  /** Per-request timeout in ms (default from irisFetch: 30000). */
  timeoutMs?: number;
  /** Total attempts including the first (default from irisFetch: 3). */
  retries?: number;
}

interface DocResult {
  name: string;
  content?: string[];
}

/**
 * Client for the InterSystems IRIS Atelier Source Code REST API.
 *
 * Endpoints (over the IRIS web port, default 52773):
 *   PUT  /api/atelier/v1/{ns}/doc/{Class}.cls?ignoreConflict=1   — upload source
 *   GET  /api/atelier/v1/{ns}/doc/{Class}.cls                    — read source back
 *   POST /api/atelier/v1/{ns}/action/compile                     — compile classes
 *
 * All requests use HTTP Basic auth. We never mutate arguments; every call builds
 * a fresh request.
 */
export class AtelierClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(config: AtelierConfig) {
    const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
    this.base = `http://${config.host}:${config.port}${prefix}/api/atelier/v1/${encodeURIComponent(
      config.namespace,
    )}`;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs;
    this.retries = config.retries;
  }

  /** Upload class source. Source is split into a line array as the API expects. */
  async importClass(className: string, source: string): Promise<ParsedResult> {
    const url = `${this.base}/doc/${className}.cls?ignoreConflict=1`;
    const body = { enc: false, content: splitLines(source) };
    const res = await this.request<DocResult>(url, 'PUT', body);
    return parseImportResult(res);
  }

  /** Read class source back and return it joined into a single string. */
  async readClass(className: string): Promise<string> {
    const url = `${this.base}/doc/${className}.cls`;
    const res = await this.request<DocResult>(url, 'GET');
    return (res.result?.content ?? []).join('\n');
  }

  /**
   * Run a SQL statement via the Atelier `/action/query` endpoint. Returns the
   * `result.content` rows. Used for schema introspection (%Dictionary.*), which the
   * Native SDK can't do cleanly (object callbacks), and for the DML the endpoint also
   * accepts.
   *
   * `options` overrides the transport for THIS statement only. It exists for the
   * statements whose runtime has nothing to do with a schema query's: a `LOAD DATA` of
   * 150,000 rows needs minutes, not the 30s default, and must not be retried — a
   * timed-out write may well still be running inside IRIS, so a second attempt would
   * race the first.
   */
  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
    options: SqlQueryOptions = {},
  ): Promise<Row[]> {
    const url = `${this.base}/action/query`;
    const res = await this.request<{ content?: Row[] }>(
      url,
      'POST',
      { query: sql, parameters },
      options,
    );
    if (res.status?.errors?.length) {
      throw new IrisProtocolError(
        `SCO query failed: ${res.status.errors.map(toMessage).join('; ')}`,
        { details: { errors: res.status.errors } },
      );
    }
    return res.result?.content ?? [];
  }

  /** Compile one or more classes. Names may omit the `.cls` suffix. */
  async compile(classNames: string[]): Promise<ParsedResult> {
    const url = `${this.base}/action/compile`;
    const body = classNames.map((n) => (n.endsWith('.cls') ? n : `${n}.cls`));
    const res = await this.request<unknown>(url, 'POST', body);
    return parseCompileResult(res);
  }

  /**
   * Import a class, re-read it to confirm the content landed (the PUT body is
   * unreliable per the Atelier docs), then compile. Returns the compile result;
   * if the import itself failed, that is returned instead.
   */
  async importAndCompile(className: string, source: string): Promise<ParsedResult> {
    const imported = await this.importClass(className, source);
    if (!imported.ok) return imported;
    // Best-effort verification read; ignore failures here since compile is authoritative.
    try {
      await this.readClass(className);
    } catch {
      // non-fatal
    }
    return this.compile([className]);
  }

  /**
   * Low-level JSON request against the Atelier API. Uses the shared `irisFetch`
   * (timeout + transient retry). GET/PUT/compile are idempotent so a transient
   * 5xx is retried; a non-2xx maps to a typed error. A malformed JSON body maps
   * to `IrisProtocolError`.
   */
  private async request<T>(
    url: string,
    method: 'GET' | 'PUT' | 'POST',
    body?: unknown,
    options: SqlQueryOptions = {},
  ): Promise<AtelierResponse<T>> {
    const attempts = options.attempts ?? this.retries;
    const res = await irisFetch(
      url,
      {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Connection: 'close',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      {
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        attempts,
        // A single-attempt caller has opted out of retries entirely, 5xx included.
        retryOn5xx: attempts !== 1,
        op: 'Atelier request',
      },
    );

    if (!res.ok) {
      const text = await safeText(res);
      throw httpStatusToError(res.status, text, { op: 'Atelier request', url: redact(url) });
    }

    let json: Partial<AtelierResponse<T>>;
    try {
      json = (await res.json()) as Partial<AtelierResponse<T>>;
    } catch (err) {
      throw new IrisProtocolError(
        `Atelier request returned a non-JSON body: ${method} ${redact(url)}`,
        { cause: err },
      );
    }
    return {
      status: json.status ?? { errors: [] },
      console: json.console ?? [],
      result: (json.result ?? {}) as T,
    };
  }
}

function splitLines(source: string): string[] {
  return source.replace(/\r\n/g, '\n').split('\n');
}
