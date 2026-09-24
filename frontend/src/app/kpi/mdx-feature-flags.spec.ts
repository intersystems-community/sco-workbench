import { describe, it, expect } from 'vitest';
import {
  ADVANCED_MDX_CONDITIONS, isAdvancedOperator, parsesToAdvancedForm, usesAdvancedMdx,
} from './mdx-feature-flags';

const SAFE_MEMBER_KEY = '[quantityStatus].[H1].[status].&[Normal]';
const SAFE_NULL_KEY = '[actualTimeOfArrival].[H1].[value].&[<null>]';
// The boundary that keeps §4.3 correct: a genuine, 1.7.3-valid single member key whose KEY TEXT
// contains the MDX keyword "AND". It parses to `is`, so it is NOT an advanced form — but the loud
// token heuristic trips on `\bAND\b`. parsesToAdvancedForm must say false; usesAdvancedMdx says true.
const BOUNDARY_KEY_WITH_KEYWORD = '[dept].[H1].[name].&[R AND D]';

const GATED_EXCEPT = 'EXCEPT([q].[H1].[s].MEMBERS,{[q].[H1].[s].&[Normal]})';
const GATED_SET = '{[q].[H1].[s].&[A],[q].[H1].[s].&[B]}';
const GATED_AGGREGATE = 'AGGREGATE(FILTER([c].[H1].[c].MEMBERS,[Measures].[rev]>100))';

describe('mdx-feature-flags', () => {
  it('ships with advanced MDX conditions OFF (1.7.3 floor)', () => {
    expect(ADVANCED_MDX_CONDITIONS).toBe(false);
  });

  it('allows exactly is and isNull', () => {
    expect(isAdvancedOperator('is')).toBe(false);
    expect(isAdvancedOperator('isNull')).toBe(false);
    for (const op of ['isOneOf', 'isNot', 'isNotOneOf', 'isNotNull'] as const) {
      expect(isAdvancedOperator(op)).toBe(true);
    }
  });

  describe('parsesToAdvancedForm — parse-only, drives the force-to-free-text decision', () => {
    it('is false for safe forms, empty, and — critically — a member key whose text contains a keyword', () => {
      expect(parsesToAdvancedForm(SAFE_MEMBER_KEY)).toBe(false);
      expect(parsesToAdvancedForm(SAFE_NULL_KEY)).toBe(false);
      expect(parsesToAdvancedForm('')).toBe(false);
      expect(parsesToAdvancedForm('   ')).toBe(false);
      // GATE-PLAN-06 regression guard: this parses to `is`, so it must NOT be forced out of guided.
      expect(parsesToAdvancedForm(BOUNDARY_KEY_WITH_KEYWORD)).toBe(false);
    });

    it('is true for a loaded gated guided/comparison form', () => {
      expect(parsesToAdvancedForm(GATED_EXCEPT)).toBe(true);       // isNot / isNotNull
      expect(parsesToAdvancedForm(GATED_SET)).toBe(true);          // isOneOf
      expect(parsesToAdvancedForm(GATED_AGGREGATE)).toBe(true);    // aggregate comparison
    });
  });

  describe('usesAdvancedMdx — superset (parse OR token), drives the advisory only', () => {
    it('is false for safe forms and empty', () => {
      expect(usesAdvancedMdx(SAFE_MEMBER_KEY)).toBe(false);
      expect(usesAdvancedMdx(SAFE_NULL_KEY)).toBe(false);
      expect(usesAdvancedMdx('')).toBe(false);
      expect(usesAdvancedMdx('   ')).toBe(false);
    });

    it('is true for every gated parsed form', () => {
      expect(usesAdvancedMdx(GATED_EXCEPT)).toBe(true);
      expect(usesAdvancedMdx(GATED_SET)).toBe(true);
      expect(usesAdvancedMdx(GATED_AGGREGATE)).toBe(true);
    });

    it('is true for raw 1.8.0 tokens case-insensitively', () => {
      for (const s of [
        'except([a].members,{[a].&[x]})',
        'aggregate(filter([a].members,[Measures].[m]>0))',
        'crossjoin([a].&[x],[b].&[y])',
        '[a].&[x] AND [b].&[y]',
        '[a].&[x] OR [b].&[y]',
        '%OR({[a].&[x],[b].&[y]})',
        '%SEARCH.&[([Measures].[m]>0)]',
        '[d].[H1].[year].&[2026]:[d].[H1].[year].&[2027]',
        '[q].[H1].[s].MEMBERS',
      ]) {
        expect(usesAdvancedMdx(s)).toBe(true);
      }
    });
  });

  it('the two detectors DIVERGE on the boundary key — locks the §4.3/§4.4 split', () => {
    // The whole point of two functions: force decision says "safe, stay guided"; advisory says
    // "loud caution" (harmless). If these ever agree here, GATE-PLAN-06 has regressed.
    expect(parsesToAdvancedForm(BOUNDARY_KEY_WITH_KEYWORD)).toBe(false);
    expect(usesAdvancedMdx(BOUNDARY_KEY_WITH_KEYWORD)).toBe(true);
  });
});
