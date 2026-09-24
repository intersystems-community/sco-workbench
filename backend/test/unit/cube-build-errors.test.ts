import { describe, it, expect } from 'vitest';
import {
  stripPrintBuildErrorsHint,
  formatBuildErrorMessage,
  type BuildErrorSummary,
} from '../../src/iris/cube-build-errors.js';

describe('stripPrintBuildErrorsHint', () => {
  it('removes the "run %PrintBuildErrors yourself" pointer from a build summary', () => {
    const raw =
      'ERROR #20006: There were 1445 errors while building cube SALESORDER. ' +
      'For more detailed information: Do ##class(%DeepSee.Utils).%PrintBuildErrors("SALESORDER").';
    const cleaned = stripPrintBuildErrorsHint(raw);
    expect(cleaned).not.toMatch(/%PrintBuildErrors/i);
    expect(cleaned).not.toMatch(/For more detailed information/i);
    expect(cleaned).toMatch(/1445 errors while building cube SALESORDER/);
  });

  it('leaves a message with no hint unchanged (trimmed)', () => {
    expect(stripPrintBuildErrorsHint('ERROR #5001: bad source')).toBe('ERROR #5001: bad source');
  });

  it('removes a bare Do ##class(...).%PrintBuildErrors(...) fragment even without the lead-in', () => {
    const raw = 'Build failed. Do ##class(%DeepSee.Utils).%PrintBuildErrors("X").';
    expect(stripPrintBuildErrorsHint(raw)).toBe('Build failed.');
  });
});

describe('formatBuildErrorMessage', () => {
  it('renders total + a single deduped sample with its occurrence count', () => {
    const summary: BuildErrorSummary = {
      total: 1445,
      distinct: 1,
      samples: [
        {
          message:
            "ERROR #20027: Error inserting/updating fact: (Source ID:'3') Field 'X.Fact.MxorderCurrencyI' (value 'USD') failed validation",
          count: 1445,
        },
      ],
    };
    const msg = formatBuildErrorMessage('SALESORDER', summary);
    expect(msg).toMatch(/1445 row errors/);
    expect(msg).toMatch(/×1445/);
    expect(msg).toMatch(/failed validation/);
  });

  it('uses singular phrasing for a single error and no count marker', () => {
    const summary: BuildErrorSummary = {
      total: 1,
      distinct: 1,
      samples: [{ message: 'ERROR #20027: bad row', count: 1 }],
    };
    const msg = formatBuildErrorMessage('C', summary);
    expect(msg).toMatch(/1 row error:/);
    expect(msg).not.toMatch(/×/);
  });

  it('notes how many additional distinct errors were omitted from the samples', () => {
    const summary: BuildErrorSummary = {
      total: 30,
      distinct: 5,
      samples: [
        { message: 'e1', count: 10 },
        { message: 'e2', count: 10 },
        { message: 'e3', count: 10 },
      ],
    };
    const msg = formatBuildErrorMessage('C', summary);
    expect(msg).toMatch(/and 2 more distinct errors/);
  });
});
