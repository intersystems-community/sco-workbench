import { irisFetch, redact, safeText } from './http.js';
import { httpStatusToError } from './normalize-error.js';
import { IrisProtocolError, NotFoundError } from './iris-error.js';

export interface ScModelRestConfig {
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
 * Read client for SCO's Data Model REST API — the SAME endpoints the Angular Data
 * Model page uses (`/api/{ns}/scmodel/v1`), so what the assistant reads is exactly
 * what the user sees on that page: the SCO object list and one object's attributes
 * and relationships, INCLUDING custom objects and attributes.
 *
 * This is deliberately not the same thing as `sco_list_properties`, which reads the
 * compiled class dictionary. The dictionary knows a class's raw properties; this knows
 * the SCO data MODEL (which objects are part of it, their friendly names, which
 * attributes are required, how objects relate). Both are useful — for "what does the
 * Sales Order object look like?" this is the faithful answer.
 *
 * READ-ONLY on purpose: the create-object / add-attribute endpoints exist but are the
 * Data Model page's (and the data-model skill's) job to drive through the UI, so this
 * client does not expose them and cannot be used to change the model.
 *
 * Requests use HTTP Basic auth injected server-side (never reaches the browser or the
 * model). Nothing is mutated; every call builds a fresh request.
 */
export class ScModelRestClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(config: ScModelRestConfig) {
    const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
    this.base = `http://${config.host}:${config.port}${prefix}/api/${encodeURIComponent(
      config.namespace,
    )}/scmodel/v1`;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs;
    this.retries = config.retries;
  }

  /**
   * Every object in the SCO data model. The endpoint may answer with a bare array or
   * wrap it (`{ content: [...] }` / `{ objects: [...] }`) depending on the SCO build,
   * so unwrap defensively rather than assuming one shape.
   */
  async listObjects(): Promise<unknown[]> {
    const res = await this.request<unknown>('/objects', 'GET');
    return unwrapList(res);
  }

  /** One object's detail (attributes, data types, required flags, relationships), or
   *  null when SCO reports it absent — a missing object is a normal answer to give the
   *  user, not a transport failure. */
  async getObject(objectName: string): Promise<unknown | null> {
    try {
      return await this.request<unknown>(`/objects/${encodeURIComponent(objectName)}`, 'GET');
    } catch (err) {
      // A 404 is the answer "there is no such object", which the caller reports as
      // found:false. Anything else (auth, transport, a 500) is a real failure and must
      // NOT be flattened into "not found" — that would have the assistant tell the user
      // an object doesn't exist when the truth is we couldn't reach SCO.
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  private async request<T>(path: string, method: 'GET'): Promise<T> {
    const url = `${this.base}${path}`;
    // Reads only, so a transient 5xx is always safe to retry.
    const res = await irisFetch(
      url,
      {
        method,
        headers: { Authorization: this.authHeader, Accept: 'application/json', Connection: 'close' },
      },
      { timeoutMs: this.timeoutMs, attempts: this.retries, retryOn5xx: true, op: 'data-model request' },
    );
    if (!res.ok) {
      const body = await safeText(res);
      throw httpStatusToError(res.status, body, { op: 'data-model request', url: redact(url) });
    }
    if (res.status === 204) return [] as unknown as T;
    // Read the body UNBOUNDED here: `safeText` caps at 500 chars, which is right for an
    // error message but would truncate a real object list mid-JSON and fail the parse.
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new IrisProtocolError(`SCO data-model API response could not be read for ${method} ${redact(url)}.`);
    }
    if (!text.trim()) return [] as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IrisProtocolError(
        `SCO data-model API returned a non-JSON body for ${method} ${redact(url)}.`,
      );
    }
  }
}

/** Pull the array out of whichever envelope the endpoint used. */
function unwrapList(res: unknown): unknown[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object') {
    for (const key of ['content', 'objects', 'items', 'data']) {
      const v = (res as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}
