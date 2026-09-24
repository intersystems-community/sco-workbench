import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { IssueManagementComponent, SNAPSHOT_ROW_CAP } from './issue-management';
import { IssueService, type IssueCounts, type IssueDetail, type IssueRow } from '../services/issue.service';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

/**
 * What the AI assistant is told about the Issue Management page. The assistant only
 * ever sees `bridge.getContextSnapshot()`, so every assertion goes through it rather
 * than through the component's own fields.
 *
 * Weighted to the cases that would make the assistant lie: a failed count load must
 * not read as "no issues", and a capped row list must say it was capped.
 */
const COUNTS: IssueCounts = {
  total: 12,
  byKpi: { LateDelivery: 9, StockOut: 3 },
  bySeverity: { High: 4, Medium: 6, Low: 0 },
  workQueue: 2,
};

function row(over: Partial<IssueRow> = {}): IssueRow {
  return {
    uid: 'g-1',
    description: 'Sales order 42 is late',
    kpi: 'LateDelivery',
    severity: 'High',
    urgency: null,
    status: 'Open',
    created: '2026-09-01 10:00:00',
    impactedObjectType: 'SalesOrder',
    impactedObjectId: 'SO-42',
    ...over,
  };
}

function setup(opts: { counts?: unknown; rows?: IssueRow[]; issue?: IssueDetail } = {}) {
  const rows = opts.rows ?? [row()];
  const service = {
    counts: vi.fn(() => (opts.counts === 'error' ? throwError(() => new Error('nope')) : of({ counts: COUNTS }))),
    list: vi.fn(() => of({ issues: rows, totalCount: rows.length, truncated: false, cap: 1000 })),
    get: vi.fn(() => of({ issue: opts.issue ?? { ...row(), triggerType: 'KPI', issueData: '{"shortfall":40}', resolutionNote: null, latestAnalysis: null } })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [IssueManagementComponent],
    providers: [{ provide: IssueService, useValue: service }],
  });
  const bridge = TestBed.inject(WorkbenchBridgeService);
  bridge.activeView.set('issue-management');
  const fixture = TestBed.createComponent(IssueManagementComponent);
  fixture.detectChanges();
  return { fixture, bridge, component: fixture.componentInstance, rows };
}

describe('Issue Management assistant context', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('registers the page, so the assistant sees the counts before anything is selected', () => {
    const { bridge } = setup();
    const snap = bridge.getContextSnapshot();
    expect(snap).toContain('page: issue-management');
    expect(snap).toContain('activeForm: issue-management');
    expect(snap).toContain('totalIssues: 12');
    expect(snap).toContain('"High":4');
    expect(snap).toContain('workQueueIssues: 2');
    expect(snap).toContain('no category selected');
  });

  it('a failed count load is reported, never rendered as zero issues', () => {
    // Silently omitting the counts would let the assistant answer "there are no
    // issues" when the truth is that it could not read them.
    const { bridge } = setup({ counts: 'error' });
    const snap = bridge.getContextSnapshot();
    expect(snap).not.toContain('totalIssues');
    expect(snap).toMatch(/navCounts: .+/);
  });

  it('a selected category puts the visible rows in the snapshot', () => {
    const { bridge, component, fixture } = setup();
    component.selectCategory({ group: 'severity', value: 'High', label: 'High' });
    fixture.detectChanges();
    const snap = bridge.getContextSnapshot();
    expect(snap).toContain('selectedCategory: By Severity — High');
    expect(snap).toContain('matchingIssues: 1');
    expect(snap).toContain('Sales order 42 is late');
    expect(snap).toContain('SO-42');
  });

  it('caps the row list and says how many rows it left out', () => {
    // The snapshot is sent with every turn and a category holds up to 1000 rows.
    const rows = Array.from({ length: SNAPSHOT_ROW_CAP + 5 }, (_, i) =>
      row({ uid: `g-${i}`, description: `issue number ${i}` }),
    );
    const { bridge, component, fixture } = setup({ rows });
    component.selectCategory({ group: 'severity', value: 'High', label: 'High' });
    fixture.detectChanges();
    const snap = bridge.getContextSnapshot();
    expect(snap).toContain(`issue number ${SNAPSHOT_ROW_CAP - 1}`);
    expect(snap).not.toContain(`issue number ${SNAPSHOT_ROW_CAP}`);
    expect(snap).toContain(`only the first ${SNAPSHOT_ROW_CAP} of ${rows.length} rows`);
  });

  it('an open issue replaces the list with that issue’s detail', () => {
    const { bridge, component, fixture } = setup();
    component.selectCategory({ group: 'kpi', value: 'LateDelivery', label: 'LateDelivery' });
    fixture.detectChanges();
    component.selectIssue(row());
    fixture.detectChanges();
    const snap = bridge.getContextSnapshot();
    expect(snap).toContain('viewing one issue');
    expect(snap).toContain('openIssue: ');
    expect(snap).toContain('shortfall'); // the analysis payload, JSON-escaped inside the row
    expect(snap).not.toContain('visibleIssues');
    // The counts stay available, so "how many High issues are there" still answers.
    expect(snap).toContain('totalIssues: 12');
  });

  it('leaving the page unregisters it, so the assistant is not told a stale screen', () => {
    const { bridge, fixture } = setup();
    fixture.destroy();
    expect(bridge.getContextSnapshot()).toContain('activeForm: (none open)');
  });

  it('the page reports it has no form rather than silently accepting a set_field', async () => {
    const { bridge } = setup();
    const res = await bridge.applyDirective({ action: 'set_field', target: 'description', value: 'x' });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/no editable form/i);
  });
});
