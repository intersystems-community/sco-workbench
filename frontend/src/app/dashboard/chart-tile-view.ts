// frontend/src/app/dashboard/chart-tile-view.ts
import { Component, ChangeDetectionStrategy, effect, inject, input, output, signal } from '@angular/core';
import { DashboardChartService, type ChartData, type ChartDataRequest, type ChartSpecRequest, type ChartSpecResponse } from './services/dashboard-chart.service';
import { ChartViewComponent } from './chart-view';
import { hasPlottableData } from './chart-shape';
import type { ChartSelection } from './dashboard-config';

/**
 * The (data, spec) pair a completed load resolved. Emitted upward via `rendered`
 * so the chart BUILDER (Task 11), which hosts this tile as its live preview, can
 * render the explanatory affordances that belong beside a chart the user is
 * actively picking — the why-this-chart provenance line, the AI-fallback note, the
 * treemap branch-colour key and the series-collapse note. The dashboard TILE stays
 * clean output (spec §2 view/edit split); those aids live in the editor's preview
 * only. `rendered(null)` is emitted whenever the chart clears (load start / empty /
 * error / gone) so the builder's affordances clear in lockstep.
 */
export interface RenderedChart { data: ChartData; spec: ChartSpecResponse }

/**
 * View-only chart tile: given a ChartSelection, run getChartData → getChartSpec
 * and render via <app-chart-view [spec]>. ZERO builder UI. The ONE render
 * delegation point (spec §8 rule 3) — the render seam lives HERE and only here
 * (ECharts is now the sole renderer, round 5); nothing below inspects the spec's
 * shape. Per-tile error/empty/
 * source-gone state so one tile's failure never takes down the dashboard (spec §7).
 * Reused as the chart builder's live preview so what you build is exactly what the
 * tile shows — which is WHY it must discard out-of-order responses (see reqToken).
 *
 * Two metadata outputs feed the builder without adding a second render path (spec
 * §8 rule 3 holds — the tile still renders through the one <app-chart-view>):
 * `applicableTypesChange` carries the backend's type allow-list so the builder can
 * grey inapplicable chart types with a reason (the panel's honesty affordance), and
 * `rendered` carries the (data, spec) pair for the builder-preview affordances.
 */
@Component({
  selector: 'app-chart-tile-view',
  standalone: true,
  imports: [ChartViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Fill the bounded tile body (redesign R8) so <app-chart-view>'s height:100% chain
  // resolves against the grid track — a fixed chart height overflowed the body and
  // forced a scrollbar. The inner chart-view flex-fills; the loading/error/empty
  // states are short divs that simply sit at the top.
  styles: [`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    app-chart-view { flex: 1 1 auto; min-height: 0; }
  `],
  template: `
    @if (sourceGone()) {
      <div class="tile-source-gone" role="alert">This chart's data source is no longer available. Edit the tile to pick another, or delete it.</div>
    } @else if (error()) {
      <div class="tile-error" role="alert">{{ error() }} <button type="button" (click)="reload()">Retry</button></div>
    } @else if (emptyData()) {
      <div class="tile-empty">No data to plot for this selection.</div>
    } @else if (spec(); as s) {
      <app-chart-view [spec]="s.spec" [label]="label()" [bareTitle]="bareTitle()" />
    } @else if (loading()) {
      <div class="tile-loading">Building chart…</div>
    }`,
})
export class ChartTileViewComponent {
  private readonly svc = inject(DashboardChartService);

  readonly selection = input.required<ChartSelection>();
  readonly label = input<string>('Chart');
  /**
   * Suppress the in-box chart title (redesign R3 / spec §12). The dashboard tile
   * sets this true — its header already shows the title, so the in-box one is a
   * duplicate. The builder's live preview leaves it false and keeps the in-box
   * title. Threaded straight to <app-chart-view>; nothing else here reads it.
   */
  readonly bareTitle = input<boolean>(false);

  /**
   * The chart types the loaded data can draw truthfully (backend `applicableTypes`),
   * or the full allow-list before/without a load. The builder greys the rest. Emitted
   * only from the tile so there is ONE `/chart-data` fetch per pick (the builder does
   * not re-fetch); a superseded chain never emits (the reqToken guard drops it first).
   */
  readonly applicableTypesChange = output<string[] | undefined>();
  /** The (data, spec) pair on a completed render, or null when the chart clears. Drives the builder-preview affordances. */
  readonly rendered = output<RenderedChart | null>();

  readonly loading = signal(false);
  readonly error = signal('');
  readonly emptyData = signal(false);
  readonly sourceGone = signal(false);
  readonly spec = signal<ChartSpecResponse | null>(null);

  /**
   * Monotonic load token (DA-PLAN-01). Because this tile is also the builder's
   * live preview, `load()` fires on EVERY selection change, so two data→spec
   * chains can be in flight at once. Each chain captures the token at start and
   * re-checks it before every signal write; a response whose token is no longer
   * current belongs to a superseded selection and is dropped. Without this, a
   * slow earlier load can resolve after a fast later one and render the wrong
   * chart. (chart-panel gets away with nested .subscribe only because it is
   * click-throttled and single-instance; the preview raises the trigger rate.)
   */
  private reqToken = 0;

  constructor() {
    effect(() => { const sel = this.selection(); this.load(sel); });
  }
  reload(): void { this.load(this.selection()); }

  private load(sel: ChartSelection): void {
    const token = ++this.reqToken;
    const current = () => token === this.reqToken; // false once a newer load started
    this.loading.set(true); this.error.set(''); this.emptyData.set(false); this.sourceGone.set(false); this.spec.set(null);
    this.rendered.emit(null); // clear the builder-preview affordances until this load resolves
    const req: ChartDataRequest = sel.source === 'kpi'
      ? { source: 'kpi', kpi: sel.kpi, expandDimension: sel.expandDimension }
      : { source: 'cube', cube: sel.cube, measures: sel.measures, dimensions: sel.dimensions, topN: sel.topN };
    this.svc.getChartData(req).subscribe({
      next: (data: ChartData & { applicableTypes?: string[] }) => {
        if (!current()) return;                                  // superseded — drop
        this.applicableTypesChange.emit(data.applicableTypes);   // feed the builder's type greying
        if (!hasPlottableData(data)) { this.loading.set(false); this.emptyData.set(true); return; }
        const specReq: ChartSpecRequest = { chartData: data };
        if (sel.useAi) specReq.useAi = true; else if (sel.chartType) specReq.type = sel.chartType;
        if (sel.source === 'cube' && sel.funnelSort) specReq.funnelSort = sel.funnelSort;
        this.svc.getChartSpec(specReq).subscribe({
          next: (resp) => { if (!current()) return; this.loading.set(false); this.spec.set(resp); this.rendered.emit({ data, spec: resp }); },
          error: (err) => { if (!current()) return; this.loading.set(false); this.fail(err); },
        });
      },
      error: (err) => { if (!current()) return; this.loading.set(false); this.fail(err); },
    });
  }

  /** Route a gone-source failure (404/not-found) to the distinct source-gone state (DA-PLAN-05); everything else is a retryable error. */
  private fail(err: unknown): void {
    if (isSourceGone(err)) this.sourceGone.set(true);
    else this.error.set(messageOf(err));
  }
}

function isSourceGone(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const code = (err as { error?: { code?: string } })?.error?.code;
  return status === 404 || code === 'NOT_FOUND';
}

function messageOf(err: unknown): string {
  const body = (err as { error?: unknown })?.error;
  if (body && typeof body === 'object' && 'error' in body) return String((body as { error: unknown }).error);
  if (err instanceof Error) return err.message;
  return String(err);
}
