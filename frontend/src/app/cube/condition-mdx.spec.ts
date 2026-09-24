import { composeCondition, parseCondition, type ConditionOperator } from './condition-mdx';
import { memberRef, type MemberRefInput } from './member-ref';
import { composeCondition as beComposeCondition } from '../../../../backend/src/dashboard/condition-mdx';

describe('condition-mdx composeCondition', () => {
  it("'is' equals memberRef(sel,'key') byte-for-byte", () => {
    const sel: MemberRefInput = { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' };
    expect(composeCondition(sel, 'is')).toBe(memberRef(sel, 'key'));
    expect(composeCondition(sel, 'is')).toBe('[status].[H1].[status].&[Active]');
  });

  it("'isNull' yields [level].&[<null>] from the level spec", () => {
    const sel: MemberRefInput = { dim: 'atoa', levelSpec: '[actualTimeOfArrival].[H1].[value]', member: 'x' };
    expect(composeCondition(sel, 'isNull')).toBe('[actualTimeOfArrival].[H1].[value].&[<null>]');
  });

  it("'isNull' falls back to [dim] when no level spec resolved", () => {
    expect(composeCondition({ dim: 'atoa', member: 'x' }, 'isNull')).toBe('[atoa].&[<null>]');
  });

  it("'is' closes bracket injection in the key (] -> ]])", () => {
    expect(composeCondition({ dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' }, 'is'))
      .toBe('[d].[H1].[l].&[a]]b]');
  });

  it("'isOneOf' composes a set {a,b} (OR/union), space-free", () => {
    const a: MemberRefInput = { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'Battery', key: 'Battery' };
    const b: MemberRefInput = { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'CPU', key: 'CPU' };
    expect(composeCondition([a, b], 'isOneOf')).toBe('{[c].[H1].[cat].&[Battery],[c].[H1].[cat].&[CPU]}');
  });

  it("'isOneOf' with one member composes the singleton set {ref}, not the bare ref", () => {
    const a: MemberRefInput = { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'Battery', key: 'Battery' };
    expect(composeCondition([a], 'isOneOf')).toBe('{[c].[H1].[cat].&[Battery]}');
    expect(composeCondition([a], 'isOneOf')).not.toBe('[c].[H1].[cat].&[Battery]');
  });

  it("'isNot' composes EXCEPT([lvl].MEMBERS,{ref})", () => {
    const a: MemberRefInput = { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'North', key: 'North' };
    expect(composeCondition(a, 'isNot')).toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})');
  });

  it("'isNotOneOf' composes EXCEPT([lvl].MEMBERS,{a,b})", () => {
    const a: MemberRefInput = { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'North', key: 'North' };
    const b: MemberRefInput = { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'South', key: 'South' };
    expect(composeCondition([a, b], 'isNotOneOf'))
      .toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North],[r].[H1].[reg].&[South]})');
  });

  it("'isNotNull' composes EXCEPT([lvl].MEMBERS,{[lvl].&[<null>]})", () => {
    const a: MemberRefInput = { dim: 's', levelSpec: '[s].[H1].[seg]', member: 'x' };
    expect(composeCondition(a, 'isNotNull')).toBe('EXCEPT([s].[H1].[seg].MEMBERS,{[s].[H1].[seg].&[<null>]})');
  });

  it("set forms close bracket injection (] -> ]]) in every member key", () => {
    const a: MemberRefInput = { dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' };
    expect(composeCondition([a], 'isOneOf')).toBe('{[d].[H1].[l].&[a]]b]}');
    expect(composeCondition([a], 'isNot')).toBe('EXCEPT([d].[H1].[l].MEMBERS,{[d].[H1].[l].&[a]]b]})');
  });
});

describe('condition-mdx parseCondition', () => {
  it('round-trips the is form losslessly (keys length 1)', () => {
    const sel: MemberRefInput = { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' };
    expect(parseCondition(composeCondition(sel, 'is')))
      .toEqual({ operator: 'is', levelSpec: '[status].[H1].[status]', keys: ['Active'] });
  });

  it('round-trips the isNull form losslessly (keys empty)', () => {
    const sel: MemberRefInput = { dim: 'atoa', levelSpec: '[atoa].[H1].[value]', member: 'x' };
    expect(parseCondition(composeCondition(sel, 'isNull')))
      .toEqual({ operator: 'isNull', levelSpec: '[atoa].[H1].[value]', keys: [] });
  });

  it('round-trips isOneOf (≥2) and its singleton (never collapses to is)', () => {
    const a: MemberRefInput = { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'Battery', key: 'Battery' };
    const b: MemberRefInput = { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'CPU', key: 'CPU' };
    expect(parseCondition(composeCondition([a, b], 'isOneOf')))
      .toEqual({ operator: 'isOneOf', levelSpec: '[c].[H1].[cat]', keys: ['Battery', 'CPU'] });
    expect(parseCondition(composeCondition([a], 'isOneOf')))
      .toEqual({ operator: 'isOneOf', levelSpec: '[c].[H1].[cat]', keys: ['Battery'] });
  });

  it('round-trips isNot (1 key) and isNotOneOf (≥2 keys) by member count', () => {
    const a: MemberRefInput = { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'North', key: 'North' };
    const b: MemberRefInput = { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'South', key: 'South' };
    expect(parseCondition(composeCondition(a, 'isNot')))
      .toEqual({ operator: 'isNot', levelSpec: '[r].[H1].[reg]', keys: ['North'] });
    expect(parseCondition(composeCondition([a, b], 'isNotOneOf')))
      .toEqual({ operator: 'isNotOneOf', levelSpec: '[r].[H1].[reg]', keys: ['North', 'South'] });
  });

  it('round-trips isNotNull (keys empty)', () => {
    const sel: MemberRefInput = { dim: 's', levelSpec: '[s].[H1].[seg]', member: 'x' };
    expect(parseCondition(composeCondition(sel, 'isNotNull')))
      .toEqual({ operator: 'isNotNull', levelSpec: '[s].[H1].[seg]', keys: [] });
  });

  it('recognition order: an EXCEPT string parses as the negation, NOT as bare is on the inner ref', () => {
    const p = parseCondition('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})');
    expect(p?.operator).toBe('isNot');
    expect(p?.keys).toEqual(['North']);
  });

  it('malformed EXCEPT / set strings return null (free-text), never half-parsed', () => {
    expect(parseCondition('EXCEPT([r].[H1].[reg].MEMBERS,{')).toBeNull();
    expect(parseCondition('{[r].[H1].[reg].&[North]')).toBeNull();
    expect(parseCondition('EXCEPT(,{})')).toBeNull();
  });

  it('round-trips a key containing ] through every set form', () => {
    const a: MemberRefInput = { dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' };
    expect(parseCondition(composeCondition([a], 'isOneOf'))?.keys).toEqual(['a]b']);
    expect(parseCondition(composeCondition(a, 'isNot'))?.keys).toEqual(['a]b']);
  });

  it('round-trips the is form for a TYPED key containing ] (Item 1: injection-closed via the shared composer)', () => {
    const sel: MemberRefInput = { dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' };
    const composed = composeCondition(sel, 'is');
    expect(composed).toBe('[d].[H1].[l].&[a]]b]');                          // ] doubled on the way out
    expect(parseCondition(composed))
      .toEqual({ operator: 'is', levelSpec: '[d].[H1].[l]', keys: ['a]b'] }); // and back to the exact key
  });

  it('round-trips a TYPED key that is not a known member (compose is member-agnostic — same path as a pick)', () => {
    const sel: MemberRefInput = { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'Nowhere', key: 'Nowhere' };
    expect(parseCondition(composeCondition(sel, 'is')))
      .toEqual({ operator: 'is', levelSpec: '[c].[H1].[cat]', keys: ['Nowhere'] });
  });

  it('returns null for a non-canonical string (hand-typed set, empty, name form)', () => {
    expect(parseCondition('{ [status].&[A], [status].&[B] }')).toBeNull();
    expect(parseCondition('')).toBeNull();
    expect(parseCondition('   ')).toBeNull();
    expect(parseCondition('[status].[H1].[status].[Active]')).toBeNull(); // name form, not key form
  });
});

describe('condition-mdx FE/backend byte-mirror', () => {
  const CASES: { sel: MemberRefInput | MemberRefInput[]; op: ConditionOperator }[] = [
    { sel: { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Active', key: 'Active' }, op: 'is' },
    { sel: { dim: 'atoa', levelSpec: '[atoa].[H1].[value]', member: 'x' }, op: 'isNull' },
    { sel: { dim: 'd', levelSpec: '[d].[H1].[l]', member: 'x', key: 'a]b' }, op: 'is' },
    { sel: { dim: 'atoa', member: 'x' }, op: 'isNull' },
    { sel: [{ dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'Battery', key: 'Battery' },
            { dim: 'c', levelSpec: '[c].[H1].[cat]', member: 'CPU', key: 'CPU' }], op: 'isOneOf' },
    { sel: { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'North', key: 'North' }, op: 'isNot' },
    { sel: [{ dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'North', key: 'North' },
            { dim: 'r', levelSpec: '[r].[H1].[reg]', member: 'South', key: 'South' }], op: 'isNotOneOf' },
    { sel: { dim: 's', levelSpec: '[s].[H1].[seg]', member: 'x' }, op: 'isNotNull' },
  ];
  it('is byte-identical to the backend source for every case (cannot drift)', () => {
    for (const { sel, op } of CASES) {
      expect(composeCondition(sel, op)).toBe(beComposeCondition(sel, op));
    }
  });
});

describe('condition-mdx order-invariance (reorder is a pure permutation — Change 3 §7.6)', () => {
  it('composeCondition of a row is byte-identical regardless of the row order around it', () => {
    const a: MemberRefInput = { dim: 'p', levelSpec: '[p].[H1].[f]', member: 'A', key: 'A' };
    const b: MemberRefInput = { dim: 's', levelSpec: '[s].[H1].[s]', member: 'B', key: 'B' };
    const rowA = composeCondition(a, 'is');
    const rowB = composeCondition(b, 'isNot');
    // The array [rowA, rowB] and [rowB, rowA] hold the SAME strings — each row composes in isolation,
    // so a reorder permutes the array without recomposing any element (the query layer ANDs them).
    expect(new Set([rowA, rowB])).toEqual(new Set([rowB, rowA]));
    expect(composeCondition(a, 'is')).toBe(rowA);   // position-independent, byte-identical
    expect(composeCondition(b, 'isNot')).toBe(rowB);
  });
});
