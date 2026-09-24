/**
 * Configuration + guard for the `live-source` tier.
 *
 * This tier is the only one that talks to REAL external data sources (an S3 bucket
 * and an EC2 box running sshd / vsftpd / PostgreSQL). Every other tier is either
 * mock-based (unit) or reaches nothing but IRIS (integration, e2e), so this is the
 * only tier that needs credentials — and therefore the only one a developer may
 * legitimately be unable to run.
 *
 * Env values are read from `process.env` first, so real CI variables always win.
 * Two files are then layered in for local runs (dotenv never overwrites a value
 * that is already set):
 *   1. `.env.live-source` — copy of `ci/live-source.env.example`, gitignored.
 *      Keeping these keys OUT of `.env` means a normal `npm run dev` cannot
 *      accidentally pick up test-source credentials.
 *   2. `.env` — the ordinary developer file, as a fallback for shared keys.
 *
 * `src/config/env.ts` is deliberately NOT imported here: it is a zod schema for the
 * SERVER's configuration and would reject a process that has no Bedrock settings,
 * which has nothing to do with reading a bucket name.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { describe } from 'vitest';

// Look in the repo root and one level up, matching src/config/env.ts — vitest runs
// with cwd = backend/, but a root-level `npm run ...` runs with cwd = repo root.
const firstExisting = (name: string): string | undefined =>
  [resolve(process.cwd(), name), resolve(process.cwd(), '..', name)].find((p) => existsSync(p));

for (const file of ['.env.live-source', '.env']) {
  const path = firstExisting(file);
  if (path) loadDotenv({ quiet: true, path });
}

/** GitLab sets CI=true in every job. Used only to choose throw-vs-skip below. */
export const isCI = ['1', 'true'].includes((process.env.CI ?? '').toLowerCase());

/**
 * Run key for artifact isolation. Concurrent MR pipelines share one bucket and one
 * PostgreSQL database, so every name this tier creates — S3 prefix, uploaded
 * filename, table, SCO target object — is keyed on this. In CI that is the pipeline
 * id; locally it is a per-process value, so a developer run cannot collide with a
 * pipeline or with their own previous run.
 */
export const RUN_KEY = process.env.CI_PIPELINE_ID || `local${process.pid}`;

/** S3 object prefix owned by this run. Everything under it is deleted at teardown. */
export const s3Prefix = (): string => `ci/${RUN_KEY}/`;

// ---------------------------------------------------------------------------
// Per-source configuration
// ---------------------------------------------------------------------------
// LIVE_SOURCE_HOST is the shared default for the EC2 box so it is filled in once.
// Each service can still override it, for the case where SFTP/FTP/PostgreSQL end up
// on different machines.

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

const sharedHost = (): string | undefined => env('LIVE_SOURCE_HOST');

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Present when CI obtained the credentials from `aws sts assume-role`. */
  sessionToken?: string;
}

export interface SftpConfig {
  host: string;
  port: number;
  user: string;
  /** Path to the private key file. In CI this is a File-type CI variable. */
  privateKeyPath: string;
  dir: string;
}

export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  dir: string;
  /** Declared passive range. Asserted so a security-group mismatch is named. */
  pasvMin: number;
  pasvMax: number;
}

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * A resolver returns the config, or the list of variables that are missing. It never
 * throws — `describeIfConfigured` decides what a missing variable means.
 */
export type Resolved<T> = { ok: true; config: T } | { ok: false; missing: string[] };

// K is the literal union of the variable names, so `v.SOME_KEY` inside `build` is a
// plain `string` -- a Record over an index SIGNATURE would widen it back to
// `string | undefined` under noUncheckedIndexedAccess.
const need = <K extends string, T>(
  values: Record<K, string | undefined>,
  build: (v: Record<K, string>) => T,
): Resolved<T> => {
  const missing = Object.entries(values)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: build(values as Record<K, string>) };
};

export const resolveS3 = (): Resolved<S3Config> =>
  need(
    {
      LIVE_SOURCE_S3_BUCKET: env('LIVE_SOURCE_S3_BUCKET'),
      LIVE_SOURCE_S3_REGION: env('LIVE_SOURCE_S3_REGION'),
      AWS_ACCESS_KEY_ID: env('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: env('AWS_SECRET_ACCESS_KEY'),
    },
    (v) => ({
      bucket: v.LIVE_SOURCE_S3_BUCKET,
      region: v.LIVE_SOURCE_S3_REGION,
      accessKeyId: v.AWS_ACCESS_KEY_ID,
      secretAccessKey: v.AWS_SECRET_ACCESS_KEY,
      // Optional on purpose: a long-lived local key has no session token, an STS
      // triple always does. aws-credentials.ts already carries it either way.
      sessionToken: env('AWS_SESSION_TOKEN'),
    }),
  );

export const resolveSftp = (): Resolved<SftpConfig> =>
  need(
    {
      LIVE_SOURCE_SFTP_HOST: env('LIVE_SOURCE_SFTP_HOST') ?? sharedHost(),
      LIVE_SOURCE_SFTP_USER: env('LIVE_SOURCE_SFTP_USER'),
      LIVE_SOURCE_SFTP_KEY_PATH: env('LIVE_SOURCE_SFTP_KEY_PATH'),
      LIVE_SOURCE_SFTP_DIR: env('LIVE_SOURCE_SFTP_DIR'),
    },
    (v) => ({
      host: v.LIVE_SOURCE_SFTP_HOST,
      port: Number(env('LIVE_SOURCE_SFTP_PORT') ?? 22),
      user: v.LIVE_SOURCE_SFTP_USER,
      privateKeyPath: v.LIVE_SOURCE_SFTP_KEY_PATH,
      dir: v.LIVE_SOURCE_SFTP_DIR,
    }),
  );

export const resolveFtp = (): Resolved<FtpConfig> =>
  need(
    {
      LIVE_SOURCE_FTP_HOST: env('LIVE_SOURCE_FTP_HOST') ?? sharedHost(),
      LIVE_SOURCE_FTP_USER: env('LIVE_SOURCE_FTP_USER'),
      LIVE_SOURCE_FTP_PASSWORD: env('LIVE_SOURCE_FTP_PASSWORD'),
      LIVE_SOURCE_FTP_DIR: env('LIVE_SOURCE_FTP_DIR'),
      LIVE_SOURCE_FTP_PASV_MIN: env('LIVE_SOURCE_FTP_PASV_MIN'),
      LIVE_SOURCE_FTP_PASV_MAX: env('LIVE_SOURCE_FTP_PASV_MAX'),
    },
    (v) => ({
      host: v.LIVE_SOURCE_FTP_HOST,
      port: Number(env('LIVE_SOURCE_FTP_PORT') ?? 21),
      user: v.LIVE_SOURCE_FTP_USER,
      password: v.LIVE_SOURCE_FTP_PASSWORD,
      dir: v.LIVE_SOURCE_FTP_DIR,
      pasvMin: Number(v.LIVE_SOURCE_FTP_PASV_MIN),
      pasvMax: Number(v.LIVE_SOURCE_FTP_PASV_MAX),
    }),
  );

export const resolvePg = (): Resolved<PgConfig> =>
  need(
    {
      LIVE_SOURCE_PG_HOST: env('LIVE_SOURCE_PG_HOST') ?? sharedHost(),
      LIVE_SOURCE_PG_DATABASE: env('LIVE_SOURCE_PG_DATABASE'),
      LIVE_SOURCE_PG_USER: env('LIVE_SOURCE_PG_USER'),
      LIVE_SOURCE_PG_PASSWORD: env('LIVE_SOURCE_PG_PASSWORD'),
    },
    (v) => ({
      host: v.LIVE_SOURCE_PG_HOST,
      port: Number(env('LIVE_SOURCE_PG_PORT') ?? 5432),
      database: v.LIVE_SOURCE_PG_DATABASE,
      user: v.LIVE_SOURCE_PG_USER,
      password: v.LIVE_SOURCE_PG_PASSWORD,
    }),
  );

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Declare a suite that needs a real external source.
 *
 * - **In CI, a missing variable THROWS at collection time.** It must not skip: the
 *   `test:live:ci` guard (ci/assert-test-files.mjs) requires
 *   `numPassedTests === numTotalTests`, and a source test that quietly skips because
 *   somebody forgot a CI variable is precisely the false green this tier exists to
 *   prevent. Failing at collection also names the variable, instead of surfacing
 *   later as a connection error.
 * - **Locally, a missing variable skips**, so a developer with no credentials can
 *   still run `npm run test:live` and see which suites they are not covering.
 *
 * The callback receives the resolved config, so no test re-reads process.env.
 */
export function describeIfConfigured<T>(
  name: string,
  resolve: () => Resolved<T>,
  body: (config: T) => void,
): void {
  const result = resolve();
  if (result.ok) {
    describe(name, () => body(result.config));
    return;
  }
  const list = result.missing.join(', ');
  if (isCI) {
    throw new Error(
      `live-source suite "${name}" cannot run: missing ${list}. ` +
        `In CI these come from GitLab CI/CD variables — see ci/live-source.env.example ` +
        `for the full list and which ones must be Masked or File type. This throws ` +
        `rather than skipping because a skipped real-source test is a false green.`,
    );
  }
  describe.skip(`${name} [skipped: set ${list} in .env.live-source]`, () => body(undefined as T));
}
