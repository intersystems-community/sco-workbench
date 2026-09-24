// backend/test/unit/humanize-label.test.ts
import { describe, it, expect } from 'vitest';
import { humanizeLabel, ACRONYMS } from '../../src/dashboard/humanize-label.js';
import lockstep from '../../../ci/humanize-lockstep.json' with { type: 'json' };

// The backend twin of the FE humanizeField (frontend/src/app/dashboard/humanize.ts).
// Same word-splitting + acronym allow-list, so a chart TITLE built on the backend
// reads the same as the dimension DROPDOWN humanized on the frontend. Applied only
// to raw identifiers (dimension codes, un-captioned measure names) — an authored
// caption is passed through verbatim by the caller, never through this function.
describe('humanizeLabel — chart titling twin of the FE humanizeField', () => {
  it('splits camelCase dimension codes into Title Case', () => {
    expect(humanizeLabel('productCategory')).toBe('Product Category');
    expect(humanizeLabel('quantityStatus')).toBe('Quantity Status');
    expect(humanizeLabel('locationHierarchy')).toBe('Location Hierarchy');
  });

  it('splits `_` and `.` delimiters', () => {
    expect(humanizeLabel('order_placed_date')).toBe('Order Placed Date');
    expect(humanizeLabel('order.line.id')).toBe('Order Line ID');
  });

  it('keeps allow-listed acronyms upper-case (lockstep with the FE list)', () => {
    expect(humanizeLabel('bomType')).toBe('BOM Type');
    expect(humanizeLabel('kpiName')).toBe('KPI Name');
    expect(humanizeLabel('uid')).toBe('UID');
  });

  it('is idempotent on an already-humanized label, and passes a single word through', () => {
    expect(humanizeLabel('Product Category')).toBe('Product Category');
    expect(humanizeLabel('Region')).toBe('Region');
    expect(humanizeLabel('')).toBe('');
  });

  // Lockstep guard: humanizeLabel MUST agree with the FE humanizeField
  // (ci/humanize-lockstep.json). frontend/src/app/dashboard/humanize.spec.ts asserts
  // the same fixture, so if either humanizer's output or acronym set drifts, one of
  // the two suites goes red. The CONTRACT is shared (the fixture); the code is not,
  // because the two workspaces build under separate tsconfigs.
  it('matches the shared cross-humanizer lockstep fixture', () => {
    expect([...ACRONYMS].sort()).toEqual([...lockstep.acronyms].sort());
    for (const { input, expected } of lockstep.cases) {
      expect(humanizeLabel(input)).toBe(expected);
    }
  });
});
