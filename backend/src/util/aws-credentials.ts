import type { S3Config } from './remote-fs/s3-fs.js';

/**
 * AWS credential handling for the Data Integration cloud (S3) source.
 *
 * THE MISMATCH THIS SOLVES: the wizard collects an AWS credentials FILE, because
 * that is what the IRIS adapter needs (`EnsLib.AmazonS3.InboundAdapter`'s
 * `ProviderCredentialsFile` is a path on the IRIS host). But the Node side — the
 * Test Connection call and the bucket browser — talks to S3 through the AWS SDK,
 * which needs key VALUES. So the frontend sends the picked file's CONTENTS in the
 * request body (exactly as the SFTP source sends its private key), and this module
 * parses them into keys. Contents are used for that one request and never logged,
 * persisted, or echoed back.
 *
 * Two shapes are accepted, because both are things people actually have on disk:
 *
 *   1. The shared-credentials INI (`~/.aws/credentials`), with or without profiles:
 *        [default]
 *        aws_access_key_id = AKIA...
 *        aws_secret_access_key = ...
 *        aws_session_token = ...            ← optional (temporary credentials)
 *   2. Environment-style lines, with or without `export`:
 *        export AWS_ACCESS_KEY_ID=AKIA...
 *        AWS_SECRET_ACCESS_KEY="..."
 *
 * Anything else is reported as a friendly message the UI renders — never a throw.
 *
 * RICH TEXT IS THE COMMON MISTAKE. Pasting the portal's credentials block into
 * TextEdit and saving produces RTF, whose markup this parser would otherwise lift
 * straight into the key values: every line ends `\` in the RTF source, and smart-
 * quote substitution can plant a U+201D in a value. Both then reach the SDK, and
 * the user sees an opaque Node error (`Invalid character in header content
 * ["authorization"]`) rather than anything about their file. So RTF is detected up
 * front, and every resolved value is checked to be printable ASCII — see
 * isRichText / credentialValueProblem.
 */

/** The key material an S3 call authenticates with. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for temporary (STS) credentials. */
  sessionToken?: string;
}

/**
 * Why a resolution failed. `missing` = the request didn't carry the field at all
 * (a malformed request → 4xx); `invalid` = it was there but unusable (a normal
 * failed-test/failed-listing result → 200 with ok:false). Keeping these apart is
 * what lets the routes stay faithful to "only a malformed body is a 4xx".
 */
export type S3ConfigFailureKind = 'missing' | 'invalid';

export type S3ConfigResolution =
  | { ok: true; config: S3Config }
  | { ok: false; kind: S3ConfigFailureKind; message: string };

/** Strip surrounding quotes from an INI/env value. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** The INI/env key names we recognise, normalised to lower case. */
const KEY_ALIASES: Record<string, keyof AwsCredentials> = {
  aws_access_key_id: 'accessKeyId',
  access_key_id: 'accessKeyId',
  aws_secret_access_key: 'secretAccessKey',
  secret_access_key: 'secretAccessKey',
  aws_session_token: 'sessionToken',
  session_token: 'sessionToken',
  aws_security_token: 'sessionToken',
};

/** The INI spelling of each field, for error messages that point at a line. */
const FIELD_LABELS: Record<keyof AwsCredentials, string> = {
  accessKeyId: 'aws_access_key_id',
  secretAccessKey: 'aws_secret_access_key',
  sessionToken: 'aws_session_token',
};

/**
 * True for a rich-text (RTF) document rather than a text file. Word/TextEdit both
 * open with `{\rtf`; a leading BOM or blank lines are tolerated.
 */
function isRichText(text: string): boolean {
  return /^﻿?\s*\{\\rtf/.test(text);
}

/**
 * AWS key ids, secrets and session tokens are printable ASCII with no spaces —
 * base64-ish at worst. Anything else (a control character, a backslash from RTF
 * line breaks, a curly quote, a stray space) means the value was mangled on its
 * way here, so say so instead of letting the SDK fail cryptically. Returns the
 * offending field's INI name, or null when every value is clean.
 */
function credentialValueProblem(credentials: AwsCredentials): string | null {
  for (const field of Object.keys(FIELD_LABELS) as (keyof AwsCredentials)[]) {
    const value = credentials[field];
    if (!value) continue;
    if (/[^\x21-\x7e]|\\/.test(value)) return FIELD_LABELS[field];
  }
  return null;
}

/**
 * Parse an AWS credentials file into per-profile key sets. Lines before any
 * `[section]` header land in the '' (top-level) profile, which is what makes the
 * env-style shape work with the same parser. Full-line `#`/`;` comments are
 * skipped; inline comments are NOT stripped, since a secret is opaque text and
 * cutting at a `#` could silently truncate one.
 */
function parseProfiles(text: string): Map<string, Partial<AwsCredentials>> {
  const profiles = new Map<string, Partial<AwsCredentials>>();
  let current = '';
  profiles.set(current, {});

  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      // `[profile dev]` (the config-file spelling) names the profile `dev`.
      current = (section[1] ?? '').trim().replace(/^profile\s+/i, '');
      if (!profiles.has(current)) profiles.set(current, {});
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/i, '').toLowerCase();
    const field = KEY_ALIASES[name];
    if (!field) continue;
    const value = unquote(line.slice(eq + 1));
    if (value) profiles.get(current)![field] = value;
  }
  return profiles;
}

/**
 * Extract credentials from an AWS credentials file's contents. `profile` picks a
 * named section; without it the search order is the top-level keys (env-style
 * files), then `[default]`, then the first section that carries a complete pair —
 * so a single-profile file works no matter what that profile is called.
 */
export function parseAwsCredentialsFile(
  text: string,
  profile?: string,
): { ok: true; credentials: AwsCredentials } | { ok: false; message: string } {
  if (!text?.trim()) return { ok: false, message: 'the credentials file is empty.' };
  if (isRichText(text)) {
    return {
      ok: false,
      message:
        'the file is Rich Text (RTF), not plain text, so its markup would corrupt the keys. '
        + 'Re-save it as plain text (in TextEdit: Format > Make Plain Text), or convert it with '
        + '`textutil -convert txt creds.rtf`.',
    };
  }

  const profiles = parseProfiles(text);
  const wanted = profile?.trim();
  const complete = (p: Partial<AwsCredentials> | undefined): p is AwsCredentials =>
    !!p?.accessKeyId?.trim() && !!p?.secretAccessKey?.trim();

  /** Last gate before key material leaves this module. */
  const accept = (
    credentials: AwsCredentials,
  ): { ok: true; credentials: AwsCredentials } | { ok: false; message: string } => {
    const mangled = credentialValueProblem(credentials);
    if (mangled) {
      return {
        ok: false,
        message:
          `the ${mangled} value contains characters that cannot appear in an AWS credential `
          + '(a space, quote, or backslash — usually from a rich-text editor). '
          + 'Re-copy the keys into a plain text file.',
      };
    }
    return { ok: true, credentials };
  };

  if (wanted) {
    const found = profiles.get(wanted);
    if (!found) return { ok: false, message: `the credentials file has no profile "${wanted}".` };
    if (!complete(found)) {
      return { ok: false, message: `profile "${wanted}" is missing aws_access_key_id or aws_secret_access_key.` };
    }
    return accept(found);
  }

  const order = ['', 'default', ...[...profiles.keys()].filter((k) => k !== '' && k !== 'default')];
  for (const name of order) {
    const candidate = profiles.get(name);
    if (complete(candidate)) return accept(candidate);
  }
  return {
    ok: false,
    message:
      'the credentials file has no aws_access_key_id / aws_secret_access_key pair '
      + '(expected an [default] profile or AWS_ACCESS_KEY_ID lines).',
  };
}

/**
 * Rewrite an AWS credentials file so its usable credentials live under a
 * `[default]` profile — the ONLY profile the IRIS Cloud adapter can read.
 *
 * WHY: `EnsLib.AmazonS3.InboundAdapter.ProviderCredentialsFile` is just a path
 * handed to the AWS Java SDK (`%Net.Cloud.Storage.Client.CreateClient` →
 * `ClientFactory.createStorageClient`), which loads the SDK's `[default]` profile
 * with no way to select a named one. A file whose only section is e.g.
 * `[123_SomeRole]` (common for SSO/exported creds) makes the adapter fail at
 * startup with `No AWS profile named 'default'`. The Node-side Test Connection /
 * browse tolerate any profile (see parseAwsCredentialsFile's search order), so the
 * mismatch only surfaces at deploy — hence we normalize the bytes we STAGE into
 * IRIS, not what the user uploaded.
 *
 * Returns the normalized INI text, or an unchanged pass-through decision:
 *   - `{ changed: false }` when the content does not parse as AWS credentials
 *     or already exposes a complete `[default]` profile — leave those bytes
 *     verbatim. (Callers gate this to `aws-cred` uploads, so SSH keys never reach
 *     it; the parse check is a second safety net.)
 *   - `{ changed: true, text }` with a single canonical `[default]` section.
 *
 * The re-emitted file carries ONLY the resolved key/secret/token, so a
 * multi-profile file collapses to the one profile the search order picks — exactly
 * the credentials the Test Connection validated.
 */
export function normalizeAwsCredentialsToDefaultProfile(
  text: string,
): { changed: false } | { changed: true; text: string } {
  const parsed = parseAwsCredentialsFile(text);
  // Not AWS credentials (or unusable) → not ours to touch; stage verbatim.
  if (!parsed.ok) return { changed: false };

  // Already a usable [default] profile with no competing sections → leave as-is,
  // so a hand-crafted canonical file round-trips byte-for-byte.
  const profiles = parseProfiles(text);
  const onlyDefault =
    profiles.has('default')
    && [...profiles.keys()].every((k) => k === '' || k === 'default')
    && !!profiles.get('default')?.accessKeyId?.trim();
  if (onlyDefault) return { changed: false };

  const { accessKeyId, secretAccessKey, sessionToken } = parsed.credentials;
  const lines = [
    '[default]',
    `aws_access_key_id=${accessKeyId}`,
    `aws_secret_access_key=${secretAccessKey}`,
  ];
  if (sessionToken?.trim()) lines.push(`aws_session_token=${sessionToken}`);
  return { changed: true, text: lines.join('\n') + '\n' };
}

/** The cloud-source config shape the frontend posts (all fields optional here so
 *  this module owns the validation, and the routes stay thin). */
export interface S3ConfigRequest {
  bucket?: unknown;
  region?: unknown;
  /** Explicit key values (used as-is when present). */
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
  sessionToken?: unknown;
  /** The picked AWS credentials file's CONTENTS, parsed when no explicit keys. */
  credentialsFileContent?: unknown;
  /** Optional profile name inside that file (default: the search order above). */
  credentialsProfile?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Turn a posted cloud config into the S3Config the SDK layer needs, resolving
 * credentials from either explicit key values or the uploaded credentials file.
 * Shared by the Test Connection route and the bucket-browse routes so both apply
 * ONE validation contract — a connection that tests OK is exactly one that can
 * browse.
 */
export function resolveS3Config(raw: unknown): S3ConfigResolution {
  const cfg = (raw ?? {}) as S3ConfigRequest;
  const bucket = str(cfg.bucket).trim();
  const region = str(cfg.region).trim();
  if (!bucket || !region) {
    return { ok: false, kind: 'missing', message: 'config.bucket and config.region are required.' };
  }

  const accessKeyId = str(cfg.accessKeyId).trim();
  const secretAccessKey = str(cfg.secretAccessKey).trim();
  if (accessKeyId && secretAccessKey) {
    const sessionToken = str(cfg.sessionToken).trim() || undefined;
    // Explicit keys get the same character gate as parsed ones: a mangled value
    // must never reach the SDK, whichever door it came in through.
    const mangled = credentialValueProblem({ accessKeyId, secretAccessKey, sessionToken });
    if (mangled) {
      return { ok: false, kind: 'invalid', message: `The ${mangled} value contains characters that cannot appear in an AWS credential.` };
    }
    return { ok: true, config: { bucket, region, accessKeyId, secretAccessKey, sessionToken } };
  }

  const content = str(cfg.credentialsFileContent);
  if (!content.trim()) {
    return {
      ok: false,
      kind: 'missing',
      message:
        'config.credentialsFileContent (or config.accessKeyId + config.secretAccessKey) is required.',
    };
  }

  const parsed = parseAwsCredentialsFile(content, str(cfg.credentialsProfile));
  if (!parsed.ok) return { ok: false, kind: 'invalid', message: `Could not read the AWS credentials file: ${parsed.message}` };
  return {
    ok: true,
    config: {
      bucket,
      region,
      accessKeyId: parsed.credentials.accessKeyId,
      secretAccessKey: parsed.credentials.secretAccessKey,
      sessionToken: parsed.credentials.sessionToken,
    },
  };
}
