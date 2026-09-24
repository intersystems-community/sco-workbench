import { describe, it, expect } from 'vitest';
import { parseAwsCredentialsFile, resolveS3Config, normalizeAwsCredentialsToDefaultProfile } from '../../src/util/aws-credentials.js';

/**
 * The credentials file is USER-SUPPLIED text, so the interesting cases are the
 * malformed and adversarial ones: secrets that contain the delimiter characters,
 * profiles that exist but are incomplete, and files that carry no keys at all. A
 * parser that truncates a secret is worse than one that rejects the file — the
 * request would fail with an opaque SignatureDoesNotMatch instead of a message the
 * user can act on.
 */
describe('parseAwsCredentialsFile', () => {
  it('reads the [default] profile of a shared-credentials file', () => {
    const res = parseAwsCredentialsFile([
      '[default]',
      'aws_access_key_id = AKIAEXAMPLE',
      'aws_secret_access_key = wJalrXUtnFEMI',
      'aws_session_token = FQoGZXIvYXdz',
    ].join('\n'));
    expect(res).toEqual({
      ok: true,
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI', sessionToken: 'FQoGZXIvYXdz' },
    });
  });

  it('tolerates CRLF, full-line comments, blank lines and quoted values', () => {
    const res = parseAwsCredentialsFile(
      '; a comment\r\n\r\n[default]\r\n# another\r\naws_access_key_id="AKIAQUOTED"\r\naws_secret_access_key = \'quoted-secret\'\r\n',
    );
    expect(res).toEqual({ ok: true, credentials: { accessKeyId: 'AKIAQUOTED', secretAccessKey: 'quoted-secret' } });
  });

  it('keeps a secret that contains = and # intact (no truncation at a delimiter)', () => {
    // Base64 secrets end in '=' padding, and '#' must not be read as a comment:
    // silently cutting either yields an unexplainable auth failure later.
    const secret = 'aB3/x+9#notacomment==';
    const res = parseAwsCredentialsFile(`[default]\naws_access_key_id=AK\naws_secret_access_key=${secret}\n`);
    expect(res.ok && res.credentials.secretAccessKey).toBe(secret);
  });

  it('accepts environment-style lines with and without `export`', () => {
    const res = parseAwsCredentialsFile('export AWS_ACCESS_KEY_ID=AKIAENV\nAWS_SECRET_ACCESS_KEY="envsecret"\n');
    expect(res).toEqual({ ok: true, credentials: { accessKeyId: 'AKIAENV', secretAccessKey: 'envsecret' } });
  });

  it('names a `[profile dev]` section `dev`, as the AWS config file spells it', () => {
    const text = '[profile dev]\naws_access_key_id=AKDEV\naws_secret_access_key=devsecret\n';
    expect(parseAwsCredentialsFile(text, 'dev')).toEqual({
      ok: true,
      credentials: { accessKeyId: 'AKDEV', secretAccessKey: 'devsecret' },
    });
  });

  it('uses the single named profile when there is no [default]', () => {
    const res = parseAwsCredentialsFile('[staging]\naws_access_key_id=AKSTG\naws_secret_access_key=stg\n');
    expect(res.ok && res.credentials.accessKeyId).toBe('AKSTG');
  });

  it('skips an INCOMPLETE [default] and falls through to a complete profile', () => {
    const res = parseAwsCredentialsFile(
      '[default]\naws_access_key_id=AKONLY\n\n[other]\naws_access_key_id=AKOTHER\naws_secret_access_key=othersecret\n',
    );
    expect(res.ok && res.credentials).toEqual({ accessKeyId: 'AKOTHER', secretAccessKey: 'othersecret' });
  });

  it('fails when the REQUESTED profile is absent, naming it', () => {
    const res = parseAwsCredentialsFile('[default]\naws_access_key_id=AK\naws_secret_access_key=s\n', 'prod');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('"prod"');
  });

  it('fails when the requested profile exists but has only half a key pair', () => {
    const res = parseAwsCredentialsFile('[prod]\naws_access_key_id=AK\n', 'prod');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('aws_secret_access_key');
  });

  it('fails on an empty file and on text with no recognised keys', () => {
    expect(parseAwsCredentialsFile('   \n\n')).toEqual({ ok: false, message: expect.stringContaining('empty') });
    const junk = parseAwsCredentialsFile('this is not a credentials file\njust prose\n');
    expect(junk.ok).toBe(false);
    expect(!junk.ok && junk.message).toContain('aws_access_key_id');
  });

  it('ignores unrecognised settings (region, output) instead of choking', () => {
    const res = parseAwsCredentialsFile('[default]\nregion=us-west-2\noutput=json\naws_access_key_id=AK\naws_secret_access_key=s\n');
    expect(res.ok).toBe(true);
  });

  it('accepts aws_security_token as a session-token alias', () => {
    const res = parseAwsCredentialsFile('[default]\naws_access_key_id=AK\naws_secret_access_key=s\naws_security_token=tok\n');
    expect(res.ok && res.credentials.sessionToken).toBe('tok');
  });

  /**
   * The rich-text trap, observed for real: pasting the portal's credentials block
   * into TextEdit and saving yields RTF. Its markup parses as plausible key/value
   * lines — every value ends with the RTF line-break backslash — so without these
   * guards the mangled keys reach the SDK and Node rejects the signed request with
   * `Invalid character in header content ["authorization"]`, which says nothing
   * about the file. These cases must fail EARLY and name the file.
   */
  describe('rich text and mangled values', () => {
    // Byte-for-byte the shape `textutil -convert rtf` produces on macOS.
    const rtf = [
      '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870',
      '\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}',
      '{\\colortbl;\\red255\\green255\\blue255;}',
      '\\pard\\pardirnatural\\partightenfactor0',
      '',
      '\\f0\\fs24 \\cf0 [590184001786_AWS-CloudTeam-SupplyChain-Write]\\',
      'aws_access_key_id=ASIAY34FZKBOKMUTVOPQ\\',
      'aws_secret_access_key=abc123/def456+ghi789\\',
      'aws_session_token=IQoJb3JpZ2luX2Vj\\',
      '}',
    ].join('\n');

    it('rejects an RTF file instead of lifting markup into the keys', () => {
      const res = parseAwsCredentialsFile(rtf);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toContain('Rich Text');
      expect(!res.ok && res.message).toContain('plain text');
    });

    it('rejects RTF even with a BOM or leading blank lines before the header', () => {
      const res = parseAwsCredentialsFile(`﻿\n\n${rtf}`);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toContain('Rich Text');
    });

    it('rejects a smart quote in a value (TextEdit substitutes them silently)', () => {
      // U+201D is above U+00FF, which is exactly what makes Node refuse to send
      // the Authorization header — catch it here, where we can explain it.
      const res = parseAwsCredentialsFile('[default]\naws_access_key_id=”AKIAEXAMPLE”\naws_secret_access_key=secret\n');
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toContain('aws_access_key_id');
      expect(!res.ok && res.message).toContain('plain text file');
    });

    it('names the SECRET when only the secret is mangled', () => {
      const res = parseAwsCredentialsFile('[default]\naws_access_key_id=AKIAEXAMPLE\naws_secret_access_key=abc\\def\n');
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toContain('aws_secret_access_key');
    });

    it('names the SESSION TOKEN when only the token is mangled', () => {
      const res = parseAwsCredentialsFile('[default]\naws_access_key_id=AKIAEXAMPLE\naws_secret_access_key=secret\naws_session_token=tok en\n');
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toContain('aws_session_token');
    });

    it('still accepts the full legitimate character set (base64 padding, + / =, tildes)', () => {
      const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCY==~';
      const res = parseAwsCredentialsFile(`[default]\naws_access_key_id=ASIAY34FZKBOKMUTVOPQ\naws_secret_access_key=${secret}\n`);
      expect(res.ok && res.credentials.secretAccessKey).toBe(secret);
    });
  });
});

describe('resolveS3Config', () => {
  const file = '[default]\naws_access_key_id=AKFILE\naws_secret_access_key=filesecret\n';

  it('reports MISSING (a 4xx for the routes) when bucket or region is absent', () => {
    for (const cfg of [undefined, {}, { bucket: 'b' }, { region: 'r' }, { bucket: '  ', region: 'r' }]) {
      const res = resolveS3Config(cfg);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.kind).toBe('missing');
    }
  });

  it('reports MISSING when neither explicit keys nor a credentials file are supplied', () => {
    const res = resolveS3Config({ bucket: 'b', region: 'us-east-1' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.kind).toBe('missing');
    expect(!res.ok && res.message).toContain('credentialsFileContent');
  });

  it('prefers explicit key values over the credentials file when both are sent', () => {
    const res = resolveS3Config({
      bucket: 'b', region: 'us-east-1',
      accessKeyId: 'AKEXPLICIT', secretAccessKey: 'explicitsecret', sessionToken: 'tok',
      credentialsFileContent: file,
    });
    expect(res).toEqual({
      ok: true,
      config: { bucket: 'b', region: 'us-east-1', accessKeyId: 'AKEXPLICIT', secretAccessKey: 'explicitsecret', sessionToken: 'tok' },
    });
  });

  it('falls back to the credentials file when a key value is blank or half-supplied', () => {
    const res = resolveS3Config({
      bucket: ' b ', region: ' us-east-1 ', accessKeyId: 'AKPARTIAL', secretAccessKey: '   ',
      credentialsFileContent: file,
    });
    expect(res.ok && res.config).toEqual({
      bucket: 'b', region: 'us-east-1', accessKeyId: 'AKFILE', secretAccessKey: 'filesecret', sessionToken: undefined,
    });
  });

  it('reports INVALID (a rendered failure, not a 4xx) for an unreadable credentials file', () => {
    const res = resolveS3Config({ bucket: 'b', region: 'r', credentialsFileContent: 'garbage' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.kind).toBe('invalid');
    expect(!res.ok && res.message).toContain('AWS credentials file');
  });

  it('reports INVALID when the named profile is missing from a valid file', () => {
    const res = resolveS3Config({ bucket: 'b', region: 'r', credentialsFileContent: file, credentialsProfile: 'nope' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.kind).toBe('invalid');
  });

  it('reports INVALID for an RTF credentials file, so the UI renders the reason', () => {
    const res = resolveS3Config({ bucket: 'b', region: 'r', credentialsFileContent: '{\\rtf1\\ansi\naws_access_key_id=AK\\\naws_secret_access_key=s\\\n}' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.kind).toBe('invalid');
    expect(!res.ok && res.message).toContain('Rich Text');
  });

  it('gates EXPLICIT keys on the same character rule as parsed ones', () => {
    const res = resolveS3Config({ bucket: 'b', region: 'r', accessKeyId: 'AKIA\\', secretAccessKey: 'secret' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.kind).toBe('invalid');
    expect(!res.ok && res.message).toContain('aws_access_key_id');
  });

  it('gates an explicit SESSION TOKEN too (it becomes a request header)', () => {
    const res = resolveS3Config({ bucket: 'b', region: 'r', accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'tok”en' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('aws_session_token');
  });

  it('ignores non-string fields rather than trusting the body shape', () => {
    const res = resolveS3Config({ bucket: 42, region: ['us-east-1'], credentialsFileContent: file });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.kind).toBe('missing');
  });
});

/**
 * IRIS's S3 adapter hands ProviderCredentialsFile to the AWS Java SDK, which reads
 * only the [default] profile — so the file STAGED into IRIS must expose one. The
 * normalizer rewrites a named/single profile to [default], collapses a multi-profile
 * file to the resolved credentials, and refuses to touch anything that isn't AWS
 * credentials (an SSH key shares the upload path).
 */
describe('normalizeAwsCredentialsToDefaultProfile', () => {
  it('rewrites a single named profile header to [default]', () => {
    const res = normalizeAwsCredentialsToDefaultProfile(
      '[590184001786_AWS-CloudTeam-Write]\naws_access_key_id=AKIAX\naws_secret_access_key=SEC\naws_session_token=TOK\n',
    );
    expect(res.changed).toBe(true);
    expect(res.changed && res.text).toBe('[default]\naws_access_key_id=AKIAX\naws_secret_access_key=SEC\naws_session_token=TOK\n');
  });

  it('leaves a canonical [default]-only file unchanged (byte-for-byte pass-through)', () => {
    const original = '[default]\naws_access_key_id=AKIAX\naws_secret_access_key=SEC\n';
    expect(normalizeAwsCredentialsToDefaultProfile(original)).toEqual({ changed: false });
  });

  it('collapses a multi-profile file to the [default] section it already has', () => {
    // default is present, so it is resolved and re-emitted alone under [default].
    const res = normalizeAwsCredentialsToDefaultProfile(
      '[default]\naws_access_key_id=AKIADEF\naws_secret_access_key=DEFSEC\n\n[other]\naws_access_key_id=AKIAOTH\naws_secret_access_key=OTHSEC\n',
    );
    // A [default] alongside another section is normalized (competing sections dropped).
    expect(res.changed).toBe(true);
    expect(res.changed && res.text).toBe('[default]\naws_access_key_id=AKIADEF\naws_secret_access_key=DEFSEC\n');
  });

  it('converts an env-style (no profile header) file to a [default] profile', () => {
    const res = normalizeAwsCredentialsToDefaultProfile('export AWS_ACCESS_KEY_ID=AKIAX\nAWS_SECRET_ACCESS_KEY=SEC\n');
    expect(res.changed).toBe(true);
    expect(res.changed && res.text).toBe('[default]\naws_access_key_id=AKIAX\naws_secret_access_key=SEC\n');
  });

  it('does not touch content that is not AWS credentials (e.g. an SSH private key)', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n';
    expect(normalizeAwsCredentialsToDefaultProfile(key)).toEqual({ changed: false });
  });

  it('does not touch an incomplete credentials file (no usable pair)', () => {
    expect(normalizeAwsCredentialsToDefaultProfile('[prof]\naws_access_key_id=AKIAX\n')).toEqual({ changed: false });
  });
});
