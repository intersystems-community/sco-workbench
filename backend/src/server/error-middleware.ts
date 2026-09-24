import type { ErrorRequestHandler, RequestHandler } from 'express';
import { isIrisError } from '../iris/iris-error.js';

/**
 * Single Express error handler for the backend-owned routes. Routes forward a
 * typed `IrisError` via `next(toIrisError(err))`; this serializes it into a
 * consistent JSON envelope and picks the HTTP status from the error class.
 *
 * Envelope (flat, backward-compatible with the Angular error readers):
 *
 *   { error: "<human message>", code: "<MACHINE_CODE>", ...details }
 *
 * `error` is the human-readable message (kept specific — e.g. the exact
 * compile/validation text the routes already crafted). `code` is the new
 * machine-readable discriminator (SCO_UNREACHABLE, COMPILE_FAILED, …). When the
 * error carries a plain-object `details` (e.g. `{ problems }`, `{ candidates }`,
 * `{ className, console, details }`), those keys are merged at the top level so
 * existing clients that read `body.candidates` / `body.problems` / `body.details`
 * keep working unchanged.
 *
 * A NON-IrisError reaching here is an unexpected bug (routes wrap IRIS failures
 * before calling next), so it becomes a generic 500 `INTERNAL` — with the raw
 * message only outside production.
 *
 * NOTE: this does NOT touch the reverse-proxy responses. Proxied SCO calls never
 * throw into Express; the proxy synthesizes its own matching envelope on connect
 * failure (see iris-proxy.ts).
 */
export function errorEnvelope(isProduction: boolean): ErrorRequestHandler {
  return (err, _req, res, next) => {
    // If the response already started streaming, defer to Express' default.
    if (res.headersSent) return next(err);

    if (isIrisError(err)) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.details && typeof err.details === 'object' && !Array.isArray(err.details)) {
        Object.assign(body, err.details as Record<string, unknown>);
      }
      res.status(err.httpStatus).json(body);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: isProduction ? 'Internal server error.' : message,
      code: 'INTERNAL',
    });
  };
}

/**
 * Fallback 404 for unmatched API routes, mounted just before the error handler
 * so an unknown `/api/*` path returns the same envelope shape instead of the SPA
 * index. Non-API paths fall through to the static/SPA handler.
 */
export function apiNotFound(): RequestHandler {
  return (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
      return;
    }
    next();
  };
}
