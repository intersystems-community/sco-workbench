import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TileOverlayComponent } from './tile-overlay';
import type { TileConfig } from './dashboard-config';

@Component({ selector: 'app-chart-tile-view', standalone: true, template: '<div class="stub-chart"></div>' })
class StubChartView { readonly selection = input<unknown>(); readonly label = input<string>(); readonly bareTitle = input<boolean>(false); }
@Component({ selector: 'app-table-tile-view', standalone: true, template: '<div class="stub-table"></div>' })
class StubTableView { readonly selection = input<unknown>(); }
@Component({ selector: 'app-kpi-health-panel', standalone: true, template: '<div class="stub-health-panel"></div>' })
class StubHealthPanel { readonly kpiName = input.required<string>(); }

const CHART: TileConfig = { id: 't0', kind: 'chart', layout: { w: 1, h: 1 }, selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] } };
const TABLE: TileConfig = { id: 't1', kind: 'table', layout: { w: 1, h: 1 }, title: 'Carriers', selection: { table: 'SC.Data.Carrier' } };
const KPI: TileConfig = { id: 't2', kind: 'chart', layout: { w: 1, h: 1 }, selection: { source: 'kpi', kpi: 'Fill Rate' } };

function setup(tile: TileConfig | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [TileOverlayComponent] });
  TestBed.overrideComponent(TileOverlayComponent, { set: { imports: [StubChartView, StubTableView, StubHealthPanel] } });
  const fixture: ComponentFixture<TileOverlayComponent> = TestBed.createComponent(TileOverlayComponent);
  fixture.componentRef.setInput('open', tile);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('TileOverlayComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing when open is null', () => {
    expect(setup(null).el.querySelector('.ov-backdrop')).toBeFalsy();
  });
  it('mounts the chart view (bareTitle) for a chart tile', () => {
    const { el, fixture } = setup(CHART);
    expect(el.querySelector('app-chart-tile-view')).toBeTruthy();
    expect(el.querySelector('app-table-tile-view')).toBeFalsy();
    const view = fixture.debugElement.query((de) => de.name === 'app-chart-tile-view')?.componentInstance as StubChartView;
    expect(view.bareTitle()).toBe(true);
  });
  it('mounts the table view for a table tile', () => {
    const { el } = setup(TABLE);
    expect(el.querySelector('app-table-tile-view')).toBeTruthy();
    expect(el.querySelector('app-chart-tile-view')).toBeFalsy();
  });
  it('mounts the KPI health panel (bound to the KPI name) for a KPI-source chart tile (Fix 3)', () => {
    const { el } = setup(KPI);
    const panel = el.querySelector('app-kpi-health-panel');
    expect(panel).toBeTruthy();
    // it lives in the overlay body, below the chart view
    expect(el.querySelector('.ov-body')!.contains(panel)).toBe(true);
    expect(el.querySelector('app-chart-tile-view')).toBeTruthy();
  });
  it('binds the KPI name onto the health panel', () => {
    const { fixture } = setup(KPI);
    const panel = fixture.debugElement.query((de) => de.name === 'app-kpi-health-panel')!.componentInstance as StubHealthPanel;
    expect(panel.kpiName()).toBe('Fill Rate');
  });
  it('does NOT mount the health panel for a cube-source chart tile', () => {
    expect(setup(CHART).el.querySelector('app-kpi-health-panel')).toBeFalsy();
  });
  it('does NOT mount the health panel for a table tile', () => {
    expect(setup(TABLE).el.querySelector('app-kpi-health-panel')).toBeFalsy();
  });
  it('emits close on the Close button, Esc, and a backdrop click', () => {
    for (const act of ['close-btn', 'esc', 'backdrop'] as const) {
      const { el, fixture } = setup(CHART);
      let fired = 0; fixture.componentInstance.close.subscribe(() => (fired += 1));
      if (act === 'close-btn') el.querySelector<HTMLButtonElement>('[data-testid="overlay-close"]')!.click();
      if (act === 'esc') el.querySelector<HTMLElement>('.ov-frame')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (act === 'backdrop') el.querySelector<HTMLElement>('.ov-backdrop')!.click();
      expect(fired).toBe(1);
    }
  });
  it('closes on a non-interactive frame click but NOT on an interactive control', () => {
    const { el, fixture } = setup(TABLE);
    let fired = 0; fixture.componentInstance.close.subscribe(() => (fired += 1));
    // A click on the stub view body (non-interactive) closes.
    el.querySelector<HTMLElement>('.stub-table')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
    // A click on an interactive control inside the frame does NOT close.
    const frame = el.querySelector<HTMLElement>('.ov-frame')!;
    const btn = document.createElement('button'); frame.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1); // unchanged
  });
  it('moves focus into the overlay on open and returns it to the trigger on close (a11y)', () => {
    // A trigger the shell would have focused (mirrors the tile the user clicked).
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { el, fixture } = setup(CHART); // opens with the trigger focused
    expect(el.querySelector<HTMLElement>('.ov-frame')!.contains(document.activeElement)).toBe(true); // focus moved in

    fixture.componentRef.setInput('open', null); // close
    fixture.detectChanges();
    expect(document.activeElement).toBe(trigger); // returned to the trigger
    trigger.remove();
  });

  // A1: a symmetric magnifier-minus cue on the overlay body signals "click again to close"
  // (spec §3). Like the tile-body cue it is decorative (aria-hidden) and non-interactive
  // (pointer-events:none), so the existing onFrameClick + isInteractiveTarget close path stands.
  it('renders a decorative, aria-hidden zoom-out cue inside the overlay body', () => {
    const { el } = setup(CHART);
    const cue = el.querySelector<HTMLElement>('[data-testid="overlay-zoom-cue"]');
    expect(cue).toBeTruthy();
    expect(el.querySelector('.ov-body')!.contains(cue)).toBe(true);
    expect(cue!.getAttribute('aria-hidden')).toBe('true');
    expect(cue!.tagName.toLowerCase()).toBe('span');
  });

  it('a click landing on the zoom-out cue still closes the overlay (the cue is non-interactive)', () => {
    const { el, fixture } = setup(CHART);
    let fired = 0; fixture.componentInstance.close.subscribe(() => (fired += 1));
    el.querySelector<HTMLElement>('[data-testid="overlay-zoom-cue"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('sets a zoom-out cursor on the overlay body (affordance that clicking closes)', () => {
    setup(CHART);
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    const body = css.match(/\.ov-body[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(body).toMatch(/cursor:\s*zoom-out/);
  });
});
