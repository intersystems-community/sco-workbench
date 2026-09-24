import { describe, it, expect } from 'vitest';
import { parseScoVersion, compareScoVersions, scoVersionAtLeast } from '../../src/util/sco-version.js';

/**
 * Version ordering for the setup preflight. The gate that blocks the Workbench is
 * only as good as this comparison, and the failure mode is silent: a wrong answer
 * either locks out a supported instance or waves through an unsupported one.
 *
 * The lexical trap is pinned explicitly — `"1.10.0" < "1.7.3"` as strings, which is
 * the bug a naive implementation ships with.
 */
describe('parseScoVersion', () => {
  it('parses a plain three-part version', () => {
    expect(parseScoVersion('1.7.3')).toEqual({ major: 1, minor: 7, patch: 3, raw: '1.7.3' });
  });

  it('treats a missing patch as 0', () => {
    expect(parseScoVersion('1.7')).toMatchObject({ major: 1, minor: 7, patch: 0 });
  });

  it('accepts what the wire actually delivers: whitespace, quotes, a leading v, a build suffix', () => {
    // text/plain bodies arrive with trailing newlines; some proxies JSON-encode a
    // bare string; IPM records the release with a build stamp appended.
    expect(parseScoVersion('  1.7.3\n')).toMatchObject({ major: 1, minor: 7, patch: 3 });
    expect(parseScoVersion('"1.7.3"')).toMatchObject({ major: 1, minor: 7, patch: 3 });
    expect(parseScoVersion('v1.7.3')).toMatchObject({ major: 1, minor: 7, patch: 3 });
    expect(parseScoVersion('1.7.3-202609231521')).toMatchObject({ major: 1, minor: 7, patch: 3 });
  });

  it('keeps the trimmed original for display', () => {
    expect(parseScoVersion(' 1.7.3-202609231521 ')?.raw).toBe('1.7.3-202609231521');
  });

  it('returns null for anything that is not a version', () => {
    for (const bad of ['', '   ', 'unknown', '<HTML>Not Found</HTML>', '1', 'v', null, undefined, 173, {}]) {
      expect(parseScoVersion(bad as unknown), `should not parse: ${String(bad)}`).toBeNull();
    }
  });
});

describe('compareScoVersions', () => {
  const v = (s: string) => parseScoVersion(s)!;

  it('orders by major, then minor, then patch', () => {
    expect(compareScoVersions(v('2.0.0'), v('1.9.9'))).toBeGreaterThan(0);
    expect(compareScoVersions(v('1.8.0'), v('1.7.9'))).toBeGreaterThan(0);
    expect(compareScoVersions(v('1.7.4'), v('1.7.3'))).toBeGreaterThan(0);
    expect(compareScoVersions(v('1.7.3'), v('1.7.3'))).toBe(0);
    expect(compareScoVersions(v('1.7.2'), v('1.7.3'))).toBeLessThan(0);
  });

  it('compares NUMERICALLY, not lexically (the 1.10 vs 1.7 trap)', () => {
    // As strings, '1.10.0' sorts BELOW '1.7.3'. Numerically it is newer.
    expect('1.10.0' < '1.7.3').toBe(true); // the trap, stated
    expect(compareScoVersions(v('1.10.0'), v('1.7.3'))).toBeGreaterThan(0);
    expect(compareScoVersions(v('1.7.10'), v('1.7.9'))).toBeGreaterThan(0);
  });
});

describe('scoVersionAtLeast (the 1.7.3 gate)', () => {
  const MIN = '1.7.3';

  it('accepts the minimum itself and anything newer', () => {
    for (const ok of ['1.7.3', '1.7.4', '1.8.0', '1.10.0', '2.0.0', '1.7.3-202609231521']) {
      expect(scoVersionAtLeast(ok, MIN), `${ok} should satisfy ${MIN}`).toBe(true);
    }
  });

  it('rejects anything older', () => {
    for (const bad of ['1.7.2', '1.7.0', '1.7', '1.6.9', '0.9.9', '1.0.0']) {
      expect(scoVersionAtLeast(bad, MIN), `${bad} should NOT satisfy ${MIN}`).toBe(false);
    }
  });

  it('rejects an unreadable version rather than assuming it is new enough', () => {
    // A version we cannot parse is not evidence of support — fail closed.
    for (const bad of ['', 'unknown', '<HTML>Not Found</HTML>', null, undefined]) {
      expect(scoVersionAtLeast(bad as unknown, MIN)).toBe(false);
    }
  });

  it('fails closed when the MINIMUM is itself unparseable (misconfiguration)', () => {
    expect(scoVersionAtLeast('9.9.9', 'not-a-version')).toBe(false);
  });
});
