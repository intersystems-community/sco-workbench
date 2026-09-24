/**
 * Read model for the Issue Management page. Weighted to the cases that bite:
 * absent values arriving as '' from the SQL path (Number('') is 0, which would
 * band an unset severity as "Low"), bands that must become integer RANGE filters,
 * and categories that must be REJECTED rather than passed to SCO — which ignores
 * filters it doesn't recognize and would return every issue.
 */
import { describe, it, expect } from 'vitest';
import {
  bandFilter,
  bandOf,
  categoryFilters,
  foldCounts,
  parseBand,
  toIssueDetail,
  toIssueRow,
  type IssueCountRow,
} from '../../src/issues/issue-list.js';
import { ValidationError } from '../../src/iris/iris-error.js';

describe('bandOf', () => {
  it('treats an absent value as unbanded — NOT as Low', () => {
    // SCO omits empty values from JSON; the Atelier SQL path returns ''.
    expect(bandOf(undefined)).toBeNull();
    expect(bandOf(null)).toBeNull();
    expect(bandOf('')).toBeNull();
    expect(bandOf('   ')).toBeNull();
  });

  it('bands 0 as Low but keeps it distinct from absent', () => {
    expect(bandOf(0)).toBe('Low');
    expect(bandOf('0')).toBe('Low');
  });

  it('severity is an OPEN integer — anything at or above 3 is High', () => {
    expect(bandOf(3)).toBe('High');
    expect(bandOf(9)).toBe('High');
    expect(bandOf(1000)).toBe('High');
    expect(bandOf(2)).toBe('Medium');
    expect(bandOf(-4)).toBe('Low');
  });

  it('numeric strings band; junk does not', () => {
    expect(bandOf('2')).toBe('Medium');
    expect(bandOf('high')).toBeNull();
    expect(bandOf(Number.NaN)).toBeNull();
    expect(bandOf({})).toBeNull();
  });
});

describe('bandFilter', () => {
  it('maps a band to SCO range syntax, open at the ends', () => {
    expect(bandFilter('High')).toBe('3..');
    expect(bandFilter('Medium')).toBe('2..2');
    expect(bandFilter('Low')).toBe('..1');
  });
});

describe('parseBand', () => {
  it('accepts any casing', () => {
    expect(parseBand('high')).toBe('High');
    expect(parseBand('MEDIUM')).toBe('Medium');
  });

  it('rejects an unknown band instead of returning a silently-empty list', () => {
    expect(() => parseBand('Critical')).toThrow(ValidationError);
    expect(() => parseBand('')).toThrow(ValidationError);
  });
});

describe('categoryFilters', () => {
  it('a KPI category pins triggerType as well as the name', () => {
    // triggerObjectId alone would also match a BPL/API issue that happens to
    // carry the same id.
    expect(categoryFilters('kpi', 'LateDelivery')).toEqual({
      triggerType: 'KPI',
      triggerObjectId: 'LateDelivery',
    });
  });

  it('severity becomes a range filter', () => {
    expect(categoryFilters('severity', 'High')).toEqual({ severity: '3..' });
    expect(categoryFilters('severity', 'Low')).toEqual({ severity: '..1' });
  });

  it('urgency is NOT a category — the page does not slice by it', () => {
    // The row still shows an urgency badge, but there is no urgency nav group, so
    // the group must be rejected rather than reaching SCO as a real filter.
    expect(() => categoryFilters('urgency', 'High')).toThrow(ValidationError);
  });

  it('the work queue is the workflow status, ignoring the value', () => {
    expect(categoryFilters('workqueue', 'all')).toEqual({ status: 'workflow' });
    expect(categoryFilters('workqueue', '')).toEqual({ status: 'workflow' });
  });

  it('rejects an unknown group, an empty group and a KPI with no name', () => {
    expect(() => categoryFilters('status', 'open')).toThrow(ValidationError);
    expect(() => categoryFilters('', '')).toThrow(ValidationError);
    expect(() => categoryFilters('kpi', '')).toThrow(ValidationError);
  });

  it('does not let a raw SCO attribute name through as a group', () => {
    expect(() => categoryFilters('triggerObjectId', 'LateDelivery')).toThrow(ValidationError);
  });
});

describe('toIssueRow', () => {
  it('maps the SCO fields the page shows', () => {
    expect(
      toIssueRow({
        uid: 'g-1',
        description: 'Order is late',
        triggerType: 'KPI',
        triggerObjectId: 'LateDelivery',
        severity: 3,
        urgency: 2,
        status: 'open',
        recordCreatedTime: '2026-09-01 10:00:00',
        impactedObjectType: 'SalesOrder',
        impactedObjectId: 'SO-9',
      }),
    ).toEqual({
      uid: 'g-1',
      description: 'Order is late',
      kpi: 'LateDelivery',
      severity: 'High',
      urgency: 'Medium',
      status: 'Open',
      created: '2026-09-01 10:00:00',
      impactedObjectType: 'SalesOrder',
      impactedObjectId: 'SO-9',
    });
  });

  it('a non-KPI trigger reports no KPI even when triggerObjectId is set', () => {
    const row = toIssueRow({ triggerType: 'BPL', triggerObjectId: 'SomeProcess' });
    expect(row.kpi).toBeNull();
  });

  it('an all-empty record maps to a renderable row, not to undefined fields', () => {
    // Every SCO field is omitted when empty, so this is the shape an unanalyzed
    // issue imported through the API can really have.
    expect(toIssueRow({})).toEqual({
      uid: '',
      description: '',
      kpi: null,
      severity: null,
      urgency: null,
      status: 'Unknown',
      created: null,
      impactedObjectType: null,
      impactedObjectId: null,
    });
  });

  it('an unrecognized status is shown as SCO reports it, not swallowed', () => {
    expect(toIssueRow({ status: 'reopened' }).status).toBe('reopened');
  });
});

describe('toIssueDetail', () => {
  it('carries the detail-only fields and keeps latestAnalysis only when it is an object', () => {
    const detail = toIssueDetail({
      uid: 'g-2',
      status: 'closed',
      issueData: '{"shortfall":40}',
      resolutionNote: 'Expedited',
      triggerType: 'KPI',
      latestAnalysis: { status: 'completed' },
    });
    expect(detail.status).toBe('Closed');
    expect(detail.issueData).toBe('{"shortfall":40}');
    expect(detail.resolutionNote).toBe('Expedited');
    expect(detail.latestAnalysis).toEqual({ status: 'completed' });
  });

  it('absent detail fields are null, and a non-object latestAnalysis is dropped', () => {
    const detail = toIssueDetail({ latestAnalysis: 'nope' as unknown as Record<string, unknown> });
    expect(detail.issueData).toBeNull();
    expect(detail.resolutionNote).toBeNull();
    expect(detail.triggerType).toBeNull();
    expect(detail.latestAnalysis).toBeNull();
  });
});

describe('foldCounts', () => {
  const row = (over: Partial<IssueCountRow>): IssueCountRow => ({
    triggerType: 'KPI',
    triggerObjectId: 'LateDelivery',
    severity: 2,
    status: 'open',
    count: 1,
    ...over,
  });

  it('one issue lands in several dimensions, so only total sums the rows', () => {
    const counts = foldCounts([row({ count: 5 }), row({ severity: 3, count: 2 })]);
    expect(counts.total).toBe(7);
    expect(counts.byKpi).toEqual({ LateDelivery: 7 });
    expect(counts.bySeverity).toEqual({ High: 2, Medium: 5, Low: 0 });
  });

  it('an unset severity counts in NO severity band (SQL hands it back as \'\')', () => {
    const counts = foldCounts([row({ severity: '', count: 12 }), row({ severity: null, count: 3 })]);
    expect(counts.bySeverity).toEqual({ High: 0, Medium: 0, Low: 0 });
    expect(counts.total).toBe(15);
  });

  it('counts arriving as strings from SQL are added, not concatenated', () => {
    const counts = foldCounts([row({ count: '641' }), row({ count: '8281' })]);
    expect(counts.total).toBe(8922);
  });

  it('only the workflow status feeds the work queue', () => {
    const counts = foldCounts([
      row({ status: 'open', count: 4 }),
      row({ status: 'workflow', count: 3 }),
      row({ status: 'closed', count: 2 }),
    ]);
    expect(counts.workQueue).toBe(3);
    expect(counts.total).toBe(9);
  });

  it('a non-KPI trigger adds no KPI bucket, and an empty KPI name is not a bucket', () => {
    const counts = foldCounts([
      row({ triggerType: 'externalEvent', triggerObjectId: 'Storm', count: 2 }),
      row({ triggerType: 'KPI', triggerObjectId: '', count: 3 }),
    ]);
    expect(counts.byKpi).toEqual({});
    expect(counts.total).toBe(5);
  });

  it('junk or non-positive counts are skipped rather than corrupting the total', () => {
    const counts = foldCounts([row({ count: 'abc' }), row({ count: 0 }), row({ count: -3 })]);
    expect(counts.total).toBe(0);
    expect(counts.bySeverity.Medium).toBe(0);
  });

  it('no rows → every badge is zero, never undefined', () => {
    expect(foldCounts([])).toEqual({
      total: 0,
      byKpi: {},
      bySeverity: { High: 0, Medium: 0, Low: 0 },
      workQueue: 0,
    });
  });
});
