import { memberRef as feMemberRef, type MemberRefInput } from './member-ref';
import { memberRef as beMemberRef } from '../../../../backend/src/dashboard/member-ref';

// Every case the two copies must agree on — name form, key form, fallbacks, injection.
const CASES: { sel: MemberRefInput; form: 'name' | 'key' }[] = [
  { sel: { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active' }, form: 'name' },
  { sel: { dim: 'status', member: 'Active' }, form: 'name' },
  { sel: { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' }, form: 'key' },
  { sel: { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active' }, form: 'key' },
  { sel: { dim: 'd', levelSpec: '[d].[H1].[l]', member: 'a]b' }, form: 'name' },
  { sel: { dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' }, form: 'key' },
];

describe('member-ref FE mirror', () => {
  it('emits the canonical key form', () => {
    expect(feMemberRef({ dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' }, 'key'))
      .toBe('[status].[H1].[status].&[Active]');
  });

  it('is byte-identical to the backend source for every case (cannot drift)', () => {
    for (const { sel, form } of CASES) {
      expect(feMemberRef(sel, form)).toBe(beMemberRef(sel, form));
    }
  });
});
