import { describe, it, expect } from 'vitest';
import { memberRef } from '../../src/dashboard/member-ref.js';

describe('memberRef', () => {
  it('name form matches the pre-extraction filterMemberRef output', () => {
    expect(memberRef({ dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active' }, 'name'))
      .toBe('[status].[H1].[status].[Active]');
  });

  it('name form falls back to [dim] when no level spec resolved', () => {
    expect(memberRef({ dim: 'status', member: 'Active' }, 'name')).toBe('[status].[Active]');
  });

  it('key form emits the canonical &[key] reference', () => {
    expect(memberRef({ dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' }, 'key'))
      .toBe('[status].[H1].[status].&[Active]');
  });

  it('key form falls back to the name form when key is absent (never &[undefined])', () => {
    expect(memberRef({ dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active' }, 'key'))
      .toBe('[status].[H1].[status].[Active]');
  });

  it('closes bracket injection in both forms (] -> ]])', () => {
    expect(memberRef({ dim: 'd', levelSpec: '[d].[H1].[l]', member: 'a]b' }, 'name'))
      .toBe('[d].[H1].[l].[a]]b]');
    expect(memberRef({ dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' }, 'key'))
      .toBe('[d].[H1].[l].&[a]]b]');
  });
});
