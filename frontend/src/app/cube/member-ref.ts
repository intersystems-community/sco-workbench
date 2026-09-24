// frontend/src/app/cube/member-ref.ts
// MIRROR of backend/src/dashboard/member-ref.ts. Kept byte-identical by member-ref.spec.ts
// (cross-workspace pin) so the injection-closing escape can never silently diverge between
// the two copies. Only kpi.ts (KPI conditions) uses this in FE production code — the dashboard
// cube-builder sends structured data and composes MDX server-side.
export interface MemberRefInput { dim: string; levelSpec?: string; member: string; key?: string }

export function memberRef(sel: MemberRefInput, form: 'name' | 'key'): string {
  const spec = sel.levelSpec ?? `[${sel.dim}]`;
  const esc = (s: string): string => s.replace(/]/g, ']]');
  if (form === 'key' && sel.key != null) return `${spec}.&[${esc(sel.key)}]`;
  return `${spec}.[${esc(sel.member)}]`;
}
