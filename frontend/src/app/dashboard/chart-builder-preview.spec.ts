import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChartBuilderPreviewComponent } from './chart-builder-preview';
import type { ChartSelection } from './dashboard-config';
import type { RenderedChart } from './chart-tile-view';

@Component({ selector: 'app-chart-tile-view', standalone: true, template: '<div class="stub-preview-tile"></div>' })
class StubChartPreviewTile {
  readonly selection = input<ChartSelection>();
  readonly label = input<string>();
  readonly applicableTypesChange = output<string[] | undefined>();
  readonly rendered = output<RenderedChart | null>();
}

const CUBE_BASE: ChartSelection = { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] };
const CUBE_ALLOWED = ['bar', 'column', 'line', 'pie']; // a small stand-in allow-list
const KPI_SCALAR_ALLOWED = ['solidgauge', 'bullet'];

function setup(inputs: Partial<{ baseSelection: ChartSelection | null; allowedTypes: readonly string[]; seedType: string | null; seedUseAi: boolean }> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ChartBuilderPreviewComponent] });
  TestBed.overrideComponent(ChartBuilderPreviewComponent, { set: { imports: [StubChartPreviewTile] } });
  const fixture: ComponentFixture<ChartBuilderPreviewComponent> = TestBed.createComponent(ChartBuilderPreviewComponent);
  // `in` (not `??`): an explicit `baseSelection: null` must survive — `null ?? CUBE_BASE` would swallow it.
  fixture.componentRef.setInput('baseSelection', 'baseSelection' in inputs ? inputs.baseSelection : CUBE_BASE);
  fixture.componentRef.setInput('allowedTypes', inputs.allowedTypes ?? CUBE_ALLOWED);
  fixture.componentRef.setInput('seedType', inputs.seedType ?? null);
  fixture.componentRef.setInput('seedUseAi', inputs.seedUseAi ?? false);
  // Subscribe BEFORE the first detectChanges so the initial complete-draft emission is captured
  // (an output() does not replay; a post-setup subscriber would miss the on-init emit).
  const drafts: ChartSelection[] = [];
  fixture.componentInstance.draftChange.subscribe((d) => drafts.push(d));
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, drafts };
}

function typeOptions(el: HTMLElement): HTMLOptionElement[] {
  return [...el.querySelectorAll<HTMLOptionElement>('[data-testid="type-select"] option')];
}

describe('ChartBuilderPreviewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('emits a COMPLETE draft (baseSelection + resolved chartType) when a base is present', () => {
    const { fixture, el, drafts } = setup();
    expect(drafts.at(-1)).toMatchObject({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'] });
    // Override to a type in the allow-list; only chartType changes.
    const sel = el.querySelector<HTMLSelectElement>('[data-testid="type-select"]')!;
    sel.value = 'pie'; sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(drafts.at(-1)).toMatchObject({ source: 'cube', cube: 'SalesCube', chartType: 'pie' });
  });

  it('does NOT own a valid output — readiness lives in the always-mounted source builder (A3-PLAN-01)', () => {
    const { fixture } = setup();
    // The preview mounts only behind @if (baseSelection()); a valid here could never report
    // the complete→incomplete transition. It exposes draftChange only.
    expect('valid' in fixture.componentInstance).toBe(false);
  });

  it('renders no dropdown when baseSelection is null', () => {
    const { el } = setup({ baseSelection: null });
    expect(el.querySelector('[data-testid="type-select"]')).toBeNull();
  });

  it('greys a type in allowedTypes that is not (yet) in applicableTypes, with its reason', () => {
    const { el, fixture } = setup();
    fixture.componentInstance.onApplicableTypesChange(['bar', 'line']); // pie/column not applicable
    fixture.detectChanges();
    const disabledOf = (v: string) => typeOptions(el).find((o) => o.getAttribute('value') === v)!.disabled;
    expect(disabledOf('bar')).toBe(false);
    expect(disabledOf('pie')).toBe(true); // in allow-list, not applicable → greyed
  });

  it('never lists a type that is not in allowedTypes (an editorial exclusion is absent, not greyed)', () => {
    const { el } = setup({ allowedTypes: KPI_SCALAR_ALLOWED, baseSelection: { source: 'kpi', kpi: 'OnHand' } });
    const values = typeOptions(el).map((o) => o.getAttribute('value'));
    expect(values).toContain('solidgauge');
    expect(values).toContain('bullet');
    expect(values).not.toContain('bar');   // not in the scalar allow-list → absent entirely
    expect(values).not.toContain('heatmap');
  });

  it('drops a SEEDED type that is outside allowedTypes to Recommended (pre-A3 edit-open migration)', () => {
    // A pre-A3 KPI-breakdown tile could have saved chartType:'area'; a scalar KPI allow-list won't list it.
    const { el, drafts } = setup({ baseSelection: { source: 'kpi', kpi: 'OnHand' }, allowedTypes: KPI_SCALAR_ALLOWED, seedType: 'area' });
    expect(typeOptions(el).map((o) => o.getAttribute('value'))).not.toContain('area');
    expect(drafts.at(-1)).not.toHaveProperty('chartType'); // seed dropped → Recommended (no chartType)
  });

  it('drops a held override that leaves applicableTypes (kept from today)', () => {
    const { el, fixture, drafts } = setup();
    const sel = el.querySelector<HTMLSelectElement>('[data-testid="type-select"]')!;
    sel.value = 'pie'; sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(drafts.at(-1)).toMatchObject({ chartType: 'pie' });
    // The data can no longer draw pie → drop to Recommended.
    fixture.componentInstance.onApplicableTypesChange(['bar', 'line']);
    fixture.detectChanges();
    expect(drafts.at(-1)).not.toHaveProperty('chartType');
  });

  it('shows the why-line and fallback note from a fed rendered output', () => {
    const { el, fixture } = setup();
    fixture.componentInstance.onRendered({
      data: { categories: ['a', 'b'], series: [{ name: 's', data: [1, 2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } },
      spec: { spec: { chart: { type: 'bar' } }, type: 'bar', layer: '2', fallback: true, reason: 'Could not parse a chart type.' },
    } as RenderedChart);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="chart-why"]')?.textContent).toContain('recommended');
    expect(el.querySelector('[data-testid="fallback-note"]')?.textContent).toContain('Could not parse');
  });

  it('hides the Ask AI control by default (aiEnabled=false)', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="ai-toggle"]')).toBeNull();
  });

  it('groups the explanatory affordances in one bounded region (audit #7 — Gestalt common region, density budget)', () => {
    // The why-line, why-explanation and fallback note are all "about this chart"; grouping them in
    // one region keeps them a single readable block rather than free-floating stacked paragraphs.
    const { el, fixture } = setup();
    fixture.componentInstance.onRendered({
      data: { categories: ['a', 'b'], series: [{ name: 's', data: [1, 2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } },
      spec: { spec: { chart: { type: 'bar' } }, type: 'bar', layer: '1b', source: 'shape-default', fallback: true, reason: 'Could not parse a chart type.' },
    } as RenderedChart);
    fixture.detectChanges();
    const aids = el.querySelector('[data-testid="chart-aids"]');
    expect(aids).not.toBeNull();
    // every affordance that rendered lives inside the one region.
    expect(aids!.querySelector('[data-testid="chart-why"]')).not.toBeNull();
    expect(aids!.querySelector('[data-testid="chart-why-explanation"]')).not.toBeNull();
    expect(aids!.querySelector('[data-testid="fallback-note"]')).not.toBeNull();
  });

  it('shows the funnel Order toggle only for funnel and emits funnelSort on the draft', () => {
    const { fixture, el, drafts } = setup({ allowedTypes: ['bar', 'column', 'line', 'pie', 'funnel'] });
    const typeSelect = el.querySelector<HTMLSelectElement>('[data-testid="type-select"]')!;
    expect(el.querySelector('[data-testid="funnel-order"]')).toBeNull();
    typeSelect.value = 'funnel'; typeSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="funnel-order"]')).not.toBeNull();
    const funnelOrder = el.querySelector<HTMLSelectElement>('[data-testid="funnel-order"]')!;
    funnelOrder.value = 'source'; funnelOrder.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(drafts.at(-1)).toMatchObject({ chartType: 'funnel', funnelSort: 'source' });
    typeSelect.value = 'bar'; typeSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="funnel-order"]')).toBeNull();
    expect(drafts.at(-1)).not.toHaveProperty('funnelSort');
  });
});
