/**
 * Map any raw failure — a thrown fetch `TypeError`, an `AbortError`, a plain
 * `Error` from a client, or an already-typed `IrisError` — into the typed
 * taxonomy in `iris-error.ts`. The Express error middleware and the tool layer
 * both funnel through `toIrisError` so a single place decides the code/status.
 */
import {
  IrisError,
  IrisUnreachableError,
  IrisTimeoutError,
  IrisAuthError,
  IrisHttpError,
  IrisProtocolError,
  NotFoundError,
  ConflictError,
} from './iris-error.js';

/** Node/undici socket error codes that mean "IRIS was not reachable". */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Extract a nested `cause.code` string from a thrown error, if present. */
function causeCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'DOMException')
  );
}

/**
 * Normalize `err` into an `IrisError`. Already-typed errors pass through
 * unchanged. Abort/timeout → `IrisTimeoutError`; transient socket codes →
 * `IrisUnreachableError`; everything else → `IrisProtocolError` (best-effort,
 * carrying the original message).
 */
export function toIrisError(err: unknown, ctx?: { op?: string }): IrisError {
  if (err instanceof IrisError) return err;

  if (isAbort(err)) {
    return new IrisTimeoutError(withOp('SCO request timed out', ctx), { cause: err });
  }

  const code = causeCode(err);
  if (code && UNREACHABLE_CODES.has(code)) {
    return new IrisUnreachableError(
      withOp(`SCO is unreachable (${code})`, ctx),
      { cause: err },
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return new IrisProtocolError(withOp(message, ctx), { cause: err });
}

/**
 * Map a non-2xx HTTP status from an IRIS REST call to a typed error. Used inside
 * the REST clients so they throw a typed error instead of a plain `Error`.
 * `bodyText` (already truncated) becomes the error message and `details`.
 */
export function httpStatusToError(
  status: number,
  bodyText: string,
  ctx?: { op?: string; url?: string },
): IrisError {
  const suffix = bodyText ? ` — ${bodyText}` : '';
  const where = ctx?.op ? `${ctx.op}: ` : '';
  const msg = `${where}SCO returned HTTP ${status}${suffix}`;
  const details = { upstreamStatus: status, body: bodyText, url: ctx?.url };

  if (status === 401 || status === 403) return new IrisAuthError(msg, { details });
  if (status === 404) return new NotFoundError(msg, { details });
  if (status === 409) return new ConflictError(msg, { details });
  return new IrisHttpError(status, msg, { details });
}

function withOp(message: string, ctx?: { op?: string }): string {
  return ctx?.op ? `${ctx.op}: ${message}` : message;
}
