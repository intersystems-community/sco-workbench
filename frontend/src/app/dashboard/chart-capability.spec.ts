import { CAPABILITY_TYPES as FE_CAPABILITY_TYPES } from './chart-capability';
import { CAPABILITY_TYPES as BE_CAPABILITY_TYPES } from '../../../../backend/src/dashboard/chart-type-advisor';

describe('CAPABILITY_TYPES — the FE mirror and the backend allow-list are machine-checked equal', () => {
  it('the two lists contain exactly the same tokens (adding a type to one and not the other reds this)', () => {
    // Comment-only lockstep before this test: a token added to one list compiled clean on both sides.
    expect([...FE_CAPABILITY_TYPES].sort()).toEqual([...BE_CAPABILITY_TYPES].sort());
  });

  it('both lists include sankey', () => {
    expect(FE_CAPABILITY_TYPES).toContain('sankey');
    expect(BE_CAPABILITY_TYPES as readonly string[]).toContain('sankey');
  });
});
