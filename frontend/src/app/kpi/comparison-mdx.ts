// frontend/src/app/kpi/comparison-mdx.ts
// FE-only value object for the guided aggregate-comparison affordance (SC-2701 Option 2). NOT mirrored
// to the backend and deliberately independent of condition-mdx.ts: a comparison does not fit the closed
// six-op ParsedCondition model (no measure / operator / scalar slot), and keeping it separate leaves the
// mirrored composeCondition + the member-set analyzer untouched (design §3). Every emitted string is one
// of the four forms VERIFIED CORRECT on the unfixed engine (design §2; sc-kpi-condition-ladder-mdx-verified):
//   >   AGGREGATE(FILTER(L.MEMBERS,M>V))
//   >=  AGGREGATE(FILTER(L.MEMBERS,M>=V))
//   <   AGGREGATE(EXCEPT(L.MEMBERS,FILTER(L.MEMBERS,M>=V)))   (complement of the >= set)
//   <=  AGGREGATE(EXCEPT(L.MEMBERS,FILTER(L.MEMBERS,M>V)))    (complement of the > set)
// NEVER a bare FILTER; NEVER AGGREGATE(FILTER) for </<= (that silently reads the baseline).

export type ComparisonOp = '>' | '>=' | '<' | '<=';

export interface ParsedComparison {
  /** The level the comparison ranges over, e.g. [customer].[H1].[country]. */
  levelSpec: string;
  /** The measure NAME (bare, e.g. "totalOrderValue"); the ref is built as [Measures].[name]. */
  measure: string;
  op: ComparisonOp;
  /** Finite; NaN/±Infinity are never composed (composeComparison returns null for them). */
  value: number;
}

/** [Measures].[name] with the same ] -> ]] injection-closure the member refs use, so a measure name
 *  containing ] round-trips. Measure names come from cube metadata; the escape is defence in depth. */
function measureRef(name: string): string {
  return `[Measures].[${name.replace(/]/g, ']]')}]`;
}

/** Compose the canonical, direction-correct MDX for a comparison, or null when it cannot be validly
 *  composed (empty measure or non-finite value) — the boundary rejection the affordance's incomplete
 *  state relies on. The value is rendered as String(Number(v)): a finite number's canonical decimal,
 *  no thousands separators, no locale. */
export function composeComparison(c: ParsedComparison): string | null {
  if (!c.measure || !Number.isFinite(c.value)) return null;
  const L = c.levelSpec;
  const M = measureRef(c.measure);
  const V = String(Number(c.value));
  switch (c.op) {
    case '>':  return `AGGREGATE(FILTER(${L}.MEMBERS,${M}>${V}))`;
    case '>=': return `AGGREGATE(FILTER(${L}.MEMBERS,${M}>=${V}))`;
    case '<':  return `AGGREGATE(EXCEPT(${L}.MEMBERS,FILTER(${L}.MEMBERS,${M}>=${V})))`;
    case '<=': return `AGGREGATE(EXCEPT(${L}.MEMBERS,FILTER(${L}.MEMBERS,${M}>${V})))`;
  }
}

/** A single level spec: [seg](.[seg])*, each bracketed. Copied from condition-mdx.ts:62 (this file is a
 *  standalone value object; the grammar is small and stable enough to duplicate rather than couple). */
const LEVEL = String.raw`\[[^\]]+\](?:\.\[[^\]]+\])*`;
/** [Measures].[name] with a ]]-aware body so an escaped ] in the name is captured and unescaped. */
const MEASURE = String.raw`\[Measures\]\.\[((?:[^\]]|\]\])*)\]`;
/** A canonical JS number as String(Number(x)) emits it: optional sign, int/decimal, optional exponent. */
const NUM = String.raw`(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)`;

// The four shapes, anchored. The EXCEPT (down-direction) forms use a \1 backreference so the two level
// specs must be identical (they always are, from composeComparison). Each op token is a fixed literal,
// so the four regexes are mutually non-matching regardless of order.
const CMP_GT = new RegExp(`^AGGREGATE\\(FILTER\\((${LEVEL})\\.MEMBERS,${MEASURE}>${NUM}\\)\\)$`);
const CMP_GE = new RegExp(`^AGGREGATE\\(FILTER\\((${LEVEL})\\.MEMBERS,${MEASURE}>=${NUM}\\)\\)$`);
const CMP_LT = new RegExp(`^AGGREGATE\\(EXCEPT\\((${LEVEL})\\.MEMBERS,FILTER\\(\\1\\.MEMBERS,${MEASURE}>=${NUM}\\)\\)\\)$`);
const CMP_LE = new RegExp(`^AGGREGATE\\(EXCEPT\\((${LEVEL})\\.MEMBERS,FILTER\\(\\1\\.MEMBERS,${MEASURE}>${NUM}\\)\\)\\)$`);

function build(m: RegExpExecArray, op: ComparisonOp): ParsedComparison | null {
  const value = Number(m[3]);
  if (!Number.isFinite(value)) return null;
  return { levelSpec: m[1], measure: m[2].replace(/]]/g, ']'), op, value };
}

/** Read a flat slot back into a structured comparison. Recognizes EXACTLY the four composeComparison
 *  shapes (most-specific EXCEPT forms first), so compose->parse is lossless; every other string returns
 *  null and the row falls through to the six-op parser or the free-text hatch. */
export function parseComparison(str: string): ParsedComparison | null {
  const s = str.trim();
  if (!s) return null;
  let m = CMP_LT.exec(s); if (m) return build(m, '<');
  m = CMP_LE.exec(s);     if (m) return build(m, '<=');
  m = CMP_GE.exec(s);     if (m) return build(m, '>=');
  m = CMP_GT.exec(s);     if (m) return build(m, '>');
  return null;
}
