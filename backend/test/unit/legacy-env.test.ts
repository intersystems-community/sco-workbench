import { describe, expect, it } from 'vitest';
import { RENAMED_ENV_VARS, legacyEnvHint } from '../../src/config/legacy-env.js';

describe('legacyEnvHint', () => {
  it('returns null for an environment with no legacy names', () => {
    expect(legacyEnvHint({ SCO_HOST: 'localhost', SCO_NAMESPACE: 'SC' })).toBeNull();
  });

  it('returns null for a completely empty environment', () => {
    expect(legacyEnvHint({})).toBeNull();
  });

  it('names the old and the new variable when only the legacy one is set', () => {
    const hint = legacyEnvHint({ IRIS_HOST: 'localhost' });
    expect(hint).toContain('IRIS_HOST');
    expect(hint).toContain('SCO_HOST');
  });

  it('reports every legacy variable that is set, one per line', () => {
    const hint = legacyEnvHint({ IRIS_HOST: 'localhost', IRIS_NAMESPACE: 'SC', IRIS_USER: 'su' });
    const lines = hint?.split('\n').filter((l) => l.includes('->')) ?? [];
    expect(lines).toHaveLength(3);
  });

  it('stays silent once the new name is also set — the migration is done', () => {
    expect(legacyEnvHint({ IRIS_HOST: 'localhost', SCO_HOST: 'localhost' })).toBeNull();
  });

  it('flags an overridden optional setting, whose new name has a default and so never fails validation', () => {
    // The dangerous silent case: SCO_UPLOAD_CSV_DIR defaults, so a stale
    // IRIS_UPLOAD_CSV_DIR would be ignored without a word.
    expect(legacyEnvHint({ IRIS_UPLOAD_CSV_DIR: '/mnt/csv' })).toContain('SCO_UPLOAD_CSV_DIR');
  });

  it('ignores an empty-string legacy value, which sets nothing', () => {
    expect(legacyEnvHint({ IRIS_HOST: '' })).toBeNull();
  });

  it('does not treat an API error code as an environment variable, in either spelling', () => {
    // The codes are SCO_* now (they were IRIS_* before the rename) and several are
    // shaped exactly like a legacy env name — SCO_HTTP next to SCO_HTTP_TIMEOUT_MS.
    // Neither spelling may resolve through the rename map, or a stray code in the
    // environment would be reported as a variable the user must rename.
    const codes = ['UNREACHABLE', 'TIMEOUT', 'AUTH', 'HTTP', 'PROTOCOL'];
    for (const suffix of codes) {
      expect(RENAMED_ENV_VARS[`SCO_${suffix}`]).toBeUndefined();
      expect(RENAMED_ENV_VARS[`IRIS_${suffix}`]).toBeUndefined();
    }
  });

  it('maps every legacy name to an SCO_-prefixed name', () => {
    for (const [old, renamed] of Object.entries(RENAMED_ENV_VARS)) {
      expect(old.startsWith('IRIS_')).toBe(true);
      expect(renamed).toBe(`SCO_${old.slice('IRIS_'.length)}`);
    }
  });
});
