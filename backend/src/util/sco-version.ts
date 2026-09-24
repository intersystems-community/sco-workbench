/**
 * Parsing and ordering for SCO version strings.
 *
 * `GET /api/{ns}/scdata/v1/backend-version` answers `text/plain` — e.g. `1.7.3` —
 * and the Workbench needs to know whether that is at least some minimum. String
 * comparison cannot do it (`"1.10.0" < "1.7.3"` lexically, but 1.10.0 is NEWER),
 * so versions are compared component-wise as numbers.
 *
 * Kept pure and separate from the HTTP call so the ordering rules are unit-testable
 * without a live instance — the comparison is the part with the off-by-one risks.
 */

/** A parsed version. `pre` keeps any `-suffix` verbatim; it does NOT affect ordering. */
export interface ScoVersion {
  major: number;
  minor: number;
  patch: number;
  /** The original string, trimmed — for display in an error message. */
  raw: string;
}

/**
 * Parse a version string, or null when it is not one.
 *
 * Deliberately lenient about what surrounds the number, because this value comes
 * off the wire from a `text/plain` endpoint: surrounding whitespace, a wrapping
 * pair of quotes (some proxies JSON-encode a bare string), a leading `v`, and a
 * build/prerelease suffix (`1.7.3-202609231521`, the shape IPM records) are all
 * accepted. Strict about the part that decides ordering: major and minor must be
 * present and numeric, and a missing patch reads as 0 (`1.7` → 1.7.0).
 */
export function parseScoVersion(raw: unknown): ScoVersion | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!trimmed) return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(trimmed);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    raw: trimmed,
  };
}

/** Order two parsed versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareScoVersions(a: ScoVersion, b: ScoVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Does `raw` name a version at least `minimum`? Returns false when `raw` cannot be
 * parsed — an unreadable version is not evidence that the instance is new enough,
 * and the caller reports it as such rather than letting the user through.
 *
 * A build suffix is ignored: `1.7.3-202609231521` satisfies a `1.7.3` minimum,
 * since IPM appends the build stamp to the same release.
 */
export function scoVersionAtLeast(raw: unknown, minimum: string): boolean {
  const actual = parseScoVersion(raw);
  const min = parseScoVersion(minimum);
  if (!actual || !min) return false;
  return compareScoVersions(actual, min) >= 0;
}
