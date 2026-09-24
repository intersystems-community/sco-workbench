// frontend/src/app/cube/condition-mdx.ts  (byte-mirrored in backend/src/dashboard/condition-mdx.ts,
// pinned identical by condition-mdx.spec.ts cross-workspace, exactly like member-ref.ts)
import { memberRef, type MemberRefInput } from './member-ref';

/** The guided relations a condition row can express. Negation is EXCEPT, never %NOT (SCO rejects %NOT
 *  at query time, 422, verified 2026-09-04). Ranges / top-N / cross-dimension stay out of the guided
 *  ladder (design §8); cross-dimension is expressed by stacking rows. */
export type ConditionOperator =
  | 'is' | 'isOneOf' | 'isNot' | 'isNotOneOf' | 'isNull' | 'isNotNull';

/** The level's own spec (or the bare `[dim]` fallback) — the additivity-safe single-level set the
 *  query layer already uses (no [All] leak, no mixed hierarchy levels). */
function levelSpecOf(sel: MemberRefInput): string {
  return sel.levelSpec ?? `[${sel.dim}]`;
}

/** {refA,refB,…} over a member list — the OR/union set, space-free. Each ref goes through memberRef's
 *  ] → ]] escape (injection-closed). */
function memberSet(sels: MemberRefInput[]): string {
  return `{${sels.map((s) => memberRef(s, 'key')).join(',')}}`;
}

/** Compose the canonical MDX condition string for a member selection (or set) under a guided relation.
 *   is          → [lvl].&[key]
 *   isOneOf      → {[lvl].&[a],[lvl].&[b],…}                 (OR/union; a singleton is {[lvl].&[a]})
 *   isNot        → EXCEPT([lvl].MEMBERS,{[lvl].&[key]})
 *   isNotOneOf   → EXCEPT([lvl].MEMBERS,{[lvl].&[a],[lvl].&[b],…})
 *   isNull       → [lvl].&[<null>]
 *   isNotNull    → EXCEPT([lvl].MEMBERS,{[lvl].&[<null>]})
 *  Injection-closed: the level spec is validated upstream; the only interpolated literal is the fixed
 *  token <null>; every key path goes through memberRef. No user free-text reaches this function. */
export function composeCondition(
  sel: MemberRefInput | MemberRefInput[],
  operator: ConditionOperator,
): string {
  const sels = Array.isArray(sel) ? sel : [sel];
  const first = sels[0] ?? ({ dim: '', member: '' } as MemberRefInput);
  const lvl = levelSpecOf(first);
  switch (operator) {
    case 'isNull':
      return `${lvl}.&[<null>]`;
    case 'isNotNull':
      return `EXCEPT(${lvl}.MEMBERS,{${lvl}.&[<null>]})`;
    case 'isOneOf':
      return memberSet(sels);
    case 'isNot':
      return `EXCEPT(${lvl}.MEMBERS,${memberSet([first])})`;
    case 'isNotOneOf':
      return `EXCEPT(${lvl}.MEMBERS,${memberSet(sels)})`;
    case 'is':
    default:
      return memberRef(first, 'key');
  }
}

/** The structured view of a canonical condition string. `keys`: [] for the null variants; length 1 for
 *  is/isNot; length ≥1 for the set forms (isOneOf/isNotOneOf). */
export interface ParsedCondition { operator: ConditionOperator; levelSpec: string; keys: string[] }

/** A single level spec: [seg](.[seg])*, each seg bracketed. Level specs come from the cube shape
 *  (no injection, no ]] inside), so [^\]]+ per segment is safe. */
const LEVEL = String.raw`\[[^\]]+\](?:\.\[[^\]]+\])*`;
/** One member ref within a set: <lvl>.&[<escaped-key>]. The key body allows doubled ]] and stops at a
 *  lone ] (the terminator), so keys containing ] round-trip and comma-splitting is never needed. */
const MEMBER_RE = new RegExp(String.raw`(${LEVEL})\.&\[((?:[^\]]|\]\])*)\]`, 'g');

/** Reverse memberRef's ] → ]] escape. */
function unescapeBrackets(s: string): string { return s.replace(/]]/g, ']'); }

/** Pull the member keys out of a `{…}` set body (already stripped of braces), in order. Returns the
 *  common level spec (all set members share one level) and the unescaped keys, or null if empty/garbled. */
function parseSet(body: string): { levelSpec: string; keys: string[] } | null {
  MEMBER_RE.lastIndex = 0;
  const keys: string[] = [];
  let levelSpec: string | null = null;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = MEMBER_RE.exec(body)) !== null) {
    if (levelSpec === null) levelSpec = m[1];
    keys.push(unescapeBrackets(m[2]));
    consumed += m[0].length;
  }
  if (levelSpec === null || keys.length === 0) return null;
  // Reject trailing/leading garbage: the matched refs + (n-1) commas must be the whole body.
  if (consumed + (keys.length - 1) !== body.length) return null;
  return { levelSpec, keys };
}

/** Read a flat slot back into the structured row. Recognizes EXACTLY the six shapes composeCondition
 *  produces (most-specific-first), so compose→parse is lossless; every other string returns null and
 *  the row falls through to the free-text escape hatch. */
export function parseCondition(str: string): ParsedCondition | null {
  const s = str.trim();
  if (!s) return null;

  // 1 & 2: EXCEPT(<lvl>.MEMBERS,{<set>})  — negation family (tried before the bare ref forms).
  const except = new RegExp(String.raw`^EXCEPT\((${LEVEL})\.MEMBERS,(\{.*\})\)$`).exec(s);
  if (except) {
    const lvl = except[1];
    const setBody = except[2].slice(1, -1);          // strip { }
    // isNotNull: the set is exactly {<lvl>.&[<null>]}
    if (setBody === `${lvl}.&[<null>]`) return { operator: 'isNotNull', levelSpec: lvl, keys: [] };
    const set = parseSet(setBody);
    if (!set || set.levelSpec !== lvl) return null;
    return { operator: set.keys.length >= 2 ? 'isNotOneOf' : 'isNot', levelSpec: lvl, keys: set.keys };
  }

  // 3: isNull — <lvl>.&[<null>]
  const nullMatch = new RegExp(String.raw`^(${LEVEL})\.&\[<null>\]$`).exec(s);
  if (nullMatch) return { operator: 'isNull', levelSpec: nullMatch[1], keys: [] };

  // 4: isOneOf — {<set>}
  if (s.startsWith('{') && s.endsWith('}')) {
    const set = parseSet(s.slice(1, -1));
    if (!set) return null;
    return { operator: 'isOneOf', levelSpec: set.levelSpec, keys: set.keys };
  }

  // 5: is — <lvl>.&[<key>]  (key may contain escaped ]] ; capture up to the final ].)
  const isMatch = new RegExp(String.raw`^(${LEVEL})\.&\[((?:[^\]]|\]\])*)\]$`).exec(s);
  if (isMatch) return { operator: 'is', levelSpec: isMatch[1], keys: [unescapeBrackets(isMatch[2])] };

  return null;
}
