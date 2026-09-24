import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Env } from '../config/env.js';

/**
 * Verifies a credential presented on a request. Today a shared secret;
 * tomorrow an IRIS-delegated per-user check (swap the implementation, the
 * middleware and mount order below do not change).
 */
export interface CredentialVerifier {
  /** True iff the presented bearer token authenticates the request. */
  verify(presented: string): boolean;
}

/**
 * Constant-time shared-secret verifier. `timingSafeEqual` REQUIRES equal-length
 * buffers and throws `RangeError` otherwise, so length is guarded here: a
 * mismatch returns false (after a dummy compare so the early exit does not leak
 * length via timing) rather than letting the throw become a 500.
 */
export class SharedSecretVerifier implements CredentialVerifier {
  private readonly expected: Buffer;

  constructor(token: string) {
    this.expected = Buffer.from(token, 'utf8');
  }

  verify(presented: string): boolean {
    const got = Buffer.from(presented ?? '', 'utf8');
    if (got.length !== this.expected.length) {
      // Keep timing ~constant on the mismatch path, then fail closed.
      timingSafeEqual(this.expected, this.expected);
      return false;
    }
    return timingSafeEqual(got, this.expected);
  }
}

/**
 * Resolve the effective API token. If `WORKBENCH_API_TOKEN` is set (non-empty)
 * it is the secret; otherwise generate an ephemeral one so the default path
 * needs no configuration. The caller logs a generated token once at boot.
 */
export function resolveApiToken(env: Env): { token: string; generated: boolean } {
  if (env.WORKBENCH_API_TOKEN) {
    return { token: env.WORKBENCH_API_TOKEN, generated: false };
  }
  return { token: randomBytes(32).toString('hex'), generated: true };
}

/**
 * Deny-by-default gate: 401 unless the request carries a valid
 * `Authorization: Bearer <token>`. No missing-vs-wrong distinction (no auth
 * oracle) and no IRIS internals in the body.
 */
export function createAuthMiddleware(verifier: CredentialVerifier): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer (.+)$/i.exec(header);
    const presented = match?.[1];
    if (presented !== undefined && verifier.verify(presented)) {
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized' });
  };
}
