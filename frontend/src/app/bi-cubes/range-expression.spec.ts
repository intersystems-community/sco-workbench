import { describe, it, expect } from 'vitest';
import { formatRangeExpression, parseRangeExpression, toRangeExpression } from './range-expression';

describe('formatRangeExpression', () => {
  it('formats open, closed and half-open ranges (SCO ProductInventoryCube)', () => {
    expect(formatRangeExpression('(,0]:Expired;(0,7]:Expiring;(7,):Good;')).toEqual([
      '≤ 0 → Expired', '> 0 and ≤ 7 → Expiring', '> 7 → Good',
    ]);
  });

  it('formats an inclusive single-point range and inclusive lower bound', () => {
    expect(formatRangeExpression('(,0):OverShipped;[0,0]:InFull;[100,):NoShip;')).toEqual([
      '< 0 → OverShipped', '= 0 → InFull', '≥ 100 → NoShip',
    ]);
  });

  it('keeps a mixed-bracket range exact', () => {
    expect(formatRangeExpression('[-8,8):OnTime;')).toEqual(['≥ -8 and < 8 → OnTime']);
  });

  it('formats a single test value and labels with spaces', () => {
    expect(formatRangeExpression('5:Five Stars;')).toEqual(['= 5 → Five Stars']);
  });

  it('returns null for empty or unparseable input', () => {
    expect(formatRangeExpression('')).toBeNull();
    expect(formatRangeExpression(undefined)).toBeNull();
    expect(formatRangeExpression('(0,7]Expiring;')).toBeNull();
  });
});

describe('parseRangeExpression / toRangeExpression', () => {
  it('round-trips the SCO expressions exactly', () => {
    for (const e of [
      '(,0]:Expired;(0,7]:Expiring;(7,):Good;',
      '(,0):OverShipped;[0,0]:InFull;(0,100000000]:PartialShipped;(100000000,):NoShip;',
      '(,-8):Early;[-8,8):OnTime;(8,):Late;',
    ]) {
      expect(toRangeExpression(parseRangeExpression(e)!)).toBe(e);
    }
  });

  it('parses a single test value as an inclusive point range', () => {
    expect(parseRangeExpression('5:Five;')).toEqual([{ min: '5', minInclusive: true, max: '5', maxInclusive: true, label: 'Five' }]);
  });

  it('uses exclusive brackets for open bounds, skips unlabeled rules, strips ; from labels', () => {
    expect(toRangeExpression([
      { min: '', minInclusive: true, max: '10', maxInclusive: true, label: 'Low' },
      { min: '10', minInclusive: false, max: '', maxInclusive: true, label: 'Hi;gh' },
      { min: '1', minInclusive: true, max: '2', maxInclusive: true, label: '  ' },
    ])).toBe('(,10]:Low;(10,):High;');
  });
});
