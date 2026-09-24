/**
 * Migration guard for the `IRIS_*` → `SCO_*` environment-variable rename.
 *
 * Every setting that names the connected instance now carries the product's own
 * prefix. An un-migrated `.env` or CI variable set would otherwise fail in two
 * unhelpful ways:
 *
 *  - for a REQUIRED setting (`SCO_HOST`, `SCO_NAMESPACE`, `SCO_USER`,
 *    `SCO_PASSWORD`) the zod error reads `SCO_HOST: Required`, which says nothing
 *    about the `IRIS_HOST` sitting right there in the file;
 *  - for a setting with a DEFAULT (the upload dirs, the timeouts) validation
 *    succeeds and the stale override is silently ignored — the worse case, since
 *    nothing at all is reported.
 *
 * So `loadEnv` checks this before it reports anything else.
 */

/** Legacy name → its current name. Keys are env vars ONLY. */
export const RENAMED_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  IRIS_HOST: 'SCO_HOST',
  IRIS_WEB_PORT: 'SCO_WEB_PORT',
  IRIS_SUPERSERVER_PORT: 'SCO_SUPERSERVER_PORT',
  IRIS_NAMESPACE: 'SCO_NAMESPACE',
  IRIS_USER: 'SCO_USER',
  IRIS_PASSWORD: 'SCO_PASSWORD',
  IRIS_WEB_PREFIX: 'SCO_WEB_PREFIX',
  IRIS_UPLOAD_CSV_DIR: 'SCO_UPLOAD_CSV_DIR',
  IRIS_UPLOAD_KEY_DIR: 'SCO_UPLOAD_KEY_DIR',
  IRIS_HTTP_TIMEOUT_MS: 'SCO_HTTP_TIMEOUT_MS',
  IRIS_HTTP_RETRIES: 'SCO_HTTP_RETRIES',
  IRIS_PROXY_TIMEOUT_MS: 'SCO_PROXY_TIMEOUT_MS',
});

/**
 * Describe the legacy variables still set in `source`, or `null` when there is
 * nothing to migrate.
 *
 * A legacy name whose current counterpart is ALSO set is not reported: the
 * migration is done and the leftover is inert (the schema reads the new name),
 * so warning would only produce noise on a host where something else owns
 * `IRIS_HOST`.
 */
export function legacyEnvHint(source: Readonly<Record<string, string | undefined>>): string | null {
  const stale = Object.entries(RENAMED_ENV_VARS).filter(
    ([legacy, renamed]) => Boolean(source[legacy]) && !source[renamed],
  );
  if (stale.length === 0) return null;

  const pairs = stale.map(([legacy, renamed]) => `  - ${legacy} -> ${renamed}`).join('\n');
  return (
    'Environment variables have been renamed from the IRIS_ prefix to SCO_.\n' +
    'These legacy names are still set and are no longer read — rename them in your\n' +
    '.env (and in your CI/CD variables):\n' +
    pairs
  );
}
