// frontend/src/app/cube/member-label.ts
// One place that turns a cube member into its USER-FACING label. Both the model-tree rail and the KPI
// condition-chip picker render members, and both must read a level's null bucket identically — which
// they did NOT before this: a level with `nullReplacement="Undefined"` showed "Undefined" while a level
// with none leaked IRIS's internal `<null>` token straight to the user. This normalizes both to one
// friendly label so the null bucket reads the same regardless of how the cube was authored.

/** IRIS's canonical key for a level's null member (rows whose dimension value is null). */
export const NULL_MEMBER_KEY = '<null>';

/** The single user-facing label for the null bucket, whatever the cube's nullReplacement. */
export const NULL_MEMBER_LABEL = '(no value)';

/** A cube member as the cube-members endpoint returns it. */
export interface LabelableMember {
  name?: string;
  key?: string;
  caption?: string;
}

/**
 * The label to render for a member. Non-null members read caption-or-name as before; the null bucket —
 * identified by its stable KEY `<null>` (present whether or not the cube set a nullReplacement) — always
 * reads {@link NULL_MEMBER_LABEL}. Never affects the composed MDX: the KEY drives the condition string,
 * this touches display only.
 */
export function memberLabel(member: LabelableMember): string {
  if (member.key === NULL_MEMBER_KEY || member.name === NULL_MEMBER_KEY) return NULL_MEMBER_LABEL;
  return member.caption || member.name || '';
}
