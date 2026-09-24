// frontend/src/app/dashboard/humanize.ts
//
// Presentational humanizers (Change 5). Pure and framework-free so they unit-test
// without a browser. Display-ONLY: the raw identifier is still the value sent to the
// backend, the sort key, and the copied text — only what the eye reads changes.

/**
 * Acronyms kept fully upper-case rather than Title-cased (spec M1 allow-list).
 * MUST stay in lockstep with the backend twin `humanize-label.ts::ACRONYMS`, so a
 * chart title reads the same as the dropdown. The shared fixture
 * `ci/humanize-lockstep.json` guards this: both specs assert this set equals the
 * fixture's, so adding an acronym to one side without the other fails a test.
 */
export const ACRONYMS = new Set(['UID', 'ID', 'URL', 'SCAC', 'SLA', 'BOM', 'KPI']);

/**
 * A raw field/column identifier → human Title Case. Splits camelCase and
 * `_`/`.`-delimited names into words; allow-listed acronyms stay upper-case; an
 * already-spaced label is returned unchanged (idempotent).
 */
export function humanizeField(name: string): string {
  if (!name) return name;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/[_.]+/g, ' ')                  // _ and . delimiters
    .trim()
    .split(/\s+/);
  return words
    .map((w) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/**
 * A raw cube name → human Title Case for the cube dropdown (Change 5/M1). Like
 * `humanizeField` it splits camelCase and applies the shared acronym allow-list, but
 * it also (a) splits an ACRONYM-run boundary (`WBDemo` → `WB Demo`) so a leading
 * initialism reads as its own word, and (b) drops a trailing "Cube" noise word —
 * every SCO cube is named `…Cube`, so the word adds nothing in a picker already
 * labelled "Cube". "Cube" is stripped only when it is a distinct trailing word AND
 * something else remains, so the degenerate name `Cube` is left intact (never
 * emptied). Kept separate from `humanizeField` (not folded into it) because
 * `humanizeField` is byte-locked to the backend twin via `ci/humanize-lockstep.json`;
 * the acronym-run split is a cube-picker nicety, not part of that contract.
 * Display-ONLY: the raw `cubeName` stays the option value / selection key.
 */
export function humanizeCubeName(name: string): string {
  if (!name) return name;
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronym-run boundary: WBDemo → WB Demo
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase boundary
    .replace(/[_.]+/g, ' ')                      // _ and . delimiters
    .trim()
    .split(/\s+/);
  if (words.length > 1 && words[words.length - 1] === 'Cube') words.pop();
  return words
    .map((w) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// Anchored full ISO-8601 date-time: date + 'T' + time, optional fractional seconds,
// optional Z or ±hh:mm offset. Date-only ('2026-08-20') and bare years do NOT match.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** True only for a strict full ISO-8601 timestamp that also round-trips through Date. */
export function isStrictIso(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // Round-trip guard: reject shape-valid but impossible dates (e.g. month 13), which
  // Date may normalise instead of rejecting. new Date(t).toISOString() must agree on
  // the instant the input names.
  return new Date(t).getTime() === t;
}

/**
 * A strict-ISO timestamp → a readable UTC form, e.g. `2026-08-20 19:57:18 UTC`.
 * Anything not strict-ISO is returned unchanged (callers gate on isStrictIso /
 * timestampColumns, so this is belt-and-suspenders).
 */
export function humanizeTimestamp(value: string): string {
  if (!isStrictIso(value)) return value;
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/**
 * The column-consistent timestamp decision (D2-SPEC-15). A column is a timestamp
 * column iff it has at least one PRESENT (non-null, non-empty) value and EVERY present
 * value in it is strict-ISO. One non-ISO present value leaves the whole column raw —
 * so a rendered column is never a mix of humanized and raw cells. Pure: derived once
 * per page from the client-held rows, no side effect and no source re-read.
 */
export function timestampColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): Set<string> {
  const result = new Set<string>();
  for (const col of columns) {
    let sawPresent = false;
    let allIso = true;
    for (const row of rows) {
      const v = row[col];
      if (!isPresent(v)) continue;
      sawPresent = true;
      if (!isStrictIso(v)) { allIso = false; break; }
    }
    if (sawPresent && allIso) result.add(col);
  }
  return result;
}
