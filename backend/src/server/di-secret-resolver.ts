import type { IntegrationCaseRepository } from '../db/integration-cases.js';
import { decryptSecret, decryptBytes } from '../util/crypto-secret.js';

/**
 * Recovers a Data Integration source's secret when a SAVED case is reopened.
 *
 * A reopened case never carries its secrets in the browser: passwords are redacted
 * to the `__saved__` sentinel, and uploaded secret files (SFTP private key, cloud
 * credentials file) are left out of the request entirely. So a Test Connection /
 * introspection call on a reopened case would otherwise fail with a bad-credentials
 * error until the user needlessly re-entered what they already saved.
 *
 * These helpers close that gap on the SERVER only: given the case id, they read the
 * persisted (encrypted) secret from SQLite and decrypt it for that one request. The
 * plaintext is NEVER returned to the browser — it exists only inside the handler.
 * A freshly-entered value (non-sentinel password, non-empty file) always wins and
 * is passed straight through, so this only fills in what the user left as "saved".
 */

/** The redacted password placeholder the browser echoes back for a saved secret. */
const SENTINEL = '__saved__';

/** Password fields inside a case's `definition.source`, keyed by adapter. */
type PasswordKey = 'dbPassword' | 'ftpPassword';

/** Secret-file slots persisted per case (see SECRET_SLOTS in the case router). */
type SecretSlot = 'privateKey' | 'cloudCred';

/**
 * Resolve a source password. When `value` is the `__saved__` sentinel and a case id
 * is given, return the decrypted password stored on that case; otherwise return
 * `value` unchanged (a freshly-typed password, or no case to fall back to).
 */
export function resolvePassword(
  cases: IntegrationCaseRepository | undefined,
  caseId: string | undefined,
  sourceKey: PasswordKey,
  value: string,
): string {
  if (value !== SENTINEL || !cases || !caseId) return value;
  const found = cases.get(caseId);
  const source = found?.definition?.source as Record<string, unknown> | undefined;
  const stored = source?.[sourceKey];
  return typeof stored === 'string' && stored.length > 0 ? decryptSecret(stored) : value;
}

/**
 * Resolve secret-file CONTENTS. When `content` is blank and a case id is given,
 * read the persisted bytes for `slot`, decrypt them (they're stored encrypted), and
 * return the text; otherwise return `content` unchanged (freshly picked, or nothing
 * stored to fall back to).
 */
export function resolveSecretFile(
  cases: IntegrationCaseRepository | undefined,
  caseId: string | undefined,
  slot: SecretSlot,
  content: string,
): string {
  if (content.trim() || !cases || !caseId) return content;
  const stored = cases.getFileBytesBySlot(caseId, slot);
  if (!stored) return content;
  const raw = stored.encrypted ? decryptBytes(stored.bytes) : stored.bytes;
  return raw.toString('utf8');
}

/**
 * Return a copy of a posted cloud (S3) config with `credentialsFileContent` filled
 * in from the case's persisted credentials file when the request left it blank (a
 * reopened case). Both resolveS3Config callers — Test Connection and the bucket
 * browser — run their config through this first, so a reopened cloud source tests
 * and browses without re-picking the file. A non-blank content is left untouched.
 */
export function withRecoveredCloudCreds(
  cases: IntegrationCaseRepository | undefined,
  caseId: string | undefined,
  raw: unknown,
): unknown {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const content = typeof cfg.credentialsFileContent === 'string' ? cfg.credentialsFileContent : '';
  const recovered = resolveSecretFile(cases, caseId, 'cloudCred', content);
  return recovered === content ? raw : { ...cfg, credentialsFileContent: recovered };
}
