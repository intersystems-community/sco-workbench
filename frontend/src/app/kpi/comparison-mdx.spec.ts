import { composeComparison, parseComparison, type ParsedComparison } from './comparison-mdx';

const L = '[customer].[H1].[country]';
const M = 'totalOrderValue';
const base = (op: ParsedComparison['op'], value: number, measure = M, levelSpec = L): ParsedComparison =>
  ({ levelSpec, measure, op, value });

describe('comparison-mdx composeComparison — exact strings', () => {
  it('> emits AGGREGATE(FILTER(...M>V))', () => {
    expect(composeComparison(base('>', 45000000)))
      .toBe('AGGREGATE(FILTER([customer].[H1].[country].MEMBERS,[Measures].[totalOrderValue]>45000000))');
  });
  it('>= emits AGGREGATE(FILTER(...M>=V))', () => {
    expect(composeComparison(base('>=', 45000000)))
      .toBe('AGGREGATE(FILTER([customer].[H1].[country].MEMBERS,[Measures].[totalOrderValue]>=45000000))');
  });
  it('< emits AGGREGATE(EXCEPT(...,FILTER(...M>=V))) — complement of the >= set', () => {
    expect(composeComparison(base('<', 45000000)))
      .toBe('AGGREGATE(EXCEPT([customer].[H1].[country].MEMBERS,FILTER([customer].[H1].[country].MEMBERS,[Measures].[totalOrderValue]>=45000000)))');
  });
  it('<= emits AGGREGATE(EXCEPT(...,FILTER(...M>V))) — complement of the > set', () => {
    expect(composeComparison(base('<=', 45000000)))
      .toBe('AGGREGATE(EXCEPT([customer].[H1].[country].MEMBERS,FILTER([customer].[H1].[country].MEMBERS,[Measures].[totalOrderValue]>45000000)))');
  });
  it('the complement operator flips: < uses >= inside, <= uses > inside (asserted explicitly)', () => {
    expect(composeComparison(base('<', 10))).toContain('[Measures].[totalOrderValue]>=10)');
    expect(composeComparison(base('<', 10))).not.toContain('[Measures].[totalOrderValue]>10)');
    expect(composeComparison(base('<=', 10))).toContain('[Measures].[totalOrderValue]>10)');
    expect(composeComparison(base('<=', 10))).not.toContain('[Measures].[totalOrderValue]>=10)');
  });
});

describe('comparison-mdx composeComparison — value canonicalization + rejection at the boundary', () => {
  it('renders finite values canonically (no thousands separators, no locale)', () => {
    expect(composeComparison(base('>', 45000000))).toContain('>45000000)');
    expect(composeComparison(base('>', 1.5))).toContain('>1.5)');
    expect(composeComparison(base('>', 0))).toContain('>0)');
    expect(composeComparison(base('>', -3))).toContain('>-3)');
  });
  it('returns null (never a string) for a non-finite value or empty measure', () => {
    expect(composeComparison(base('>', NaN))).toBeNull();
    expect(composeComparison(base('>', Infinity))).toBeNull();
    expect(composeComparison(base('>', -Infinity))).toBeNull();
    expect(composeComparison(base('>', 5, ''))).toBeNull();
  });
});

describe('comparison-mdx parseComparison — round-trip (non-vacuous)', () => {
  const ops: ParsedComparison['op'][] = ['>', '>=', '<', '<='];
  for (const op of ops) {
    for (const value of [45000000, 1.5, 0, -3]) {
      it(`round-trips ${op} ${value}`, () => {
        const c = base(op, value);
        const composed = composeComparison(c)!;
        expect(parseComparison(composed)).toEqual(c);
      });
    }
  }
  it('round-trips a measure name containing ] (injection-closed, ] -> ]])', () => {
    const c = base('>', 5, 'weird]name');
    const composed = composeComparison(c)!;
    expect(composed).toContain('[Measures].[weird]]name]');   // ] doubled on the way out
    expect(parseComparison(composed)).toEqual(c);             // and back to the exact bare name
  });
  it('round-trips a multi-segment level spec', () => {
    const c = base('<', 7, M, '[d].[H1].[a].[b]');
    expect(parseComparison(composeComparison(c)!)).toEqual(c);
  });
});

describe('comparison-mdx parseComparison — returns null for non-emissions (falls through to free-text)', () => {
  it('null for a bare FILTER (the Option-1 trap — NOT one of our shapes)', () => {
    expect(parseComparison('FILTER([r].[H1].[reg].MEMBERS,[Measures].[Total]>600)')).toBeNull();
  });
  it('null for an AGGREGATE(FILTER) in the < direction (a silent-wrong mutant string)', () => {
    // Shape-wise this IS a > / >= emission; it parses as that direction, NOT as <. The point:
    // the < direction is ONLY the EXCEPT form, so a bare AGGREGATE(FILTER) can never be read as <.
    const p = parseComparison('AGGREGATE(FILTER([r].[H1].[reg].MEMBERS,[Measures].[Total]>600))');
    expect(p?.op).toBe('>');            // never '<'
  });
  it('null for a six-op set / EXCEPT-of-a-set (the guided negation) / empty', () => {
    expect(parseComparison('{[r].[H1].[reg].&[North]}')).toBeNull();
    expect(parseComparison('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})')).toBeNull();
    expect(parseComparison('[r].[H1].[reg].&[North]')).toBeNull();
    expect(parseComparison('')).toBeNull();
    expect(parseComparison('   ')).toBeNull();
  });
});

// ── Literal mirror the it-test depends on (spec §6). The backend it-test cannot import this FE file,
//    so it hard-codes these exact strings; this block guarantees composeComparison still produces them,
//    so a composer change reddens HERE (and the it-test literal is the fixed engine-truth pin).
describe('comparison-mdx — RegionD it-cube literal mirror (kpi-comparison.it.test.ts)', () => {
  const RL = '[RegionD].[H1].[Region]';
  it('the four composed strings the it-test pins are byte-exact', () => {
    expect(composeComparison({ levelSpec: RL, measure: 'Total', op: '>', value: 600 }))
      .toBe('AGGREGATE(FILTER([RegionD].[H1].[Region].MEMBERS,[Measures].[Total]>600))');
    expect(composeComparison({ levelSpec: RL, measure: 'Total', op: '>=', value: 630 }))
      .toBe('AGGREGATE(FILTER([RegionD].[H1].[Region].MEMBERS,[Measures].[Total]>=630))');
    expect(composeComparison({ levelSpec: RL, measure: 'Total', op: '<', value: 600 }))
      .toBe('AGGREGATE(EXCEPT([RegionD].[H1].[Region].MEMBERS,FILTER([RegionD].[H1].[Region].MEMBERS,[Measures].[Total]>=600)))');
    expect(composeComparison({ levelSpec: RL, measure: 'Total', op: '<=', value: 500 }))
      .toBe('AGGREGATE(EXCEPT([RegionD].[H1].[Region].MEMBERS,FILTER([RegionD].[H1].[Region].MEMBERS,[Measures].[Total]>500)))');
  });
});
