import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { IssueManagementComponent } from './issue-management';
import { IssueService, type IssueCounts, type IssueRow } from '../services/issue.service';
import { WorkbenchBridgeService, type GuidedFormController } from '../core/workbench-bridge.service';

const COUNTS: IssueCounts = {
  total: 12,
  byKpi: { LateDelivery: 9, StockOut: 3 },
  bySeverity: { High: 4, Medium: 6, Low: 0 },
  workQueue: 2,
};

function row(over: Partial<IssueRow> = {}): IssueRow {
  return {
    uid: 'g-1',
    description: 'late',
    kpi: 'LateDelivery',
    severity: 'High',
    urgency: null,
    status: 'Open',
    created: null,
    impactedObjectType: 'SalesOrder',
    impactedObjectId: 'SO-1',
    ...over,
  };
}

function setup(rows: IssueRow[] = [row()]) {
  const service = {
    counts: vi.fn(() => of({ counts: COUNTS })),
    list: vi.fn(() => of({ issues: rows, totalCount: rows.length, truncated: false, cap: 1000 })),
    get: vi.fn(() => of({ issue: { ...row() } })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [IssueManagementComponent],
    providers: [{ provide: IssueService, useValue: service }],
  });
  const bridge = TestBed.inject(WorkbenchBridgeService);
  bridge.activeView.set('issue-management');
  const fixture = TestBed.createComponent(IssueManagementComponent);
  fixture.detectChanges(); // ngOnInit → counts() resolves synchronously (of()) → countsReady resolves
  const controller = fixture.componentInstance['guidedController'] as GuidedFormController;
  return { fixture, component: fixture.componentInstance, service, controller };
}

describe('IssueManagementComponent.openEntity (KPI deep-link)', () => {
  it('B: selects the KPI slice after counts settle', async () => {
    const { component, service, controller } = setup();
    const res = await controller.openEntity!('LateDelivery');
    expect(res.applied).toBe(true);
    expect(component.selectedCategory()).toEqual({ group: 'kpi', value: 'LateDelivery', label: 'LateDelivery' });
    expect(service.list).toHaveBeenCalledWith('kpi', 'LateDelivery');
  });

  it('C: an unknown KPI (absent from byKpi) still selects and does not throw', async () => {
    const { component, service, controller } = setup([]); // list returns empty for the unknown slice
    const res = await controller.openEntity!('GhostKpi');
    expect(res.applied).toBe(true);
    expect(component.selectedCategory()).toEqual({ group: 'kpi', value: 'GhostKpi', label: 'GhostKpi' });
    expect(service.list).toHaveBeenCalledWith('kpi', 'GhostKpi'); // lands on the (empty) list, not the intro
  });

  it('rejects an empty / whitespace name without selecting', async () => {
    const { component, service, controller } = setup();
    const res = await controller.openEntity!('   ');
    expect(res.applied).toBe(false);
    expect(component.selectedCategory()).toBeNull();
    expect(service.list).not.toHaveBeenCalled();
  });

  // SC-2663 Bug 2: on the 7.5M-issue instance, counts() aggregation is slow. The deep-link
  // used to await countsReady BEFORE selecting the category, so the user stared at the intro
  // with no feedback for the whole delay. selectCategory (which shows the "By KPI — <kpi>"
  // header + the loading spinner and kicks off the list fetch) must now fire IMMEDIATELY,
  // before counts settle.
  it('D (Bug 2): selects the KPI slice IMMEDIATELY, before the slow counts() settles', async () => {
    const countsSubject = new Subject<{ counts: IssueCounts }>();
    const service = {
      counts: vi.fn(() => countsSubject), // never resolves during this test
      list: vi.fn(() => of({ issues: [row()], totalCount: 1, truncated: false, cap: 1000 })),
      get: vi.fn(() => of({ issue: { ...row() } })),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [IssueManagementComponent],
      providers: [{ provide: IssueService, useValue: service }],
    });
    const bridge = TestBed.inject(WorkbenchBridgeService);
    bridge.activeView.set('issue-management');
    const fixture = TestBed.createComponent(IssueManagementComponent);
    fixture.detectChanges(); // ngOnInit — counts() is pending (Subject not yet next-ed)
    const controller = fixture.componentInstance['guidedController'] as GuidedFormController;

    void controller.openEntity!('LateDelivery'); // do NOT await — counts still pending

    // The category + list fetch happened synchronously, without waiting on counts.
    expect(fixture.componentInstance.selectedCategory())
      .toEqual({ group: 'kpi', value: 'LateDelivery', label: 'LateDelivery' });
    expect(service.list).toHaveBeenCalledWith('kpi', 'LateDelivery');
  });
});

/**
 * Refresh keeps the user where they were. This page's "item" is two levels — the
 * category slice plus, optionally, the one issue open inside it — so its `?item=`
 * token carries both and must survive a round trip through the URL.
 */
describe('IssueManagementComponent — `?item=` deep link', () => {
  it('reports no item on the intro, the category once one is picked, and the issue on top of it', () => {
    const { component, controller } = setup();
    expect(controller.currentItem!()).toBeNull();

    component.selectCategory({ group: 'kpi', value: 'LateDelivery', label: 'LateDelivery' });
    expect(controller.currentItem!()).toBe('kpi|LateDelivery');

    component.selectIssue(row());
    expect(controller.currentItem!()).toBe('kpi|LateDelivery|#g-1');
  });

  it('round-trips its own token: restoring puts the same category and issue back', async () => {
    const { component, controller, service } = setup([row({ uid: 'g-7' })]);

    expect(await controller.restoreItem!('kpi|LateDelivery|#g-7')).toBe(true);

    expect(component.selectedCategory()).toEqual({ group: 'kpi', value: 'LateDelivery', label: 'LateDelivery' });
    expect(service.list).toHaveBeenCalledWith('kpi', 'LateDelivery');
    expect(service.get).toHaveBeenCalledWith('g-7');
    expect(component.selectedIssue()?.uid).toBe('g-1'); // whatever SCO returned for that uid
    expect(component.loadingIssue()).toBe(false);
  });

  it('uses the nav`s own label — the Work Queue entry is not called "all"', async () => {
    const { component, controller } = setup();

    expect(await controller.restoreItem!('workqueue|all')).toBe(true);

    expect(component.selectedCategory()).toEqual({ group: 'workqueue', value: 'all', label: 'Pending Actions' });
  });

  it('keeps the category when the issue is gone — a stale uid is not a failed restore', async () => {
    const service = {
      counts: vi.fn(() => of({ counts: COUNTS })),
      list: vi.fn(() => of({ issues: [], totalCount: 0, truncated: false, cap: 1000 })),
      get: vi.fn(() => throwError(() => new Error('404'))),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [IssueManagementComponent],
      providers: [{ provide: IssueService, useValue: service }],
    });
    const fixture = TestBed.createComponent(IssueManagementComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const controller = component['guidedController'] as GuidedFormController;

    expect(await controller.restoreItem!('severity|High|#deleted')).toBe(true);

    expect(component.selectedCategory()?.value).toBe('High');
    expect(component.selectedIssue()).toBeNull();
    expect(component.loadingIssue()).toBe(false);
    // …and the token the page now reports has dropped the dead uid, so the URL follows.
    expect(controller.currentItem!()).toBe('severity|High');
  });

  it('refuses a token it cannot read, rather than querying SCO for nonsense', async () => {
    const { component, controller, service } = setup();

    expect(await controller.restoreItem!('notagroup|High')).toBe(false);
    expect(await controller.restoreItem!('kpi')).toBe(false);
    expect(await controller.restoreItem!('kpi|')).toBe(false);

    expect(service.list).not.toHaveBeenCalled();
    expect(component.selectedCategory()).toBeNull();
  });

  it('reads a category value that contains the token separator', async () => {
    const { component, controller } = setup();

    expect(await controller.restoreItem!('kpi|Late|Delivery|#g-7')).toBe(true);

    expect(component.selectedCategory()?.value).toBe('Late|Delivery');
  });
});
