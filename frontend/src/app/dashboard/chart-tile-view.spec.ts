// frontend/src/app/dashboard/chart-tile-view.spec.ts
import { TestBed, DeferBlockBehavior } from '@angular/core/testing';
import { Component, viewChild } from '@angular/core';
import { of, throwError, Subject } from 'rxjs';
import { ChartTileViewComponent } from './chart-tile-view';
import { ChartViewComponent } from './chart-view';
import { DashboardChartService } from './services/dashboard-chart.service';

const chartData = { categories: ['a', 'b'], series: [{ name: 's', data: [1, 2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' }, applicableTypes: ['bar'] };
const specResp = { spec: { chart: { type: 'bar' }, series: [{ type: 'bar', data: [1, 2] }] }, type: 'bar', layer: '1a' };

function mockSvc(over: Partial<Record<'getChartData' | 'getChartSpec', any>> = {}) {
  return {
    getChartData: over.getChartData ?? (() => of(chartData)),
    getChartSpec: over.getChartSpec ?? (() => of(specResp)),
  } as unknown as DashboardChartService;
}

@Component({
  standalone: true, imports: [ChartTileViewComponent],
  template: `<app-chart-tile-view [selection]="sel"
              (applicableTypesChange)="applicable = $event"
              (rendered)="renderedLog.push($event)" />`,
})
class Host {
  sel: any = { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] };
  applicable: string[] | undefined;
  readonly renderedLog: Array<{ data: any; spec: any } | null> = [];
  readonly tileView = viewChild.required(ChartTileViewComponent);
}

/**
 * Mount the real <app-chart-view> under jsdom. Manual defer behavior keeps the
 * ECharts leaf inside <app-chart-view>'s `@defer (on immediate)` at its placeholder:
 * these tests assert the tile's orchestration and that it delegates to the ONE
 * <app-chart-view> wrapper (spec §8 rule 3) — not the leaf's canvas render, which
 * jsdom has no getContext for and which ECharts would reject for an axis-less bar.
 */
function configure(svc: DashboardChartService) {
  TestBed.configureTestingModule({
    imports: [Host],
    providers: [
      { provide: DashboardChartService, useValue: svc },
    ],
    deferBlockBehavior: DeferBlockBehavior.Manual,
  });
}

describe('ChartTileViewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a chart-view when data + spec resolve', async () => {
    configure(mockSvc());
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.nativeElement.querySelector('app-chart-view')).toBeTruthy();
  });

  // Redesign R8 (spec §12): this host must fill its tile body so the chart-view's
  // height:100% chain resolves against the bounded grid track — otherwise the chart
  // (now sized to fill, not a fixed 360px) collapses to 0. Guard the :host fill,
  // matched to THIS host's own encapsulation attribute (chart-view, a child, also
  // ships a :host height rule into the same document — a doc-wide scan would false-green).
  it('fills its host so the chart-view height chain resolves (height:100%)', async () => {
    configure(mockSvc());
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const host = f.nativeElement.querySelector('app-chart-tile-view') as HTMLElement;
    // Emulated encapsulation stamps the host element with `_nghost-<id>` and compiles
    // its `:host` rule to `[_nghost-<id>]{…}`. Match the rule for THIS exact attribute.
    const nghost = Array.from(host.attributes).map((a) => a.name).find((n) => n.startsWith('_nghost'));
    expect(nghost).toBeTruthy();
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    const rule = new RegExp(`\\[${nghost}\\][^{]*\\{[^}]*height:\\s*100%`);
    expect(css).toMatch(rule);
  });

  it('defaults bareTitle false so the chart-view keeps its in-box title (builder preview)', async () => {
    configure(mockSvc());
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const view = f.debugElement.query((de) => de.componentInstance instanceof ChartViewComponent);
    expect((view!.componentInstance as ChartViewComponent).bareTitle()).toBe(false);
  });

  // Redesign R3 (spec §12): the dashboard tile passes [bareTitle]="true"; it must
  // reach the one <app-chart-view> so the in-box title (a duplicate of the header) is
  // stripped. Bind it on a dedicated host so the default-false host above is untouched.
  it('passes bareTitle through to the chart-view when the tile requests a bare title', async () => {
    @Component({
      standalone: true, imports: [ChartTileViewComponent],
      template: `<app-chart-tile-view [selection]="sel" [bareTitle]="true" />`,
    })
    class BareHost {
      sel: any = { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] };
    }
    TestBed.configureTestingModule({
      imports: [BareHost],
      providers: [
        { provide: DashboardChartService, useValue: mockSvc() },
      ],
      deferBlockBehavior: DeferBlockBehavior.Manual,
    });
    const f = TestBed.createComponent(BareHost); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const view = f.debugElement.query((de) => de.componentInstance instanceof ChartViewComponent);
    expect(view).toBeTruthy();
    expect((view!.componentInstance as ChartViewComponent).bareTitle()).toBe(true);
  });

  // The tile is the builder's live preview: it emits the backend's applicable-type
  // allow-list so the builder can grey inapplicable chart types (one /chart-data fetch,
  // no duplicate read in the builder), and the (data, spec) pair so the builder can
  // render the why-line / fallback / treemap-key / collapse-note affordances.
  it('emits applicableTypesChange with the backend allow-list, and rendered with (data, spec)', async () => {
    const withTypes = { ...chartData, applicableTypes: ['bar', 'line', 'pie'] };
    configure(mockSvc({ getChartData: () => of(withTypes) }));
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.componentInstance.applicable).toEqual(['bar', 'line', 'pie']);
    // rendered fires null at load-start then the resolved pair; the last is the pair.
    const last = f.componentInstance.renderedLog.at(-1);
    expect(last?.data).toMatchObject({ categories: ['a', 'b'] });
    expect(last?.spec).toMatchObject({ type: 'bar' });
  });

  it('maps a general cube selection to a general chart-data request (measures[] + dimensions[])', async () => {
    // Capture the outgoing getChartData argument: the tile must forward the general
    // shape UNCOLLAPSED — the row/series collapse happens only in the backend.
    let req: any;
    configure(mockSvc({ getChartData: (r: any) => { req = r; return of(chartData); } }));
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(req).toMatchObject({
      source: 'cube', cube: 'SalesCube', measures: ['Revenue'],
      dimensions: [{ name: 'region', role: 'category' }],
    });
  });

  it('emits rendered(null) — clearing the builder affordances — when the query returns nothing to plot', async () => {
    const empty = { ...chartData, series: [{ name: 's', data: [null, null] }] };
    configure(mockSvc({ getChartData: () => of(empty) }));
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.componentInstance.renderedLog.at(-1)).toBeNull();
  });

  it('shows a per-tile error (not a throw) when getChartData fails', async () => {
    configure(mockSvc({ getChartData: () => throwError(() => ({ error: { error: 'boom', code: 'QUERY_FAILED' } })) }));
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.nativeElement.textContent).toContain('boom');
    expect(f.nativeElement.querySelector('app-chart-view')).toBeFalsy();
  });

  it('shows an empty-state when the query returns nothing to plot', async () => {
    const empty = { ...chartData, series: [{ name: 's', data: [null, null] }] };
    configure(mockSvc({ getChartData: () => of(empty) }));
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.nativeElement.querySelector('app-chart-view')).toBeFalsy();
  });

  // DA-PLAN-05: a chart tile whose cube/KPI is gone gets a DISTINCT "source unavailable"
  // affordance (parallel to the table tile), not just the generic query-error text.
  it('shows a distinct "source unavailable" state when the source no longer exists (404/missing)', async () => {
    configure(mockSvc({ getChartData: () => throwError(() => ({ status: 404, error: { error: 'cube not found', code: 'NOT_FOUND' } })) }));
    const f = TestBed.createComponent(Host); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.nativeElement.querySelector('.tile-source-gone')).toBeTruthy();
    expect(f.nativeElement.textContent).toContain('no longer available');
  });

  // DA-PLAN-01: the live-preview reload fires on EVERY builder pick, so two chains can be
  // in flight. A slow first load that resolves AFTER a fast second load must NOT win —
  // the tile must render the LATEST selection's spec, never a superseded one.
  it('renders the latest selection when a slow earlier load resolves after a fast later one', async () => {
    const slow = new Subject<any>(); // first selection's data, resolved late
    const fast = { ...chartData, meta: { ...chartData.meta } };
    let call = 0;
    const svc = mockSvc({
      getChartData: () => (call++ === 0 ? slow.asObservable() : of(fast)),
      // tag each spec so we can tell which selection produced it
      getChartSpec: (req: any) => of({ ...specResp, type: req.type ?? 'bar', spec: { chart: { type: req.type ?? 'bar' } } }),
    });
    configure(svc);
    const f = TestBed.createComponent(Host);
    f.componentInstance.sel = { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }], chartType: 'line' };
    f.detectChanges();                        // fires load #1 (slow, chartType 'line')
    f.componentInstance.sel = { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }], chartType: 'pie' };
    f.detectChanges(); await f.whenStable();  // fires load #2 (fast, chartType 'pie') → resolves first
    slow.next({ ...chartData }); slow.complete(); // NOW the stale first load resolves
    await f.whenStable(); f.detectChanges();
    // The stale chain must have been discarded: the rendered spec is the LATEST ('pie'), not 'line'.
    expect(f.componentInstance).toBeTruthy();
    const view = f.nativeElement.querySelector('app-chart-view');
    expect(view).toBeTruthy();
    expect(f.componentInstance.tileView().spec()?.type).toBe('pie');
  });
});
