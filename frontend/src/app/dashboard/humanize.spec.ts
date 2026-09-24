import { humanizeField, humanizeCubeName, ACRONYMS, isStrictIso, humanizeTimestamp, timestampColumns } from './humanize';
import lockstep from '../../../../ci/humanize-lockstep.json' with { type: 'json' };

describe('humanizeField (Change 5 / M1)', () => {
  it('splits camelCase into Title Case words', () => {
    expect(humanizeField('recordCreatedTime')).toBe('Record Created Time');
    expect(humanizeField('unitOfMeasure')).toBe('Unit Of Measure');
    expect(humanizeField('quantityStatus')).toBe('Quantity Status');
  });

  it('splits on underscores and dots too', () => {
    expect(humanizeField('last_updated_time')).toBe('Last Updated Time');
    expect(humanizeField('order.line.id')).toBe('Order Line ID');
  });

  it('keeps allow-listed acronyms upper-case', () => {
    expect(humanizeField('salesOrderId')).toBe('Sales Order ID');
    expect(humanizeField('scacCode')).toBe('SCAC Code');
    expect(humanizeField('bomUrl')).toBe('BOM URL');
    expect(humanizeField('uid')).toBe('UID');
    expect(humanizeField('slaTarget')).toBe('SLA Target');
    expect(humanizeField('kpiName')).toBe('KPI Name');
  });

  it('is idempotent and leaves an already-nice label alone', () => {
    expect(humanizeField('Record Created Time')).toBe('Record Created Time');
    expect(humanizeField(humanizeField('recordCreatedTime'))).toBe('Record Created Time');
  });

  // Lockstep guard: humanizeField MUST agree with the backend twin humanizeLabel
  // (ci/humanize-lockstep.json). backend/test/unit/humanize-label.test.ts asserts
  // the same fixture, so if either humanizer's output or acronym set drifts, one of
  // the two suites goes red. (Cross-workspace sharing of the code itself is awkward
  // here — separate tsconfig/build — so the CONTRACT is shared instead of the code.)
  it('matches the shared cross-humanizer lockstep fixture', () => {
    expect([...ACRONYMS].sort()).toEqual([...lockstep.acronyms].sort());
    for (const { input, expected } of lockstep.cases) {
      expect(humanizeField(input)).toBe(expected);
    }
  });
});

describe('humanizeCubeName (Change 5 / M1 — cube dropdown)', () => {
  it('splits camelCase/PascalCase and drops a trailing "Cube" noise word', () => {
    expect(humanizeCubeName('ConsolidatedInventoryCube')).toBe('Consolidated Inventory');
    expect(humanizeCubeName('SalesOrderLineCube')).toBe('Sales Order Line');
    expect(humanizeCubeName('IssueCube')).toBe('Issue');
  });

  it('keeps the "WB" prefix upper-case and does not strip a non-suffix "Cube"', () => {
    expect(humanizeCubeName('WBDemoEmpty')).toBe('WB Demo Empty');
    expect(humanizeCubeName('WBDemoNoDim')).toBe('WB Demo No Dim');
  });

  it('does not strip "Cube" when it is the whole name (never empties the label)', () => {
    expect(humanizeCubeName('Cube')).toBe('Cube');
  });

  it('keeps allow-listed acronyms upper-case (shares humanizeField acronyms)', () => {
    expect(humanizeCubeName('KpiCube')).toBe('KPI');
  });

  it('is idempotent on an already-humanized label', () => {
    expect(humanizeCubeName('Consolidated Inventory')).toBe('Consolidated Inventory');
    expect(humanizeCubeName(humanizeCubeName('ConsolidatedInventoryCube'))).toBe('Consolidated Inventory');
  });
});

describe('isStrictIso + humanizeTimestamp (Change 5 / M5)', () => {
  it('accepts full ISO-8601 timestamps and formats them readably', () => {
    expect(isStrictIso('2026-08-20T19:57:18.757Z')).toBe(true);
    expect(humanizeTimestamp('2026-08-20T19:57:18.757Z')).toBe('2026-08-20 19:57:18 UTC');
    expect(isStrictIso('2026-08-20T19:57:18Z')).toBe(true);
    expect(humanizeTimestamp('2026-08-20T19:57:18Z')).toBe('2026-08-20 19:57:18 UTC');
    expect(isStrictIso('2026-08-20T19:57:18+02:00')).toBe(true);
  });

  it('rejects date-ish-but-not-strict-ISO strings (left untouched)', () => {
    expect(isStrictIso('2026')).toBe(false);
    expect(isStrictIso('12-31')).toBe(false);
    expect(isStrictIso('2026-08-20')).toBe(false);           // date only, no time
    expect(isStrictIso('2026-13-01T00:00:00Z')).toBe(false); // shape matches, but no round-trip
    expect(isStrictIso('34620997-abcd-10')).toBe(false);     // a UID
    expect(humanizeTimestamp('34620997-abcd-10')).toBe('34620997-abcd-10');
    expect(isStrictIso(1234)).toBe(false);
    expect(isStrictIso(null)).toBe(false);
  });
});

describe('timestampColumns — column-consistency, D2-SPEC-15 (Change 5 / M5)', () => {
  it('flags a column whose every non-empty value is strict-ISO', () => {
    const rows = [
      { uid: 'a-1', createdTime: '2026-08-20T19:57:18.757Z' },
      { uid: 'a-2', createdTime: '2026-08-21T08:00:00Z' },
    ];
    const cols = timestampColumns(rows, ['uid', 'createdTime']);
    expect(cols.has('createdTime')).toBe(true);
    expect(cols.has('uid')).toBe(false);
  });

  it('leaves a whole column RAW if any present value is non-ISO (no intra-column mixing)', () => {
    const rows = [
      { createdTime: '2026-08-20T19:57:18.757Z' },
      { createdTime: 'pending' }, // one non-ISO value poisons the column
    ];
    expect(timestampColumns(rows, ['createdTime']).has('createdTime')).toBe(false);
  });

  it('ignores empty/null values when deciding, but needs at least one present ISO value', () => {
    const rows = [
      { createdTime: '2026-08-20T19:57:18.757Z' },
      { createdTime: null },
      { createdTime: '' },
    ];
    expect(timestampColumns(rows, ['createdTime']).has('createdTime')).toBe(true);

    const allEmpty = [{ createdTime: null }, { createdTime: '' }];
    expect(timestampColumns(allEmpty, ['createdTime']).has('createdTime')).toBe(false);
  });
});
