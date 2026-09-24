import { describe, it, expect } from 'vitest';
import {
  resolvePassword,
  resolveSecretFile,
  withRecoveredCloudCreds,
} from '../../src/server/di-secret-resolver.js';
import { IntegrationCaseRepository } from '../../src/db/integration-cases.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { encryptSecret, encryptBytes } from '../../src/util/crypto-secret.js';

/**
 * The secret-recovery layer for REOPENED Data Integration cases (Bug: "Database
 * Iris Credentials Are Not Persisted Correctly"). WHY it matters: a reopened case
 * carries its password only as the `__saved__` sentinel and its secret files not at
 * all, so Test Connection / introspection would authenticate with the sentinel and
 * fail — until the user needlessly re-typed what they already saved. These helpers
 * swap the sentinel/blank for the persisted secret, server-side only.
 *
 * The tests below deliberately assert the FALL-THROUGH cases too (fresh value wins,
 * no case id, nothing stored): those are what keep a brand-new source, or a user
 * who DID retype the secret, from being silently overridden by stale storage.
 */

const SENTINEL = '__saved__';

function repoWithCase(source: Record<string, unknown>): { repo: IntegrationCaseRepository; id: string } {
  const repo = new IntegrationCaseRepository(openDatabase(':memory:'));
  const id = 'case1';
  repo.upsert(id, 'My source', 'draft', { source });
  return { repo, id };
}

describe('resolvePassword', () => {
  it('swaps the sentinel for the decrypted stored password', () => {
    const { repo, id } = repoWithCase({ dbPassword: encryptSecret('real-pw') });
    expect(resolvePassword(repo, id, 'dbPassword', SENTINEL)).toBe('real-pw');
  });

  it('passes a freshly-typed password straight through (never overridden by storage)', () => {
    const { repo, id } = repoWithCase({ dbPassword: encryptSecret('old-pw') });
    // The user retyped it this session — the request carries the real value, not the
    // sentinel — so the stored one must NOT win.
    expect(resolvePassword(repo, id, 'dbPassword', 'typed-now')).toBe('typed-now');
  });

  it('leaves the sentinel unchanged when there is no case id or repo', () => {
    const { repo } = repoWithCase({ dbPassword: encryptSecret('real-pw') });
    expect(resolvePassword(repo, undefined, 'dbPassword', SENTINEL)).toBe(SENTINEL);
    expect(resolvePassword(undefined, 'case1', 'dbPassword', SENTINEL)).toBe(SENTINEL);
  });

  it('leaves the sentinel unchanged when the case stored no such password', () => {
    const { repo, id } = repoWithCase({ dbUsername: 'u' }); // no dbPassword saved
    expect(resolvePassword(repo, id, 'dbPassword', SENTINEL)).toBe(SENTINEL);
  });
});

describe('resolveSecretFile', () => {
  function repoWithFile(slot: string, contents: string, encrypted: boolean): { repo: IntegrationCaseRepository; id: string } {
    const repo = new IntegrationCaseRepository(openDatabase(':memory:'));
    const id = 'case1';
    repo.upsert(id, 'My source', 'draft', { source: {} });
    const bytes = encrypted ? encryptBytes(Buffer.from(contents, 'utf8')) : Buffer.from(contents, 'utf8');
    repo.putFile(id, {
      fileId: 'f1', slot, kind: 'ssh-key', originalName: 'id_rsa', irisPath: '/x', secret: true, encrypted,
    }, bytes);
    return { repo, id };
  }

  it('recovers the decrypted key contents when the request sent none', () => {
    const { repo, id } = repoWithFile('privateKey', '-----BEGIN KEY-----', true);
    expect(resolveSecretFile(repo, id, 'privateKey', '')).toBe('-----BEGIN KEY-----');
  });

  it('passes freshly-uploaded contents straight through', () => {
    const { repo, id } = repoWithFile('privateKey', 'STORED', true);
    expect(resolveSecretFile(repo, id, 'privateKey', 'FRESH')).toBe('FRESH');
  });

  it('returns blank when nothing is stored for the slot', () => {
    const { repo, id } = repoWithFile('privateKey', 'STORED', true);
    expect(resolveSecretFile(repo, id, 'cloudCred', '')).toBe('');
  });
});

describe('withRecoveredCloudCreds', () => {
  it('fills in blank credentialsFileContent from the stored cloud file', () => {
    const repo = new IntegrationCaseRepository(openDatabase(':memory:'));
    repo.upsert('case1', 'S3', 'draft', { source: {} });
    repo.putFile('case1', {
      fileId: 'f1', slot: 'cloudCred', kind: 'aws-cred', originalName: 'creds', irisPath: '/x', secret: true, encrypted: true,
    }, encryptBytes(Buffer.from('[default]\naws_access_key_id=AK\n', 'utf8')));

    const out = withRecoveredCloudCreds(repo, 'case1', { bucket: 'b', region: 'us-east-1', credentialsFileContent: '' }) as any;
    expect(out.credentialsFileContent).toContain('aws_access_key_id=AK');
    expect(out.bucket).toBe('b');
  });

  it('returns the original config untouched when contents were provided', () => {
    const repo = new IntegrationCaseRepository(openDatabase(':memory:'));
    repo.upsert('case1', 'S3', 'draft', { source: {} });
    const raw = { bucket: 'b', region: 'us-east-1', credentialsFileContent: 'PROVIDED' };
    expect(withRecoveredCloudCreds(repo, 'case1', raw)).toBe(raw);
  });
});
