// backend/src/dashboard/member-ref.ts
/**
 * The MDX member reference for a filter/condition tuple. Extracted from cube-query.ts's
 * private filterMemberRef (National Park: one exported, directly-tested home for the
 * injection-closing escape). Two forms:
 *   'name' → `${levelSpec}.[member]`         (dashboard filter; display form)
 *   'key'  → `${levelSpec}.&[key]`           (KPI condition; stable canonical form)
 * Falls back to `[dim]` when no level spec resolved (parallel to memberSet's fallback), and
 * the key form falls back to the name form when `key` is absent (never emits `&[undefined]`).
 * The member/key is bracket-escaped (] → ]]) so it can never close the bracket and inject —
 * belt-and-braces on top of shape validation.
 */
export interface MemberRefInput { dim: string; levelSpec?: string; member: string; key?: string }

export function memberRef(sel: MemberRefInput, form: 'name' | 'key'): string {
  const spec = sel.levelSpec ?? `[${sel.dim}]`;
  const esc = (s: string): string => s.replace(/]/g, ']]');
  if (form === 'key' && sel.key != null) return `${spec}.&[${esc(sel.key)}]`;
  return `${spec}.[${esc(sel.member)}]`;
}
