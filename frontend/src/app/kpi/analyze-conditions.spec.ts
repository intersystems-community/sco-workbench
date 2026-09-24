import { analyzeConditions, conditionsMergeable, lintFreeTextConditions, type Diagnostic } from './analyze-conditions';
import { parseCondition, type ParsedCondition } from '../cube/condition-mdx';
import { composeComparison } from './comparison-mdx';

const L = '[c].[H1].[cat]';            // one level
const L2 = '[r].[H1].[reg]';           // a different dimension's level
const row = (operator: ParsedCondition['operator'], keys: string[], levelSpec = L): ParsedCondition =>
  ({ operator, levelSpec, keys });
const kinds = (ds: Diagnostic[]) => ds.map((d) => d.kind).sort();
const NO_MEMBERS = new Map<string, readonly string[]>();

describe('analyzeConditions — contradiction (always 0, provable from text)', () => {
  it('flags two disjoint is rows on the same level', () => {
    const ds = analyzeConditions([row('is', ['Battery']), row('is', ['CPU'])], NO_MEMBERS);
    expect(ds.some((d) => d.kind === 'contradiction' && d.rows.includes(0) && d.rows.includes(1))).toBe(true);
  });
  it('flags is X AND is not X on the same level', () => {
    expect(kinds(analyzeConditions([row('is', ['Battery']), row('isNot', ['Battery'])], NO_MEMBERS)))
      .toContain('contradiction');
  });
  it('flags isNull AND isNotNull on the same level', () => {
    expect(kinds(analyzeConditions([row('isNull', []), row('isNotNull', [])], NO_MEMBERS)))
      .toContain('contradiction');
  });
  it('flags isOneOf {A,B} fully excluded by is Y where Y∉{A,B}', () => {
    expect(kinds(analyzeConditions([row('isOneOf', ['A', 'B']), row('is', ['Z'])], NO_MEMBERS)))
      .toContain('contradiction');
  });
});

describe('analyzeConditions — redundancy / noop', () => {
  it('flags two identical rows as redundancy (not contradiction)', () => {
    const ds = analyzeConditions([row('is', ['Battery']), row('is', ['Battery'])], NO_MEMBERS);
    expect(kinds(ds)).toContain('redundancy');
    expect(kinds(ds)).not.toContain('contradiction');
  });
  it('flags isOneOf selecting ALL members as noop', () => {
    const universe = new Map<string, readonly string[]>([[L, ['Battery', 'CPU']]]);
    expect(kinds(analyzeConditions([row('isOneOf', ['Battery', 'CPU'])], universe))).toContain('noop');
  });
  it('flags isNotNull on a level with no <null> member as noop', () => {
    const universe = new Map<string, readonly string[]>([[L, ['Battery', 'CPU']]]);   // no '<null>'
    expect(kinds(analyzeConditions([row('isNotNull', [])], universe))).toContain('noop');
  });
  it('does NOT flag isNotNull noop when the universe contains a <null> member', () => {
    const universe = new Map<string, readonly string[]>([[L, ['Battery', '<null>']]]);
    expect(kinds(analyzeConditions([row('isNotNull', [])], universe))).not.toContain('noop');
  });
});

describe('analyzeConditions — orNudge', () => {
  it('nudges when a 2nd is/isOneOf row is added on a level that already has one (overlapping, not contradictory)', () => {
    const ds = analyzeConditions([row('isOneOf', ['A', 'B']), row('isOneOf', ['B', 'C'])], NO_MEMBERS);
    expect(kinds(ds)).toContain('orNudge');
    expect(kinds(ds)).not.toContain('contradiction');   // sets overlap on B → not always 0
  });
  it('suppresses the nudge when the pair is already a contradiction', () => {
    const ds = analyzeConditions([row('is', ['Battery']), row('is', ['CPU'])], NO_MEMBERS);
    expect(kinds(ds)).toContain('contradiction');
    expect(kinds(ds)).not.toContain('orNudge');
  });
});

describe('analyzeConditions — deliberate silences', () => {
  it('ignores free-text (null) rows entirely', () => {
    expect(analyzeConditions([null, row('is', ['Battery'])], NO_MEMBERS)).toEqual([]);
  });
  it('is SILENT on a cross-dimension pair (different levelSpec) — not a contradiction', () => {
    expect(analyzeConditions([row('is', ['Battery'], L), row('is', ['North'], L2)], NO_MEMBERS)).toEqual([]);
  });
  it('skips the noop check for a level absent from levelMembers (no false positive)', () => {
    expect(kinds(analyzeConditions([row('isOneOf', ['A', 'B'])], NO_MEMBERS))).not.toContain('noop');
  });
});

describe('analyzeConditions — unknownMember advisory (Item 1: typed value not a live member)', () => {
  const U = new Map<string, readonly string[]>([[L, ['Battery', 'CPU']]]);

  it('flags an `is` row whose key is not in the present universe', () => {
    expect(kinds(analyzeConditions([row('is', ['Nowhere'])], U))).toContain('unknownMember');
  });
  it('flags an `isOneOf` row when any key is not in the universe', () => {
    expect(kinds(analyzeConditions([row('isOneOf', ['Battery', 'Nowhere'])], U))).toContain('unknownMember');
  });
  it('does NOT flag a key that IS in the universe', () => {
    expect(kinds(analyzeConditions([row('is', ['Battery'])], U))).not.toContain('unknownMember');
  });
  it('does NOT flag negation (excluding a nonexistent value is a harmless no-op, not the trap)', () => {
    expect(kinds(analyzeConditions([row('isNot', ['Nowhere'])], U))).not.toContain('unknownMember');
    expect(kinds(analyzeConditions([row('isNotOneOf', ['Nowhere', 'Nobody'])], U))).not.toContain('unknownMember');
  });
  it('is SILENT when the universe is absent (not yet fetched) — mirrors the no-op silence', () => {
    expect(kinds(analyzeConditions([row('is', ['Nowhere'])], NO_MEMBERS))).not.toContain('unknownMember');
  });
  it('never flags the <null> key (null is a real member, expressed via is null)', () => {
    const un = new Map<string, readonly string[]>([[L, ['Battery']]]);   // universe has no <null>
    expect(kinds(analyzeConditions([row('isOneOf', ['<null>'])], un))).not.toContain('unknownMember');
  });
  it('never flags the empty-key sentinel (incomplete row, handled by the submit gate)', () => {
    expect(kinds(analyzeConditions([row('is', [''])], U))).not.toContain('unknownMember');
  });
});

describe('analyzeConditions — guard that fires (silence tests are not trivially green)', () => {
  it('the same construction the silence tests use DOES flag when on the same level', () => {
    // identical to the cross-dim silence test but same level → MUST flag, proving silence ≠ dead code
    const ds = analyzeConditions([row('is', ['Battery'], L), row('is', ['North'], L)], NO_MEMBERS);
    expect(ds.some((d) => d.kind === 'contradiction')).toBe(true);
  });
});

describe('conditionsMergeable — the pure merge predicate (Task 1)', () => {
  const P = (operator: any, keys: string[], levelSpec = '[product].[H1].[productFamily]') =>
    ({ operator, levelSpec, keys }) as ParsedCondition;

  it('two positive rows on the same level → isOneOf', () => {
    expect(conditionsMergeable(P('is', ['A']), P('is', ['B']))).toEqual({ op: 'isOneOf' });
    expect(conditionsMergeable(P('isOneOf', ['A', 'B']), P('is', ['C']))).toEqual({ op: 'isOneOf' });
  });

  it('two negative rows on the same level → isNotOneOf', () => {
    expect(conditionsMergeable(P('isNot', ['A']), P('isNot', ['B']))).toEqual({ op: 'isNotOneOf' });
    expect(conditionsMergeable(P('isNotOneOf', ['A', 'B']), P('isNot', ['C']))).toEqual({ op: 'isNotOneOf' });
  });

  it('is × isNot on the same level does NOT merge (no clean single-op result)', () => {
    expect(conditionsMergeable(P('is', ['A']), P('isNot', ['B']))).toBeNull();
  });

  it('null variants never merge', () => {
    expect(conditionsMergeable(P('isNull', []), P('isNotNull', []))).toBeNull();
    expect(conditionsMergeable(P('isNull', []), P('is', ['A']))).toBeNull();
  });

  it('different levels never merge (even same family)', () => {
    expect(conditionsMergeable(
      P('is', ['A'], '[product].[H1].[productFamily]'),
      P('is', ['B'], '[status].[H1].[status]'),
    )).toBeNull();
  });

  it('a key-less side (empty-key sentinel) does not merge', () => {
    expect(conditionsMergeable(P('is', []), P('is', ['B']))).toBeNull();
    expect(conditionsMergeable(P('is', ['']), P('is', ['B']))).toBeNull(); // '' is not a real key
  });

  it('null / free-text (either side null) does not merge', () => {
    expect(conditionsMergeable(null, P('is', ['A']))).toBeNull();
    expect(conditionsMergeable(P('is', ['A']), null)).toBeNull();
  });
});

// ── SC-2701 Option 1: free-text unaggregated-FILTER lint (spec §4, §6.A) ──
describe('lintFreeTextConditions — unaggregated FILTER guard', () => {
  // Spec §4.1 case table. warn === true → exactly one 'unaggregatedFilter' on row 0.
  const CASES: Array<[label: string, input: string, warn: boolean]> = [
    ['C1 bare FILTER',                'FILTER([r].[H1].[reg].MEMBERS,[Total]>600)',            true],
    ['C2 cross-measure FILTER',       'FILTER([r].[H1].[reg].MEMBERS,[Total]>[Cnt]*100)',      true],
    ['C3 AGGREGATE(FILTER)',          'AGGREGATE(FILTER([r].[H1].[reg].MEMBERS,[Total]>600))',  false],
    ['C4 AGGREGATE(  FILTER) ws',     'AGGREGATE(  FILTER([r].[H1].[reg].MEMBERS,[Total]>600))', false],
    ['C5 lowercase agg(filter)',      'aggregate(filter([r].[H1].[reg].MEMBERS,[Total]>600))',  false],
    ['C6 %OR(FILTER) NOT safe',       '%OR(FILTER([r].[H1].[reg].MEMBERS,[Total]>600))',        true],
    ['C7 filter (ws before paren)',   'filter ([r].[H1].[reg].MEMBERS,[Total]>600)',            true],
    ['C8 AGG(FILTER)+FILTER',         'AGGREGATE(FILTER([r].&[a])) + FILTER([r].&[b])',         true],
    ['C9 explicit set',               '{[r].[H1].[reg].&[North],[r].[H1].[reg].&[East]}',       false],
    ['C10 canonical is',              '[r].[H1].[reg].&[North]',                                false],
    ['C11 whitespace-only',           '   ',                                                    false],
    ['C13 XAGGREGATE(FILTER) bogus',  'XAGGREGATE(FILTER([r].[H1].[reg].MEMBERS,[Total]>600))', true],
  ];

  for (const [label, input, warn] of CASES) {
    it(`${label} → ${warn ? 'WARN' : 'no warn'}`, () => {
      const ds = lintFreeTextConditions([input]);
      if (warn) {
        expect(ds).toHaveLength(1);
        expect(ds[0]).toMatchObject({ kind: 'unaggregatedFilter', rows: [0] });
        expect(ds[0].message).toContain('total of the matching rows');
      } else {
        expect(ds).toEqual([]);
      }
    });
  }

  it('reports the offending row index, not 0 or a neighbor (row-index fidelity)', () => {
    const ds = lintFreeTextConditions(['{[r].[H1].[reg].&[North]}', 'FILTER([r].[H1].[reg].MEMBERS,[Total]>600)', '']);
    expect(ds).toHaveLength(1);
    expect(ds[0].rows).toEqual([1]);
  });

  it('skips null slots (never throws on a null entry)', () => {
    expect(lintFreeTextConditions([null, 'FILTER([r].[H1].[reg].MEMBERS,[Total]>600)'])).toHaveLength(1);
    expect(lintFreeTextConditions([null, 'FILTER([r].[H1].[reg].MEMBERS,[Total]>600)'])[0].rows).toEqual([1]);
  });

  it('emits disjoint row indices from analyzeConditions (concat is collision-free — spec §3.1)', () => {
    // Row 0 & 1: a guided contradiction pair (parse OK → analyzer sees them, lint skips them).
    // Row 2: a bare-FILTER free-text row (parse null → lint sees it, analyzer skips it).
    const raw = ['[c].[H1].[cat].&[Battery]', '[c].[H1].[cat].&[CPU]', 'FILTER([c].[H1].[cat].MEMBERS,[Total]>600)'];
    const guided = analyzeConditions(raw.map((s) => parseCondition(s)), NO_MEMBERS);
    const freeText = lintFreeTextConditions(raw);
    const guidedRows = new Set(guided.flatMap((d) => d.rows));
    const freeTextRows = new Set(freeText.flatMap((d) => d.rows));
    expect([...freeTextRows].some((r) => guidedRows.has(r))).toBe(false);   // no shared row index
    expect(freeTextRows.has(2)).toBe(true);                                 // lint caught the free-text row
  });
});

describe('lintFreeTextConditions — comparison rows (SC-2701 Option 2) + message (Task 1b)', () => {
  const AGG_GT = composeComparison({ levelSpec: '[r].[H1].[reg]', measure: 'Total', op: '>', value: 600 })!;
  const AGG_LT = composeComparison({ levelSpec: '[r].[H1].[reg]', measure: 'Total', op: '<', value: 600 })!;
  const BARE   = 'FILTER([r].[H1].[reg].MEMBERS,[Total]>600)';

  it('does NOT warn on a composed > comparison (AGGREGATE(FILTER))', () => {
    expect(lintFreeTextConditions([AGG_GT])).toEqual([]);
  });
  it('does NOT warn on a composed < comparison (AGGREGATE(EXCEPT(...FILTER...))) — the false-positive the guard would hit', () => {
    // Without the parseComparison skip, hasUnaggregatedFilter flags the EXCEPT-wrapped FILTER. This pins
    // that the affordance's own correct < output is silent.
    expect(lintFreeTextConditions([AGG_LT])).toEqual([]);
  });
  it('STILL warns on a hand-typed bare FILTER (parseComparison returns null for it)', () => {
    const ds = lintFreeTextConditions([BARE]);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ kind: 'unaggregatedFilter', rows: [0] });
  });

  // Task 1b: the message must stop advising AGGREGATE as a universal rewrite and steer to the affordance.
  it('the unaggregatedFilter message does NOT recommend AGGREGATE, and points at the guided comparison', () => {
    const ds = lintFreeTextConditions([BARE]);
    expect(ds[0].message).not.toMatch(/AGGREGATE\s*\(\s*FILTER/i);
    expect(ds[0].message).toMatch(/guided aggregate comparison/i);
    expect(ds[0].message).toContain('total of the matching rows');   // the retained clause (behaviour unchanged)
  });
});
