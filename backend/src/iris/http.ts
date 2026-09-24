/**
 * Shared low-level HTTP for the IRIS REST clients (Atelier, KPI, DeepSee).
 *
 * Consolidates the retry/backoff logic that was duplicated across clients and
 * adds two things every client was missing: a per-request timeout (via an
 * AbortController) and an opt-in retry on transient HTTP 5xx. Transport-level
 * failures are translated into the typed taxonomy so callers get an
 * `IrisTimeoutError` / `IrisUnreachableError` instead of a raw fetch `TypeError`.
 *
 * `irisFetch` returns the raw `Response` on any completed HTTP exchange
 * (including non-2xx) — mapping a non-2xx status to a typed error is the
 * caller's job (see `httpStatusToError`), because only the caller knows whether,
 * e.g., a 404 is an error or an expected "absent".
 *
 * Every request also replays the stored IRIS CSP session cookie (see
 * `cookie-jar.ts`), which keeps Atelier calls on one session instead of opening —
 * and holding a license connection for — a new one each time.
 */
import { IrisTimeoutError, IrisUnreachableError } from './iris-error.js';
import { rememberSetCookies, withStoredCookies } from './cookie-jar.js';

export interface IrisFetchOptions {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Retry idempotent requests on HTTP 5xx (default false — caller opts in). */
  retryOn5xx?: boolean;
  /** Label for error messages, e.g. "compile". */
  op?: string;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fetch with a timeout, transient-network retry, and optional 5xx retry. Throws
 * `IrisTimeoutError` when a request times out on every attempt, and
 * `IrisUnreachableError` when the socket fails on every attempt. Returns the
 * `Response` for any completed exchange (the caller inspects `res.ok`).
 */
export async function irisFetch(
  url: string,
  init: RequestInit,
  options: IrisFetchOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const opCtx = options.op ? { op: options.op } : undefined;

  let lastError: unknown;
  let timedOut = false;

  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, { ...withStoredCookies(init, url), signal: controller.signal });
      // Capture before the 5xx retry below: IRIS re-issues its session cookie on
      // every response, so a retry must send the newest value.
      rememberSetCookies(res, url);
      // Retry a transient 5xx only when the caller marked the request idempotent.
      if (options.retryOn5xx && res.status >= 500 && res.status <= 599 && i < attempts - 1) {
        await backoff(i);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      // A timeout on this attempt: the AbortController fired our timer.
      if (timedOut) {
        // Reset so a later attempt that succeeds isn't mislabeled.
        timedOut = false;
        if (i < attempts - 1) {
          await backoff(i);
          continue;
        }
        throw new IrisTimeoutError(
          withOp(`request timed out after ${timeoutMs}ms`, opCtx),
          { cause: err },
        );
      }
      // A transient socket error: back off and retry.
      if (i < attempts - 1) {
        await backoff(i);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new IrisUnreachableError(
    withOp(
      `request failed after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      opCtx,
    ),
    { cause: lastError },
  );
}

/** Linear backoff, matching the previous clients (150ms * attempt index+1). */
function backoff(attemptIndex: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 150 * (attemptIndex + 1)));
}

function withOp(message: string, ctx?: { op?: string }): string {
  return ctx?.op ? `${ctx.op}: ${message}` : message;
}

/** Strip query strings from a URL for error messages (avoids leaking params). */
export function redact(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Read a response body without throwing (for error messages). Caps at 500 chars. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
