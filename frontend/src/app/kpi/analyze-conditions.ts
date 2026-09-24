import { parseCondition, type ParsedCondition } from '../cube/condition-mdx';
import { parseComparison } from './comparison-mdx';

export type DiagnosticKind = 'contradiction' | 'redundancy' | 'noop' | 'orNudge' | 'unknownMember' | 'unaggregatedFilter';
export interface Diagnostic {
  kind: DiagnosticKind;
  rows: number[];        // offending row index(es) in the analyzed list — drives the inline ⚠ anchor
  message: string;       // user-facing, action-oriented
}

/** A guided row paired with its original list index (free-text/empty rows are dropped before analysis). */
interface Row { i: number; c: ParsedCondition }

/** The positive member set a row admits on its level, or null if the row is not a positive membership
 *  (isNot/isNotOneOf/isNull/isNotNull are negative/null and have no finite positive set here). */
function positiveKeys(c: ParsedCondition): Set<string> | null {
  return c.operator === 'is' || c.operator === 'isOneOf' ? new Set(c.keys) : null;
}

const sortedKeys = (c: ParsedCondition) => [...c.keys].sort().join(' ');
const disjoint = (a: Set<string>, b: Set<string>) => ![...a].some((k) => b.has(k));

/** Which family a parsed condition belongs to for merge purposes: 'pos' (is/isOneOf), 'neg'
 *  (isNot/isNotOneOf), or null (null variants — never mergeable here). */
function mergeFamily(c: ParsedCondition): 'pos' | 'neg' | null {
  if (c.operator === 'is' || c.operator === 'isOneOf') return 'pos';
  if (c.operator === 'isNot' || c.operator === 'isNotOneOf') return 'neg';
  return null;
}

/** Same-level mergeable? Both the positive family (is/isOneOf → isOneOf) OR both the negative family
 *  (isNot/isNotOneOf → isNotOneOf), on the same level, each with ≥1 real key. NOT is×isNot, null
 *  variants, different levels, or free-text (design §7.3; §9 defers the others). Pure — reused by the
 *  drop handler AND the analyzer-warning button. */
export function conditionsMergeable(
  a: ParsedCondition | null,
  b: ParsedCondition | null,
): { op: 'isOneOf' | 'isNotOneOf' } | null {
  if (!a || !b) return null;
  if (a.levelSpec !== b.levelSpec) return null;
  const fa = mergeFamily(a), fb = mergeFamily(b);
  if (fa === null || fa !== fb) return null;
  const real = (c: ParsedCondition) => c.keys.filter((k) => k !== '').length >= 1;
  if (!real(a) || !real(b)) return null;
  return { op: fa === 'pos' ? 'isOneOf' : 'isNotOneOf' };
}

/**
 * Analyze ONE list's guided rows (design §7). `levelMembers` supplies the full member universe per
 * levelSpec (from the cached cube-members fetch) for the no-op checks; a level absent from the map
 * skips its no-op check. Rows that parsed as free-text (null) or carry no level are ignored — the
 * analyzer is guided-rows-only, and silent on cross-dimension pairs (compares within one levelSpec).
 */
export function analyzeConditions(
  rows: (ParsedCondition | null)[],
  levelMembers: ReadonlyMap<string, readonly string[]>,
): Diagnostic[] {
  const guided: Row[] = rows
    .map((c, i) => ({ i, c }))
    .filter((r): r is Row => r.c !== null && !!r.c.levelSpec);

  const out: Diagnostic[] = [];
  const contradictoryPairs = new Set<string>();   // "i:j" pairs already flagged as contradictions

  // Group by level so every comparison is same-dimension+level (silent on cross-dim by construction).
  const byLevel = new Map<string, Row[]>();
  for (const r of guided) {
    const g = byLevel.get(r.c.levelSpec) ?? [];
    g.push(r);
    byLevel.set(r.c.levelSpec, g);
  }

  for (const [levelSpec, group] of byLevel) {
    const universe = levelMembers.get(levelSpec);

    // Single-row no-op checks.
    for (const { i, c } of group) {
      if (c.operator === 'isOneOf' && universe && universe.length > 0 && c.keys.length === universe.length
          && universe.every((m) => c.keys.includes(m))) {
        out.push({ kind: 'noop', rows: [i], message: `This matches every value of this field — it has no filtering effect.` });
      }
      if (c.operator === 'isNotNull' && universe && !universe.includes('<null>')) {
        out.push({ kind: 'noop', rows: [i], message: `This field has no empty values, so "is not null" changes nothing.` });
      }
      // Item 1 (design §7): a positive-membership row naming a key that is not among the level's known
      // members. SCO accepts the ref and silently returns empty, so warn (never block). Skipped when the
      // universe is not yet fetched (same guard as the no-op checks) — absence is not evidence of a bad key.
      // Negation is excluded: excluding a nonexistent value is a harmless no-op, not the silent-zero trap.
      if ((c.operator === 'is' || c.operator === 'isOneOf') && universe && universe.length > 0) {
        const unknown = c.keys.filter((k) => k !== '' && k !== '<null>' && !universe.includes(k));
        if (unknown.length) {
          out.push({ kind: 'unknownMember', rows: [i],
            message: unknown.length > 1
              ? `"${unknown.join('", "')}" are not current values of this field, so this may match no rows until they exist.`
              : `"${unknown[0]}" is not a current value of this field, so this may match no rows until it exists.` });
        }
      }
    }

    // Pairwise, same level.
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const A = group[x], B = group[y];
        const pairKey = `${A.i}:${B.i}`;

        // Redundancy: identical (operator, member set).
        if (A.c.operator === B.c.operator && sortedKeys(A.c) === sortedKeys(B.c)) {
          out.push({ kind: 'redundancy', rows: [A.i, B.i], message: `This repeats an earlier condition — it has no effect.` });
          continue;
        }

        // Contradiction: isNull × isNotNull.
        if ((A.c.operator === 'isNull' && B.c.operator === 'isNotNull')
            || (A.c.operator === 'isNotNull' && B.c.operator === 'isNull')) {
          out.push(contradiction(A.i, B.i));
          contradictoryPairs.add(pairKey);
          continue;
        }

        const pa = positiveKeys(A.c), pb = positiveKeys(B.c);

        // Contradiction: two positive sets, disjoint → can't both hold.
        if (pa && pb) {
          if (disjoint(pa, pb)) {
            out.push(contradiction(A.i, B.i));
            contradictoryPairs.add(pairKey);
          } else {
            // Overlap but two AND rows on one level → the OR-vs-AND teaching nudge.
            out.push({ kind: 'orNudge', rows: [A.i, B.i],
              message: `Two conditions on this field must BOTH be true. Did you mean "is one of" to match either?` });
          }
          continue;
        }

        // Contradiction: a positive set fully excluded by a negation on the same level.
        const posRow = pa ? A : pb ? B : null;
        const negRow = A.c.operator === 'isNot' || A.c.operator === 'isNotOneOf' ? A
                     : B.c.operator === 'isNot' || B.c.operator === 'isNotOneOf' ? B : null;
        if (posRow && negRow) {
          const pos = positiveKeys(posRow.c)!;
          const banned = new Set(negRow.c.keys);
          if ([...pos].every((k) => banned.has(k))) {
            out.push(contradiction(posRow.i, negRow.i));
            contradictoryPairs.add(`${Math.min(posRow.i, negRow.i)}:${Math.max(posRow.i, negRow.i)}`);
          }
        }
      }
    }
  }

  // Drop any orNudge whose pair is already a (sharper) contradiction.
  return out.filter((d) =>
    d.kind !== 'orNudge' || !contradictoryPairs.has(`${d.rows[0]}:${d.rows[1]}`));
}

function contradiction(i: number, j: number): Diagnostic {
  return { kind: 'contradiction', rows: [i, j],
    message: `These conditions can't both be true — this KPI will always count 0. Use "is one of" to match either value.` };
}

/** Case-insensitive, whitespace-tolerant `FILTER(` call opener. Global — every occurrence is scanned. */
const FILTER_CALL = /FILTER\s*\(/gi;

/** True if `s` contains at least one `FILTER(` that is NOT the direct argument of `AGGREGATE(`. Scans
 *  per occurrence (a global substring test cannot tell a wrapped FILTER from an unwrapped one, and
 *  `!s.includes('AGGREGATE')` is fooled by `AGGREGATE(x) + FILTER(y)`). The `\b` left boundary is
 *  load-bearing: without it a bogus `XAGGREGATE(FILTER(...))` would suppress the warning (spec §4.1 C13). */
function hasUnaggregatedFilter(s: string): boolean {
  FILTER_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILTER_CALL.exec(s)) !== null) {
    const before = s.slice(0, m.index);
    if (!/\bAGGREGATE\s*\(\s*$/i.test(before)) return true;   // this occurrence is unwrapped → warn
  }
  return false;
}

/**
 * Lint the RAW condition strings for the one silent-wrong construct the guided analyzer cannot see: a
 * free-text `FILTER(...)` that is not wrapped in `AGGREGATE(...)`. A bare FILTER in a KPI condition is
 * emitted as a `WHERE (<string>)` slicer, coerced to a tuple, and collapses to a single member — a
 * silently wrong dashboard number (spike finding P1/P2). WARN only; never blocks. Emits the SAME
 * Diagnostic shape as analyzeConditions, indexed into the SAME list, so both merge for rendering.
 * Fires only on genuine free-text rows (non-empty AND parseCondition === null), so its row indices are
 * disjoint from analyzeConditions' guided rows (spec §3.1).
 */
export function lintFreeTextConditions(raw: (string | null)[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  raw.forEach((s, i) => {
    const t = (s ?? '').trim();
    if (t === '' || parseCondition(t) !== null || parseComparison(t) !== null) return;   // empty, guided six-op, or guided comparison → not our concern
    if (hasUnaggregatedFilter(t)) {
      out.push({
        kind: 'unaggregatedFilter',
        rows: [i],
        message: `This comparison reads only one value, not the total of the matching rows. Use the guided aggregate comparison, or "is one of" to list specific values.`,
      });
    }
  });
  return out;
}
