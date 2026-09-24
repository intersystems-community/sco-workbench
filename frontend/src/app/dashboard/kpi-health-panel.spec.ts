import { TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { of, throwError, Subject } from 'rxjs';
import { KpiHealthPanelComponent } from './kpi-health-panel';
import { KpiHealthService, type KpiHealth } from './services/kpi-health.service';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

function health(over: Partial<KpiHealth>): KpiHealth {
  return { name: 'K', label: 'K', value: null, threshold: null, issues: null, ...over };
}
const threshold = (status: 'ok' | 'watching' | 'warning', statusColor: string): KpiHealth['threshold'] => ({
  target: 20, bands: [{ to: null, kind: 'ok', color: '#009E73' }], status, statusColor,
});

describe('KpiHealthPanelComponent', () => {
  let svc: { getKpiHealth: ReturnType<typeof vi.fn>; getKpiHealthShared: ReturnType<typeof vi.fn> };
  let bridge: { openIssuesForKpi: ReturnType<typeof vi.fn> };

  function mount(name = 'K') {
    const fixture = TestBed.createComponent(KpiHealthPanelComponent);
    (fixture.componentRef as ComponentRef<KpiHealthPanelComponent>).setInput('kpiName', name);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    svc = { getKpiHealth: vi.fn(), getKpiHealthShared: vi.fn() };
    bridge = { openIssuesForKpi: vi.fn() };
    TestBed.configureTestingModule({
      imports: [KpiHealthPanelComponent],
      providers: [
        { provide: KpiHealthService, useValue: svc },
        { provide: WorkbenchBridgeService, useValue: bridge },
      ],
    });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('fetches for the given KPI name', () => {
    svc.getKpiHealthShared.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73') })));
    mount('Fill Rate');
    expect(svc.getKpiHealthShared).toHaveBeenCalledWith('Fill Rate');
  });

  it('subscribes via getKpiHealthShared (so a prefetched envelope is consumed), not getKpiHealth', () => {
    svc.getKpiHealthShared.mockReturnValue(of(health({ value: 9, threshold: threshold('ok', '#009E73') })));
    mount('On Hand');
    expect(svc.getKpiHealthShared).toHaveBeenCalledWith('On Hand');
    expect(svc.getKpiHealth).not.toHaveBeenCalled();
  });

  it('renders the rich health view with the fetched envelope (value in status colour)', () => {
    svc.getKpiHealthShared.mockReturnValue(of(health({ value: 7, threshold: threshold('watching', '#E69F00') })));
    const el: HTMLElement = mount().nativeElement;
    expect(el.querySelector('app-kpi-health-view')).toBeTruthy();
    expect(el.querySelector('[data-testid="health-value"]')?.textContent).toContain('7');
  });

  it('renders nothing when the health read fails (silent degrade — the enlarged chart is undisturbed)', () => {
    svc.getKpiHealthShared.mockReturnValue(throwError(() => new Error('boom')));
    const el: HTMLElement = mount().nativeElement;
    expect(el.querySelector('[data-testid="health-value"]')).toBeNull();
    expect(el.querySelector('[data-testid="band-strip"]')).toBeNull();
  });

  it('re-fetches and re-renders when the KPI name changes in place (no remount)', () => {
    svc.getKpiHealthShared.mockImplementation((name: string) =>
      of(health({ value: name === 'On Hand' ? 3 : 7, threshold: threshold('ok', '#009E73') })));
    const fixture = mount('Fill Rate');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="health-value"]')?.textContent).toContain('7');
    (fixture.componentRef as ComponentRef<KpiHealthPanelComponent>).setInput('kpiName', 'On Hand');
    fixture.detectChanges();
    expect(svc.getKpiHealthShared.mock.calls.map((c) => c[0])).toEqual(['Fill Rate', 'On Hand']);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="health-value"]')?.textContent).toContain('3');
  });

  it('drops a superseded (out-of-order) response so a slow earlier read cannot clobber a fast later one', () => {
    const first = new Subject<KpiHealth>();
    const second = new Subject<KpiHealth>();
    svc.getKpiHealthShared.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const fixture = mount('Fill Rate');            // subscribes to `first`
    (fixture.componentRef as ComponentRef<KpiHealthPanelComponent>).setInput('kpiName', 'On Hand'); // subscribes to `second`
    fixture.detectChanges();
    second.next(health({ value: 3, threshold: threshold('ok', '#009E73') })); // later name resolves first
    first.next(health({ value: 7, threshold: threshold('warning', '#D55E00') })); // earlier name resolves late — must be dropped
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="health-value"]')?.textContent).toContain('3');
  });

  // SC-2663 Bug 1: the overlay's health view now surfaces a drill-down button on raised
  // issues; the panel wires that to the bridge so a click opens the KPI-scoped Issue list
  // (mirrors kpi-status-footer). The button also stops the overlay closing, since it is an
  // interactive target the shared guard recognizes.
  it('opens the KPI-scoped Issue list when the raised drill-down button is clicked (SC-2663)', () => {
    svc.getKpiHealthShared.mockReturnValue(of(health({
      threshold: threshold('warning', '#D55E00'),
      issues: { baseObject: 'X', total: 2, bySeverity: [{ severity: 3, count: 2 }] },
    })));
    const el: HTMLElement = mount('WBTotalQuantity').nativeElement;
    const btn = el.querySelector<HTMLElement>('[data-testid="issues-open"]')!;
    expect(btn.tagName).toBe('BUTTON');
    btn.click();
    expect(bridge.openIssuesForKpi).toHaveBeenCalledWith('WBTotalQuantity');
    expect(bridge.openIssuesForKpi).toHaveBeenCalledTimes(1);
  });
});
