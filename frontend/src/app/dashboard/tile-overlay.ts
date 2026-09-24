import {
  Component, ChangeDetectionStrategy, ElementRef, computed, effect, input, output, viewChild,
} from '@angular/core';
import { ChartTileViewComponent } from './chart-tile-view';
import { TableTileViewComponent } from './table-tile-view';
import { KpiHealthPanelComponent } from './kpi-health-panel';
import { defaultTileTitle } from './dashboard-state';
import { isInteractiveTarget } from './tile-host';
import type { TileConfig } from './dashboard-config';

/**
 * A full-size overlay of one tile's rendered view (spec A2). It mounts the SAME
 * chart/table view component with the tile's selection — those self-fetch from the
 * stateless routes, so a second live instance is correct by construction (the one
 * render seam, spec §8 rule 3; no second renderer). Backdrop + centered definite-size
 * frame; closes on Close / Esc / backdrop / any non-interactive frame click (the shared
 * isInteractiveTarget guard keeps the enlarged table's sort/paging working). Focus trap
 * + role="dialog" + aria-modal mirror confirm-dialog / tile-editor. Renders nothing when
 * `open()` is null. Pure view state — never persists, never in DashboardConfig.
 *
 * For a KPI-source chart tile it also mounts a self-fetching `app-kpi-health-panel` below the
 * chart, so an expanded KPI shows its health in more detail than the tile footer (Fix 3); a cube
 * chart or table tile grows no health section.
 */
@Component({
  selector: 'app-tile-overlay',
  standalone: true,
  imports: [ChartTileViewComponent, TableTileViewComponent, KpiHealthPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tile-overlay.css',
  template: `
    @if (open(); as t) {
      <div class="ov-backdrop" (click)="close.emit()">
        <div #frame class="ov-frame" role="dialog" aria-modal="true" [attr.aria-label]="title()"
             tabindex="-1" (click)="onFrameClick($event)" (keydown)="onKeydown($event)">
          <header class="ov-head">
            <h2 class="ov-title">{{ title() }}</h2>
            <button #closeBtn type="button" class="ov-close" data-testid="overlay-close"
                    (click)="close.emit()" aria-label="Close">✕</button>
          </header>
          <div class="ov-body">
            <span class="ov-zoom-cue" data-testid="overlay-zoom-cue" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none"
                   stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <circle cx="6.5" cy="6.5" r="4.5"></circle>
                <line x1="10" y1="10" x2="14.5" y2="14.5"></line>
                <line x1="4.5" y1="6.5" x2="8.5" y2="6.5"></line>
              </svg>
            </span>
            @switch (t.kind) {
              @case ('chart') { @if (chartSel(); as s) { <app-chart-tile-view [selection]="s" [label]="title()" [bareTitle]="true" /> } }
              @case ('table') { @if (tableSel(); as s) { <app-table-tile-view [selection]="s" /> } }
            }
            @if (kpiName(); as name) {
              <app-kpi-health-panel [kpiName]="name" />
            }
          </div>
        </div>
      </div>
    }`,
})
export class TileOverlayComponent {
  readonly open = input<TileConfig | null>(null);
  readonly close = output<void>();

  private readonly frameEl = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly closeBtn = viewChild<ElementRef<HTMLElement>>('closeBtn');

  readonly title = computed(() => { const t = this.open(); return t ? (t.title ?? defaultTileTitle(t)) : ''; });
  readonly chartSel = computed(() => { const t = this.open(); return t?.kind === 'chart' ? t.selection : null; });
  readonly tableSel = computed(() => { const t = this.open(); return t?.kind === 'table' ? t.selection : null; });
  /** The KPI name when the expanded tile is a KPI-source chart tile, else null. Gates the health
   *  panel so a cube chart or a table tile never grows a health section (Fix 3). */
  readonly kpiName = computed(() => { const s = this.chartSel(); return s?.source === 'kpi' ? s.kpi : null; });

  /** The element focused when the overlay opened, so focus returns there on close
   *  (a11y, spec §5.3 "where feasible"). confirm-dialog/tile-editor move focus IN but
   *  do not restore; a full-size overlay dismissed by Esc must not strand the keyboard. */
  private triggerEl: HTMLElement | null = null;
  private wasOpen = false;

  constructor() {
    effect(() => {
      const isOpen = this.open() !== null;
      if (isOpen && !this.wasOpen) {
        const active = document.activeElement as HTMLElement | null;
        this.triggerEl = active && active !== document.body ? active : null; // capture the trigger once, on open
      }
      if (isOpen && this.closeBtn()) this.closeBtn()!.nativeElement.focus(); // move focus into the overlay
      if (!isOpen && this.wasOpen && this.triggerEl) {
        this.triggerEl.focus(); // returned to the trigger on close
        this.triggerEl = null;
      }
      this.wasOpen = isOpen;
    });
  }

  /** Any click inside the frame closes UNLESS it lands on an interactive control (shared guard).
   *  stopPropagation is UNCONDITIONAL: the frame is nested in .ov-backdrop, whose click handler
   *  emits close unconditionally, so a frame click that reached the backdrop would close even on
   *  an interactive target (ADS-PLAN-01). Stopping here makes this the ONLY close path from inside
   *  the frame — mirrors confirm-dialog / tile-editor ("the dialog stops backdrop clicks"). */
  onFrameClick(ev: MouseEvent): void {
    ev.stopPropagation();
    if (isInteractiveTarget(ev.target)) return;
    this.close.emit();
  }
  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); this.close.emit(); return; }
    if (ev.key === 'Tab') this.trapTab(ev);
  }
  /** Minimal jsdom-tolerant focus trap, copied from confirm-dialog. */
  private trapTab(ev: KeyboardEvent): void {
    const root = this.frameEl()?.nativeElement;
    if (!root) return;
    const f = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (f.length === 0) { ev.preventDefault(); root.focus(); return; }
    const first = f[0]!, last = f[f.length - 1]!;
    const active = (root.ownerDocument.activeElement as HTMLElement) ?? null;
    if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }
}
