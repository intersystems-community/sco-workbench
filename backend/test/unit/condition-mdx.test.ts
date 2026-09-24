import { describe, it, expect } from 'vitest';
import { composeCondition } from '../../src/dashboard/condition-mdx.js';

describe('composeCondition (backend)', () => {
  it("'is' emits the canonical &[key] reference", () => {
    expect(composeCondition({ dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' }, 'is'))
      .toBe('[status].[H1].[status].&[Active]');
  });

  it("'is' falls back to the name form when key is absent (never &[undefined])", () => {
    expect(composeCondition({ dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active' }, 'is'))
      .toBe('[status].[H1].[status].[Active]');
  });

  it("'isNull' emits the documented null-member key", () => {
    expect(composeCondition({ dim: 'atoa', levelSpec: '[actualTimeOfArrival].[H1].[value]', member: 'x' }, 'isNull'))
      .toBe('[actualTimeOfArrival].[H1].[value].&[<null>]');
  });

  it("'isNull' falls back to [dim] when no level spec resolved", () => {
    expect(composeCondition({ dim: 'atoa', member: 'x' }, 'isNull')).toBe('[atoa].&[<null>]');
  });

  it("closes bracket injection in the is key (] -> ]])", () => {
    expect(composeCondition({ dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' }, 'is'))
      .toBe('[d].[H1].[l].&[a]]b]');
  });
});
