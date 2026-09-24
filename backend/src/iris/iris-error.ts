/**
 * Typed error taxonomy for every failure that can occur talking to InterSystems
 * IRIS. Each concrete class fixes a machine-readable `code` and a default
 * `httpStatus`, so the Express error middleware never has to re-derive either —
 * it serializes `{ error: { code, message, details? } }` and responds with
 * `httpStatus`.
 *
 * The status values reproduce the codes the routes used to hand-pick
 * (400/403/404/422/500/502) and add 409 (conflict) and 504 (timeout). Messages
 * still carry the key facts (e.g. the upstream HTTP status) so existing
 * string-based assertions keep working.
 */

/** Base for all IRIS-related errors. Carries everything the envelope needs. */
export abstract class IrisError extends Error {
  /** Machine-readable code, e.g. `SCO_UNREACHABLE`. */
  abstract readonly code: string;
  /** Default HTTP status for this class of error. */
  abstract readonly httpStatus: number;
  /** Structured extra context (compiler console, candidates, raw SCO body). */
  readonly details?: unknown;

  constructor(message: string, options?: { details?: unknown; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.details = options?.details;
  }
}

/** IRIS could not be reached (connection refused, DNS failure, socket reset). */
export class IrisUnreachableError extends IrisError {
  readonly code = 'SCO_UNREACHABLE';
  readonly httpStatus = 502;
}

/** A request to IRIS exceeded its timeout (AbortController fired). */
export class IrisTimeoutError extends IrisError {
  readonly code = 'SCO_TIMEOUT';
  readonly httpStatus = 504;
}

/**
 * IRIS rejected the request's credentials (HTTP 401/403). This is a backend
 * misconfiguration, not the end user's fault, so it surfaces as 502 with a
 * distinct code (the end-user 403 is `ReadOnlyError`).
 */
export class IrisAuthError extends IrisError {
  readonly code = 'SCO_AUTH';
  readonly httpStatus = 502;
}

/** A non-2xx HTTP response from IRIS that isn't auth/not-found/conflict. */
export class IrisHttpError extends IrisError {
  readonly code = 'SCO_HTTP';
  readonly httpStatus = 502;
  /** The upstream HTTP status that was returned. */
  readonly upstreamStatus: number;

  constructor(
    upstreamStatus: number,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message, options);
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * IRIS returned something we couldn't interpret: malformed/non-JSON body, a
 * failed `%Status` decode, or an Atelier envelope with `status.errors[]`.
 */
export class IrisProtocolError extends IrisError {
  readonly code = 'SCO_PROTOCOL';
  readonly httpStatus = 502;
}

/** A class failed to compile in IRIS. `details` carries `{ errors, console, className }`. */
export class CompileError extends IrisError {
  readonly code = 'COMPILE_FAILED';
  readonly httpStatus = 422;
}

/**
 * A cube compiled but failed to build (populate) from its source rows. `details`
 * carries `{ cubeName, className, total, distinct, samples }` — the deduped
 * per-row errors IRIS recorded — so the UI can show the real messages instead of
 * the raw "run %PrintBuildErrors yourself" hint. 422 (the definition/data is at
 * fault, not the IRIS connection).
 */
export class BuildError extends IrisError {
  readonly code = 'BUILD_FAILED';
  readonly httpStatus = 422;
}

/** The request body / definition was invalid. `details` carries `{ problems }`. */
export class ValidationError extends IrisError {
  readonly code = 'VALIDATION';
  readonly httpStatus = 400;
}

/**
 * An MDX/query IRIS rejected (bad member, malformed axis). 422 — the request
 * shape was structurally valid but the query is semantically wrong, same class as
 * CompileError/BuildError. `details` carries the upstream MDX error + the composed
 * MDX. Also the normalized target for the SC-2643 500-<INVALID OREF> case (D3).
 */
export class QueryError extends IrisError {
  readonly code = 'QUERY_FAILED';
  readonly httpStatus = 422;
}

/** A cube / class / KPI was not found. `details` may carry `{ candidates }`. */
export class NotFoundError extends IrisError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
}

/** A create collided with something that already exists, or a broker had no active turn. */
export class ConflictError extends IrisError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;
}

/** The target is an SCO built-in and cannot be edited/deleted in the Workbench. */
export class ReadOnlyError extends IrisError {
  readonly code = 'READ_ONLY';
  readonly httpStatus = 403;
}

/** Type guard: is this value one of our typed IRIS errors? */
export function isIrisError(err: unknown): err is IrisError {
  return err instanceof IrisError;
}
