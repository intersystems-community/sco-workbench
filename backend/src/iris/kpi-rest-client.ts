import type { KpiDefinition } from '../kpi/kpi-definition.model.js';
import { irisFetch, redact, safeText } from './http.js';
import { httpStatusToError } from './normalize-error.js';
import { IrisProtocolError, NotFoundError } from './iris-error.js';

export interface KpiRestConfig {
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

/**
 * Client for SCO's Business KPI REST API — the SAME endpoints the Angular
 * workbench uses, so agent-mode KPI writes go through the identical, supported
 * path (`SC.Core.API.KPI.KpiApiImpl`) rather than reinventing the save via the
 * Native SDK.
 *
 * Endpoints (over the IRIS web port, default 52773), base `/api/{ns}/scbi/v1`:
 *   GET    /kpi/definitions            — list all KPI definitions
 *   POST   /kpi/definitions            — create one (JSON body); 400 if it exists
 *   GET    /kpi/definitions/{name}     — read one back
 *   PUT    /kpi/definitions/{name}     — update one (keyed by ORIGINAL name)
 *   DELETE /kpi/definitions/{name}     — delete one
 *
 * All requests use HTTP Basic auth, injected server-side (never reaches the
 * browser/model). We never mutate arguments; every call builds a fresh request.
 */
export class KpiRestClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(config: KpiRestConfig) {
    const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
    this.base = `http://${config.host}:${config.port}${prefix}/api/${encodeURIComponent(
      config.namespace,
    )}/scbi/v1`;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs;
    this.retries = config.retries;
  }

  /** List every KPI definition. */
  async list(): Promise<KpiDefinition[]> {
    const res = await this.request<KpiDefinition[] | { error?: string }>('/kpi/definitions', 'GET');
    return Array.isArray(res) ? res : [];
  }

  /**
   * Read one KPI definition by name. Returns null if IRIS reports it absent —
   * SCO signals "no such KPI" with an HTTP 404 `{ Status, Message }` body, so we
   * catch the typed NotFoundError and normalize it to null (the documented
   * contract that `sco_get_kpi` and the frontend rely on). Other errors
   * propagate.
   */
  async get(name: string): Promise<KpiDefinition | null> {
    let res: KpiDefinition | { error?: string };
    try {
      res = await this.request<KpiDefinition | { error?: string }>(
        `/kpi/definitions/${encodeURIComponent(name)}`,
        'GET',
      );
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    return isKpiDefinition(res) ? res : null;
  }

  /** Create a KPI definition. IRIS returns 400 if a KPI with that name exists. */
  async create(def: KpiDefinition): Promise<KpiDefinition> {
    return (await this.request<KpiDefinition>('/kpi/definitions', 'POST', def)) as KpiDefinition;
  }

  /**
   * Update a KPI definition. The SCO API keys by the ORIGINAL name in the URL, so
   * a rename passes the old name as `name` and the new name inside `def`.
   */
  async update(name: string, def: KpiDefinition): Promise<KpiDefinition> {
    return (await this.request<KpiDefinition>(
      `/kpi/definitions/${encodeURIComponent(name)}`,
      'PUT',
      def,
    )) as KpiDefinition;
  }

  /** Delete a KPI definition by name. */
  async delete(name: string): Promise<void> {
    await this.request<unknown>(`/kpi/definitions/${encodeURIComponent(name)}`, 'DELETE');
  }

  /**
   * Low-level JSON request with a small retry for transient socket drops (the
   * IRIS web gateway may close keep-alive connections). Mirrors AtelierClient.
   * On an HTTP error it surfaces the SCO error body (KpiApiImpl returns a JSON
   * `{ error, message }` with a 400/500 status) so the tool can relay the real
   * reason (e.g. "KPI already exists", "Invalid KPI definition found").
   */
  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    // GET/PUT/DELETE are idempotent → safe to retry a transient 5xx. A POST
    // create is NOT: a transient 5xx after IRIS committed would create a
    // duplicate KPI, so we never retry it on 5xx.
    const retryOn5xx = method !== 'POST';
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
      { timeoutMs: this.timeoutMs, attempts: this.retries, retryOn5xx, op: 'KPI request' },
    );
    if (!res.ok) {
      const text = await safeText(res);
      // Surfaces the SCO error body (KpiApiImpl returns { error/Error, message/Message }
      // with a 400/500 status — e.g. a duplicate create is a 400 "KPI already
      // exists"). httpStatusToError keeps the body text in the message + details;
      // the tool layer classifies "already exists" as a conflict.
      throw httpStatusToError(res.status, text, { op: 'KPI request', url: redact(url) });
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new IrisProtocolError(
        `KPI request returned a non-JSON body: ${method} ${redact(url)}`,
        { cause: err },
      );
    }
  }
}

/** A create/get response is a real definition only if it carries a name. */
function isKpiDefinition(v: unknown): v is KpiDefinition {
  return !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string';
}
