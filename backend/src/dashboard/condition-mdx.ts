// backend/src/dashboard/condition-mdx.ts
// Byte-mirror of frontend/src/app/cube/condition-mdx.ts's composeCondition. Pinned identical by the
// FE spec's cross-workspace byte-mirror test (condition-mdx.spec.ts), exactly like member-ref.ts.
// No backend caller by design: this exists so the integration test (kpi.it.test.ts) composes exactly
// the MDX the FE ships; the backend passes the condition string through to IRIS unparsed. Do not wire
// a port to it, and do not delete it as dead code.
import { memberRef, type MemberRefInput } from './member-ref.js';

export type ConditionOperator =
  | 'is' | 'isOneOf' | 'isNot' | 'isNotOneOf' | 'isNull' | 'isNotNull';

function levelSpecOf(sel: MemberRefInput): string {
  return sel.levelSpec ?? `[${sel.dim}]`;
}

function memberSet(sels: MemberRefInput[]): string {
  return `{${sels.map((s) => memberRef(s, 'key')).join(',')}}`;
}

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
