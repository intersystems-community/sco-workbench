import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, type Observable } from 'rxjs';
import { KpiChartBuilderComponent } from './kpi-chart-builder';
import { DashboardChartService, type ChartableKpi } from './services/dashboard-chart.service';
import type { ChartSelection } from './dashboard-config';

@Component({ selector: 'app-chart-builder-preview', standalone: true, template: '<div class="stub-preview"></div>' })
class StubPreview {
  readonly baseSelection = input<ChartSelection | null>(null);
  readonly allowedTypes = input<readonly string[]>([]);
  readonly seedType = input<string | null>(null);
  readonly seedUseAi = input<boolean>(false);
  readonly draftChange = output<ChartSelection>();
  // NOTE: the preview no longer owns `valid` (A3-PLAN-01) — the builder emits its own.
}

const KPIS: ChartableKpi[] = [
  { name: 'OnHand', label: 'On-Hand', dimensions: [{ name: 'quantityStatus', label: 'Status' }] },
];

function setup(kpisObs: Observable<{ kpis: ChartableKpi[] }> = of({ kpis: KPIS })) {
  TestBed.resetTestingModule();
  const getKpis = vi.fn(() => kpisObs);
  const getChartableCubes = vi.fn(() => of({ cubes: [] }));
  TestBed.configureTestingModule({
    imports: [KpiChartBuilderComponent],
    providers: [{ provide: DashboardChartService, useValue: { getKpis, getChartableCubes } }],
  });
  TestBed.overrideComponent(KpiChartBuilderComponent, { set: { imports: [StubPreview] } });
  const fixture: ComponentFixture<KpiChartBuilderComponent> = TestBed.createComponent(KpiChartBuilderComponent);
  return { fixture, el: () => fixture.nativeElement as HTMLElement };
}

function preview(fixture: ComponentFixture<KpiChartBuilderComponent>): StubPreview | null {
  const de = fixture.debugElement.query((d) => d.componentInstance instanceof StubPreview);
  return (de?.componentInstance as StubPreview) ?? null;
}

function pickKpi(fixture: ComponentFixture<KpiChartBuilderComponent>, name = 'OnHand') {
  const sel = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('[data-testid="kpi-select"]')!;
  sel.value = name; sel.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}
function setBreakdown(fixture: ComponentFixture<KpiChartBuilderComponent>, value: string) {
  const sel = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('[data-testid="expand-dim-select"]')!;
  sel.value = value; sel.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

describe('KpiChartBuilderComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('picking a KPI feeds the preview a { source:"kpi", kpi } baseSelection', async () => {
    const { fixture } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture);
    expect(preview(fixture)!.baseSelection()).toMatchObject({ source: 'kpi', kpi: 'OnHand' });
  });

  it('a scalar KPI (no breakdown) offers gauge/bullet only', async () => {
    const { fixture } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture);
    expect(preview(fixture)!.allowedTypes()).toEqual(['solidgauge', 'bullet']);
  });

  it('a KPI with a breakdown offers the six breakdown types and NOT the cube-only types', async () => {
    const { fixture } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture);
    setBreakdown(fixture, 'quantityStatus');
    const allowed = preview(fixture)!.allowedTypes();
    expect(allowed).toEqual(['bar', 'column', 'line', 'pie', 'slope', 'divergingBar']);
    for (const cubeOnly of ['heatmap', 'treemap', 'stackedColumn', 'stackedArea', 'radar', 'dumbbell', 'sunburst']) {
      expect(allowed).not.toContain(cubeOnly);
    }
  });

  it('flipping breakdown→scalar switches the allow-list back to gauge/bullet (drives the preview\'s stale-drop)', async () => {
    const { fixture } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture);
    setBreakdown(fixture, 'quantityStatus');
    expect(preview(fixture)!.allowedTypes()).toContain('bar');
    setBreakdown(fixture, ''); // back to (single value)
    expect(preview(fixture)!.allowedTypes()).toEqual(['solidgauge', 'bullet']);
    // The preview drops a held `bar` override when allowedTypes no longer offers it — proven in
    // chart-builder-preview.spec.ts; here we prove the builder feeds the flipped allow-list.
  });

  it('emits valid=false before any KPI is picked, valid=true once one is (A3-PLAN-01 — builder owns readiness)', async () => {
    const { fixture } = setup();
    const valids: boolean[] = [];
    fixture.componentInstance.valid.subscribe((v) => valids.push(v));
    fixture.detectChanges(); await fixture.whenStable();
    expect(valids.at(-1)).toBe(false);           // nothing picked → preview unmounted, builder still reports
    expect(preview(fixture)).toBeNull();
    pickKpi(fixture);
    expect(valids.at(-1)).toBe(true);
  });

  it('re-emits the preview\'s draftChange UNMODIFIED', async () => {
    const { fixture } = setup();
    const selections: ChartSelection[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture);
    preview(fixture)!.draftChange.emit({ source: 'kpi', kpi: 'OnHand', chartType: 'solidgauge' });
    expect(selections.at(-1)).toMatchObject({ source: 'kpi', kpi: 'OnHand', chartType: 'solidgauge' });
  });

  it('wraps the KPI and Break-down pickers in house section chrome with hints', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture); // reveal the Break-down section too
    const titles = [...el().querySelectorAll('.db-builder-section-title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('KPI'))).toBe(true);
    expect(titles.some((t) => t.includes('Break down by'))).toBe(true);
    expect(el().querySelectorAll('.db-builder-section-hint').length).toBeGreaterThanOrEqual(2);
    expect(el().querySelector('[data-testid="kpi-select"]')!.classList.contains('db-builder-control')).toBe(true);
    expect(el().querySelector('[data-testid="expand-dim-select"]')!.classList.contains('db-builder-control')).toBe(true);
  });

  it('collapses the per-widget label into the section title: no .kcb__label, each picker named via aria (SC-2665)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickKpi(fixture); // reveal the Break-down section too
    // The redundant "KPI"/"Break down by" label spans are gone.
    expect(el().querySelectorAll('.kcb__label')).toHaveLength(0);
    // Each picker takes its name from its section-title word and its description from the hint —
    // and every referenced id resolves to real text (no dangling aria reference).
    for (const [testid, labelId, hintId] of [
      ['kpi-select', 'kcb-kpi-label', 'kcb-kpi-hint'],
      ['expand-dim-select', 'kcb-breakdown-label', 'kcb-breakdown-hint'],
    ] as const) {
      const ctl = el().querySelector(`[data-testid="${testid}"]`)!;
      expect(ctl.getAttribute('aria-labelledby')).toBe(labelId);
      expect(ctl.getAttribute('aria-describedby')).toBe(hintId);
      expect(el().querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
      expect(el().querySelector(`#${hintId}`)?.textContent?.trim()).toBeTruthy();
    }
  });

  it('shows kpi-loading while getKpis is pending and NEVER co-renders the empty state (A-KTB-SPEC-08)', () => {
    const gate = new Subject<{ kpis: ChartableKpi[] }>();
    const { fixture, el } = setup(gate.asObservable());
    fixture.detectChanges();                                   // ngOnInit → loadingKpis(true), fetch pending
    expect(el().querySelector('[data-testid="kpi-loading"]')).not.toBeNull();
    expect(el().querySelector('[data-testid="no-chartable-kpis"]')).toBeNull(); // the two must never both show
    gate.next({ kpis: [] }); gate.complete(); fixture.detectChanges();
    expect(el().querySelector('[data-testid="kpi-loading"]')).toBeNull();
    expect(el().querySelector('[data-testid="no-chartable-kpis"]')).not.toBeNull(); // empty state appears once resolved
  });
});
