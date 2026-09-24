import { TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { of, throwError } from 'rxjs';
import { KpiStatusFooterComponent } from './kpi-status-footer';
import { KpiHealthService, type KpiHealth } from './services/kpi-health.service';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

function health(over: Partial<KpiHealth>): KpiHealth {
  return { name: 'K', label: 'K', value: null, threshold: null, issues: null, ...over };
}
const threshold = (status: 'ok' | 'watching' | 'warning', statusColor: string): KpiHealth['threshold'] => ({
  target: 20, bands: [], status, statusColor,
});
const raised = (total: number): KpiHealth['issues'] =>
  ({ baseObject: 'ProductInventory', total, bySeverity: [{ severity: 3, count: total }] });

describe('KpiStatusFooterComponent', () => {
  let svc: { getKpiHealth: ReturnType<typeof vi.fn> };
  let bridge: { openIssuesForKpi: ReturnType<typeof vi.fn> };

  function mount(name = 'K') {
    const fixture = TestBed.createComponent(KpiStatusFooterComponent);
    (fixture.componentRef as ComponentRef<KpiStatusFooterComponent>).setInput('kpiName', name);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    svc = { getKpiHealth: vi.fn() };
    bridge = { openIssuesForKpi: vi.fn() };
    TestBed.configureTestingModule({
      imports: [KpiStatusFooterComponent],
      providers: [
        { provide: KpiHealthService, useValue: svc },
        { provide: WorkbenchBridgeService, useValue: bridge },
      ],
    });
  });

  it('renders NOTHING when the health read fails — the tile is undisturbed (Decision B-2)', () => {
    svc.getKpiHealth.mockReturnValue(throwError(() => new Error('boom')));
    expect(mount().nativeElement.querySelector('[data-testid="kpi-status-footer"]')).toBeNull();
  });

  it('renders NOTHING when neither threshold nor issues are present (nothing to say)', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: null, issues: null })));
    expect(mount().nativeElement.querySelector('[data-testid="kpi-status-footer"]')).toBeNull();
  });

  // The footer is present on EVERY KPI tile that has a threshold — not only ones with issues —
  // so every tile shows its state (the header chip only appeared on problem tiles).
  it('shows "On track" with the ok status colour when the threshold is ok', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73'), issues: null })));
    const el: HTMLElement = mount().nativeElement;
    expect(el.querySelector('[data-testid="kpi-status-footer"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="status-label"]')?.textContent?.trim()).toBe('On track');
    const dot = el.querySelector('[data-testid="status-dot"]') as HTMLElement;
    expect(dot.style.backgroundColor).toBe('rgb(0, 158, 115)'); // #009E73
  });

  it('shows "Watching" for a watching threshold', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('watching', '#E69F00'), issues: null })));
    expect(mount().nativeElement.querySelector('[data-testid="status-label"]')?.textContent?.trim()).toBe('Watching');
  });

  it('shows "Warning" for a warning threshold', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('warning', '#D55E00'), issues: null })));
    expect(mount().nativeElement.querySelector('[data-testid="status-label"]')?.textContent?.trim()).toBe('Warning');
  });

  it('summarises raised issues (count + pluralised) with an accessible title', () => {
    svc.getKpiHealth.mockReturnValue(of(health({
      threshold: threshold('watching', '#E69F00'),
      issues: { baseObject: 'X', total: 3, bySeverity: [{ severity: 1, count: 2 }, { severity: 2, count: 1 }] },
    })));
    const el: HTMLElement = mount().nativeElement;
    const issues = el.querySelector('[data-testid="footer-issues"]') as HTMLElement;
    expect(issues.textContent).toContain('3 issues');
    expect(issues.getAttribute('title')).toContain('3');
  });

  it('says "1 issue" (singular) for exactly one raised issue', () => {
    svc.getKpiHealth.mockReturnValue(of(health({
      threshold: threshold('warning', '#D55E00'),
      issues: { baseObject: 'X', total: 1, bySeverity: [{ severity: 1, count: 1 }] },
    })));
    expect(mount().nativeElement.querySelector('[data-testid="footer-issues"]')?.textContent).toContain('1 issue');
  });

  it('says "No issues" when the issue count is zero', () => {
    svc.getKpiHealth.mockReturnValue(of(health({
      threshold: threshold('ok', '#009E73'),
      issues: { baseObject: 'X', total: 0, bySeverity: [] },
    })));
    expect(mount().nativeElement.querySelector('[data-testid="footer-issues"]')?.textContent?.trim()).toBe('No issues');
  });

  it('says "issues unavailable" when the issue read degraded', () => {
    svc.getKpiHealth.mockReturnValue(of(health({
      threshold: threshold('ok', '#009E73'),
      issues: { baseObject: 'X', unavailable: true },
    })));
    expect(mount().nativeElement.querySelector('[data-testid="footer-issues"]')?.textContent?.trim()).toBe('issues unavailable');
  });

  it('shows the status when issues are null (non-issue KPI): footer present, summary reads "Issues not tracked" (Fix 2)', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73'), issues: null })));
    const el: HTMLElement = mount().nativeElement;
    expect(el.querySelector('[data-testid="kpi-status-footer"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="footer-issues"]')?.textContent?.trim()).toBe('Issues not tracked');
  });

  it('shows a muted "Issues not tracked" when issues are null but a threshold is present (Fix 2)', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73'), issues: null })));
    const el: HTMLElement = mount().nativeElement;
    const issues = el.querySelector('[data-testid="footer-issues"]') as HTMLElement;
    expect(issues).not.toBeNull();
    expect(issues.textContent?.trim()).toBe('Issues not tracked');
    // muted, NOT the raised warn/pill tone
    expect(issues.classList.contains('ksf__issues--raised')).toBe(false);
    expect(issues.querySelector('.ksf__warn')).toBeNull();
  });

  it('fetches for the given KPI name', () => {
    svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73') })));
    mount('Fill Rate');
    expect(svc.getKpiHealth).toHaveBeenCalledWith('Fill Rate');
  });

  // B-IMPL-01: the grid tracks tiles by id and updateTile keeps the id, so editing a tile's
  // KPI in place mutates kpiName WITHOUT a remount. The footer must re-fetch for the new name
  // (like the chart beside it), not stay on the first-mount name.
  it('re-fetches and re-renders when the KPI name changes in place (no remount)', () => {
    svc.getKpiHealth.mockImplementation((name: string) =>
      of(health({
        label: name,
        threshold: threshold(name === 'On Hand' ? 'warning' : 'ok', name === 'On Hand' ? '#D55E00' : '#009E73'),
      })));
    const fixture = mount('Fill Rate');
    expect(svc.getKpiHealth).toHaveBeenCalledWith('Fill Rate');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="status-label"]')?.textContent?.trim()).toBe('On track');

    (fixture.componentRef as ComponentRef<KpiStatusFooterComponent>).setInput('kpiName', 'On Hand');
    fixture.detectChanges();

    expect(svc.getKpiHealth.mock.calls.map((c) => c[0])).toEqual(['Fill Rate', 'On Hand']);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="status-label"]')?.textContent?.trim()).toBe('Warning');
  });

  // Fix 1: a click on the footer should EXPAND the tile like the chart body above it, so a
  // footer with NO raised issues must NOT carry data-no-expand and must hold no interactive
  // controls the shared isInteractiveTarget guard would treat as click-owners. (A RAISED footer
  // gains exactly one interactive child — the issues button — asserted separately below.)
  it('does not opt out of expand: no data-no-expand, and no interactive children when not raised (Fix 1)', () => {
    svc.getKpiHealth.mockReturnValue(of(health({
      threshold: threshold('warning', '#D55E00'),
      issues: { baseObject: 'X', total: 0, bySeverity: [] }, // tracked, none raised → muted span
    })));
    const footer = mount().nativeElement.querySelector('[data-testid="kpi-status-footer"]') as HTMLElement;
    expect(footer.hasAttribute('data-no-expand')).toBe(false);
    // no button/a/input/select/textarea/[role=button] inside — a footer click reaches onBodyClick
    expect(footer.querySelector('button, a, input, select, textarea, [role="button"]')).toBeNull();
  });

  describe('issue affordance (SC-2663 drill-down)', () => {
    it('A: a raised tile renders footer-issues as a <button>; clicking calls openIssuesForKpi(kpiName)', () => {
      svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('warning', '#D55E00'), issues: raised(3) })));
      const el: HTMLElement = mount('WBTotalQuantity').nativeElement;
      const btn = el.querySelector('[data-testid="footer-issues"]') as HTMLElement;
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.textContent).toContain('3 issues');
      expect(btn.getAttribute('aria-label')).toContain('WBTotalQuantity');
      btn.click();
      expect(bridge.openIssuesForKpi).toHaveBeenCalledWith('WBTotalQuantity');
      expect(bridge.openIssuesForKpi).toHaveBeenCalledTimes(1);
    });

    it('the raised button is the ONLY interactive child; the rest of the footer still expands', () => {
      svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('warning', '#D55E00'), issues: raised(2) })));
      const footer = mount().nativeElement.querySelector('[data-testid="kpi-status-footer"]') as HTMLElement;
      const interactive = footer.querySelectorAll('button, a, input, select, textarea, [role="button"]');
      expect(interactive.length).toBe(1);
      expect((interactive[0] as HTMLElement).getAttribute('data-testid')).toBe('footer-issues');
    });

    it('C1: a tracked-but-zero tile (total:0) renders a <span>, not a button — no dead click', () => {
      svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73'), issues: { baseObject: 'X', total: 0, bySeverity: [] } })));
      const node = mount().nativeElement.querySelector('[data-testid="footer-issues"]') as HTMLElement;
      expect(node.tagName).toBe('SPAN');
      node.click();
      expect(bridge.openIssuesForKpi).not.toHaveBeenCalled();
    });

    it('C2: an untracked tile (issues:null) renders a <span>, not a button', () => {
      svc.getKpiHealth.mockReturnValue(of(health({ threshold: threshold('ok', '#009E73'), issues: null })));
      const node = mount().nativeElement.querySelector('[data-testid="footer-issues"]') as HTMLElement;
      expect(node.tagName).toBe('SPAN');
    });
  });
});
