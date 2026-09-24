import { describe, it, expect } from 'vitest';
import { memberLabel, NULL_MEMBER_KEY } from './member-label';

describe('memberLabel', () => {
  it('shows a non-null member’s caption when present', () => {
    expect(memberLabel({ name: 'Consumer electronics', key: 'Consumer electronics', caption: 'Consumer Electronics' }))
      .toBe('Consumer Electronics');
  });

  it('falls back to the name when there is no caption', () => {
    expect(memberLabel({ name: 'PART001', key: 'PART001' })).toBe('PART001');
  });

  it('normalizes the raw <null> token (no nullReplacement on the level) to a friendly label', () => {
    // inventoryType / inventoryStatus: the cube set no nullReplacement, so IRIS leaks the token into the NAME.
    expect(memberLabel({ name: NULL_MEMBER_KEY, key: NULL_MEMBER_KEY })).toBe('(no value)');
  });

  it('normalizes a nullReplacement-labelled bucket to the SAME friendly label', () => {
    // productFamily / productBrand / productClass: nullReplacement="Undefined", but the KEY is still <null>.
    // The two cube styles must read identically to the user.
    expect(memberLabel({ name: 'Undefined', key: NULL_MEMBER_KEY })).toBe('(no value)');
  });

  it('is empty-safe', () => {
    expect(memberLabel({})).toBe('');
  });
});
