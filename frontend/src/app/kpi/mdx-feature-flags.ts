// frontend/src/app/kpi/mdx-feature-flags.ts
// Release gate for the KPI condition builder. On the shipping SCO release (1.7.3) only two condition
// forms are advertised (Chloe Langley, 2026-09-21, verified against ProductInventoryCube): a single
// member key `[lvl].&[key]` and the null key `[lvl].&[<null>]`. Every other guided operator and the
// aggregate-comparison lane compile to MDX the 1.7.3 KpiConditionParser accepts structurally but the
// engine fails at KPI value/listing time — a silent broken KPI. This module gates those forms out of
// the UI without deleting the compose/parse code, so the switch flips back in one line when 1.8.0 is
// the floor. See docs/superpowers/specs/2026-09-21-kpi-condition-1.8.0-gate-design.md.
import { parseCondition, type ConditionOperator } from '../cube/condition-mdx';
import { parseComparison } from './comparison-mdx';

/** Flip to true (or wire to /config.json) when SCO 1.8.0 is the release floor. */
export const ADVANCED_MDX_CONDITIONS = false;

/** The guided operators safe on 1.7.3 (Chloe's first two table rows). */
const SAFE_OPERATORS: ReadonlySet<ConditionOperator> = new Set(['is', 'isNull']);

/** True for a guided operator that needs SCO 1.8.0 (everything but is / isNull). */
export function isAdvancedOperator(op: ConditionOperator): boolean {
  return !SAFE_OPERATORS.has(op);
}

/** PARSE-ONLY gated-form detection. No raw-token arm, so a safe member key whose key text contains an
 *  MDX keyword (`[dept].[H1].[name].&[R AND D]`, or a key with `.MEMBERS`/braces/`&[a]:&[b]`) parses to
 *  `is` and returns false — it must stay a guided chip (§4.3, GATE-PLAN-06). This is what
 *  `conditionFreeTextForced` uses, NOT `usesAdvancedMdx`. */
export function parsesToAdvancedForm(slot: string): boolean {
  const s = slot.trim();
  if (s === '') return false;
  if (parseComparison(s) !== null) return true;
  const p = parseCondition(s);
  return p !== null && isAdvancedOperator(p.operator);
}

/** Known 1.8.0-only MDX tokens, matched case-insensitively on the raw slot. Loud on purpose: a false
 *  positive costs only a dismissible caution, a false negative is no worse than shipping today. Used
 *  ONLY by usesAdvancedMdx (the advisory), never by the force decision. */
const ADVANCED_TOKENS: readonly RegExp[] = [
  /except\s*\(/i,
  /aggregate\s*\(/i,
  /filter\s*\(/i,
  /crossjoin\s*\(/i,
  /topcount\s*\(/i,
  /%or\b/i,
  /%search\b/i,
  /%timerange\b/i,
  /\.members\b/i,
  /\{[^}]*\}/,            // a member set { … }
  /&\[[^\]]*\]\s*:\s*&?\[/, // a member range &[a]:&[b]
  /\bAND\b/,              // AND / OR combiners (case-sensitive: MDX keywords, avoids matching "brand")
  /\bOR\b/,
];

/** SUPERSET of parsesToAdvancedForm: true if the slot parses to a gated form OR contains a raw 1.8.0
 *  token. Drives ONLY the advisory (§4.4) — a false positive there is a dismissible caution. Empty is
 *  safe. Do NOT wire this to the force-to-free-text decision (§4.3) — use parsesToAdvancedForm. */
export function usesAdvancedMdx(slot: string): boolean {
  const s = slot.trim();
  if (s === '') return false;
  if (parsesToAdvancedForm(s)) return true;
  return ADVANCED_TOKENS.some((re) => re.test(s));
}
