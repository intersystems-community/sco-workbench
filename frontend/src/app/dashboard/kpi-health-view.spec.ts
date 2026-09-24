import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { KpiHealthViewComponent } from './kpi-health-view';
import type { KpiHealth } from './services/kpi-health.service';

function setup(health: KpiHealth | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [KpiHealthViewComponent] });
  const fixture: ComponentFixture<KpiHealthViewComponent> = TestBed.createComponent(KpiHealthViewComponent);
  fixture.componentRef.setInput('health', health);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const base: KpiHealth = {
  name: 'Late', label: 'Late Orders', value: 7,
  threshold: { target: 5, bands: [
    { to: 5, kind: 'ok', color: '#009E73' },
    { to: 10, kind: 'watching', color: '#E69F00' },
    { to: null, kind: 'warning', color: '#D55E00' },
  ], status: 'watching', statusColor: '#E69F00' },
  issues: null,
};

describe('KpiHealthViewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the value in its status colour and a band strip with one zone per band', () => {
    const { el } = setup(base);
    const value = el.querySelector<HTMLElement>('[data-testid="health-value"]')!;
    expect(value.textContent).toContain('7');
    expect(value.style.color).toBe('rgb(230, 159, 0)'); // #E69F00
    expect(el.querySelectorAll('[data-testid="band-zone"]').length).toBe(3);
  });

  it('threshold:null → plain value, no band strip (indeterminate polarity degrade)', () => {
    const { el } = setup({ ...base, threshold: null });
    expect(el.querySelector('[data-testid="health-value"]')!.textContent).toContain('7');
    expect(el.querySelector('[data-testid="band-strip"]')).toBeFalsy();
  });

  it('valueUnavailable → band strip still draws, no value marker, a quiet note', () => {
    const { el } = setup({ ...base, value: null, valueUnavailable: true, threshold: { ...base.threshold!, status: null, statusColor: null } });
    expect(el.querySelector('[data-testid="band-strip"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="value-unavailable"]')).toBeTruthy();
  });

  it('issues:null → no issues block', () => {
    expect(setup(base).el.querySelector('[data-testid="issues"]')).toBeFalsy();
  });

  it('issues:null → a muted "Issues not tracked" note (Fix 2)', () => {
    const { el } = setup({ ...base, issues: null });
    const note = el.querySelector('[data-testid="issues-not-tracked"]');
    expect(note).toBeTruthy();
    expect(note!.textContent?.trim()).toBe('Issues not tracked');
    // still no tracked-issues block (that carries data-testid="issues")
    expect(el.querySelector('[data-testid="issues"]')).toBeFalsy();
  });

  it('issues total 0 → "No issues raised" (B-7)', () => {
    const { el } = setup({ ...base, issues: { baseObject: 'X', total: 0, bySeverity: [] } });
    expect(el.querySelector('[data-testid="issues"]')!.textContent).toContain('No issues raised');
  });

  it('issues with counts → total + a chip per severity', () => {
    const { el } = setup({ ...base, issues: { baseObject: 'X', total: 3, bySeverity: [{ severity: 2, count: 2 }, { severity: 3, count: 1 }] } });
    const issues = el.querySelector('[data-testid="issues"]')!;
    expect(issues.textContent).toContain('3');
    expect(issues.querySelectorAll('[data-testid="sev-chip"]').length).toBe(2);
  });

  it('issues unavailable → a quiet "issue count unavailable" marker (B-8)', () => {
    const { el } = setup({ ...base, issues: { baseObject: 'X', unavailable: true } });
    expect(el.querySelector('[data-testid="issues-unavailable"]')).toBeTruthy();
  });

  // SC-2663 Bug 1: in the expand overlay the issue summary was plain spans, so a click
  // fell through to the overlay's close handler ("the tile just zooms out again"). Raised
  // issues now render as a real <button> that emits openIssues, both suppressing the
  // overlay close (the shared isInteractiveTarget guard matches <button>) and giving a
  // drill-down affordance into the KPI-scoped Issue list.
  it('raised issues render as a clickable drill-down button that emits openIssues (SC-2663)', () => {
    const { fixture, el } = setup({ ...base, issues: { baseObject: 'X', total: 3, bySeverity: [{ severity: 3, count: 3 }] } });
    const btn = el.querySelector<HTMLElement>('[data-testid="issues-open"]')!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toContain('3 issues');
    let fired = 0;
    fixture.componentInstance.openIssues.subscribe(() => fired++);
    btn.click();
    expect(fired).toBe(1);
  });

  it('non-raised issue states render NO drill-down button — no dead click (SC-2663)', () => {
    const states: KpiHealth['issues'][] = [
      { baseObject: 'X', total: 0, bySeverity: [] }, // tracked, none raised
      { baseObject: 'X', unavailable: true },        // read degraded
      null,                                          // not tracked
    ];
    for (const issues of states) {
      const { el } = setup({ ...base, issues });
      expect(el.querySelector('[data-testid="issues-open"]')).toBeNull();
    }
  });

  it('renders nothing when health is null', () => {
    expect(setup(null).el.querySelector('[data-testid="health-value"]')).toBeFalsy();
  });

  it('renders a skeleton while health is null (not blank)', () => {
    const fixture = TestBed.createComponent(KpiHealthViewComponent);
    (fixture.componentRef as ComponentRef<KpiHealthViewComponent>).setInput('health', null);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="health-skeleton"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="health-value"]')).toBeNull(); // the loaded view is not shown yet
                                                                         // (key on a testid the skeleton lacks — it shares the `khv` class)
  });

  it('replaces the skeleton with the view once health arrives', () => {
    const fixture = TestBed.createComponent(KpiHealthViewComponent);
    (fixture.componentRef as ComponentRef<KpiHealthViewComponent>).setInput('health', { name: 'K', label: 'K', value: 7, threshold: null, issues: null });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="health-skeleton"]')).toBeNull();
    expect(el.querySelector('[data-testid="health-value"]')?.textContent).toContain('7');
  });
});
