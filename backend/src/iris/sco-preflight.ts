/**
 * Setup preflight: can this Workbench actually talk to SCO?
 *
 * One probe answers all three prerequisites at once, because SCO's
 * `GET /api/{ns}/scdata/v1/backend-version` needs a reachable instance, valid
 * credentials (it requires `SC_Data_API:READ`), and returns the version as
 * `text/plain`. Measured against a live 1.7.3 instance:
 *
 *   | condition                          | observed              |
 *   |------------------------------------|-----------------------|
 *   | healthy                            | 200 + `1.7.3`         |
 *   | wrong/absent credentials           | 401                   |
 *   | wrong namespace, or API not installed | 404                |
 *   | nothing listening                  | socket error (no HTTP) |
 *
 * The point of this module is the CLASSIFICATION: each outcome becomes a distinct
 * `reason` the UI can turn into specific troubleshooting steps. A single
 * "couldn't connect" would leave the user guessing between a stopped container, a
 * typo'd password, and an unsupported build — three completely different fixes.
 *
 * Fails CLOSED: anything it cannot positively confirm is a block, never a pass.
 */
import { irisFetch } from './http.js';
import { IrisTimeoutError, IrisUnreachableError } from './iris-error.js';
import { parseScoVersion, scoVersionAtLeast } from '../util/sco-version.js';

/** Why the preflight blocked. One per distinct user remedy. */
export type PreflightReason =
  /** Nothing answered on the host/port — instance down, or wrong host/port. */
  | 'unreachable'
  /** It answered, but too slowly. Usually a starting or overloaded instance. */
  | 'timeout'
  /** 401 — the configured user/password is wrong, or lacks SC_Data_API:READ. */
  | 'unauthenticated'
  /** 404 — the namespace is wrong, or the SCO data API is not installed there. */
  | 'api-not-found'
  /** Reached and authenticated, but the build is older than the minimum. */
  | 'version-too-old'
  /** 200, but the body was not a version we could parse. */
  | 'version-unreadable'
  /** Any other HTTP status. `detail` carries it. */
  | 'http-error';

export interface PreflightResult {
  /** True only when all three prerequisites hold. The UI gates on exactly this. */
  ok: boolean;
  reason?: PreflightReason;
  /** The version SCO reported, when it reported a readable one. */
  version?: string;
  /** The minimum this Workbench requires, echoed so the UI needn't know it. */
  minimumVersion: string;
  /** Where we probed, for the troubleshooting text (never includes credentials). */
  endpoint: string;
  /** The configured namespace, so "check the namespace" can name it. */
  namespace: string;
  /** The configured user, so "check the credentials" can name it. No password. */
  user: string;
  /** Short technical detail (status line, socket error). Safe to show. */
  detail?: string;
}

/**
 * The minimum SCO version this Workbench build supports.
 *
 * A BUILD CONSTANT, not configuration. It states which SCO API surface this code was
 * written against, so it belongs to the code, not to a deployment: letting an
 * operator lower it would not make the missing endpoints appear, it would only move
 * the failure from one clear message at startup to a scatter of broken pages. Raise
 * it in the same commit that starts depending on a newer SCO API.
 */
export const MIN_SCO_VERSION = '1.7.3';

/**
 * Per-attempt timeout for the probe. Deliberately short, and deliberately NOT
 * SCO_HTTP_TIMEOUT_MS (30s): this one runs while the user waits at a blank screen
 * during setup, so it must reach a diagnosis in seconds. Long enough that a healthy
 * instance on a slow network still answers.
 */
export const PREFLIGHT_TIMEOUT_MS = 5_000;

export interface PreflightConfig {
  host: string;
  port: number;
  namespace: string;
  user: string;
  password: string;
  prefix?: string;
  /** Override the build's minimum. For tests; production uses MIN_SCO_VERSION. */
  minimumVersion?: string;
  /** Override the probe timeout. For tests; production uses PREFLIGHT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Run the probe and classify the outcome.
 *
 * Single attempt, no retry: this is a diagnosis, not a work request. Retrying a
 * refused socket three times only triples how long the user waits for the same
 * answer, and the UI offers an explicit "Retry" once it has reported.
 */
export async function checkScoPreflight(config: PreflightConfig): Promise<PreflightResult> {
  const prefix = config.prefix ? `/${config.prefix.replace(/^\/+|\/+$/g, '')}` : '';
  const endpoint =
    `http://${config.host}:${config.port}${prefix}` +
    `/api/${encodeURIComponent(config.namespace)}/scdata/v1/backend-version`;
  const minimumVersion = config.minimumVersion ?? MIN_SCO_VERSION;

  const base = {
    minimumVersion,
    endpoint,
    namespace: config.namespace,
    user: config.user,
  };

  let res: Response;
  try {
    res = await irisFetch(
      endpoint,
      {
        method: 'GET',
        headers: {
          Accept: 'text/plain',
          Authorization:
            'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64'),
        },
      },
      { attempts: 1, timeoutMs: config.timeoutMs ?? PREFLIGHT_TIMEOUT_MS, op: 'preflight' },
    );
  } catch (err: unknown) {
    // irisFetch maps transport failures into the typed taxonomy for us.
    if (err instanceof IrisTimeoutError) {
      return { ...base, ok: false, reason: 'timeout', detail: err.message };
    }
    if (err instanceof IrisUnreachableError) {
      return { ...base, ok: false, reason: 'unreachable', detail: err.message };
    }
    return {
      ...base,
      ok: false,
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ...base, ok: false, reason: 'unauthenticated', detail: `HTTP ${res.status}` };
  }
  if (res.status === 404) {
    return { ...base, ok: false, reason: 'api-not-found', detail: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ...base, ok: false, reason: 'http-error', detail: `HTTP ${res.status}` };
  }

  // 200: the instance is up and the credentials work. Only the version is left.
  const body = await safeBody(res);
  const parsed = parseScoVersion(body);
  if (!parsed) {
    return {
      ...base,
      ok: false,
      reason: 'version-unreadable',
      // Bounded: a misrouted 200 can be a whole HTML page, and this string is
      // rendered in the UI.
      detail: body ? `Reported: ${body.slice(0, 80)}` : 'Empty response body.',
    };
  }
  if (!scoVersionAtLeast(parsed.raw, minimumVersion)) {
    return { ...base, ok: false, reason: 'version-too-old', version: parsed.raw };
  }
  return { ...base, ok: true, version: parsed.raw };
}

/** Read the body without letting a stream failure mask the status we already have. */
async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
