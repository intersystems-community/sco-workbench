import { Component, ChangeDetectionStrategy, effect, inject, input, signal } from '@angular/core';
import { KpiHealthService, type KpiHealth } from './services/kpi-health.service';
import { KpiHealthViewComponent } from './kpi-health-view';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

/**
 * A self-fetching wrapper that adapts the fetch-free `kpi-health-view` (Track B — value in its
 * status colour, threshold band strip, per-severity issue breakdown, and the "Issues not tracked"
 * note) to a KPI-NAME input, so the expand overlay can show a KPI tile's health in more detail than
 * the tile footer without the overlay itself doing any HTTP (the overlay stays generic + fetch-free
 * for chart AND table tiles). The fetch mirrors kpi-status-footer exactly: `kpiName` is read
 * REACTIVELY (an effect) so an in-place name change re-fetches without a remount, and a monotonic
 * reqToken drops any superseded response. A read failure degrades silently to render-nothing, so a
 * health-read outage never disturbs the enlarged chart beside it (Decision B-2, inherited). OnPush.
 *
 * When the view surfaces raised issues as a drill-down button, the panel wires its `openIssues`
 * to `WorkbenchBridgeService.openIssuesForKpi` (SC-2663 Bug 1) — the same gesture as the tile
 * footer — so an expanded KPI's issue summary navigates to the KPI-scoped Issue list instead of
 * closing the overlay.
 */
@Component({
  selector: 'app-kpi-health-panel',
  standalone: true,
  imports: [KpiHealthViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-kpi-health-view [health]="health()" (openIssues)="openIssues()" />`,
})
export class KpiHealthPanelComponent {
  private readonly svc = inject(KpiHealthService);
  private readonly bridge = inject(WorkbenchBridgeService);
  readonly kpiName = input.required<string>();

  /** The fetched envelope, or null → kpi-health-view renders nothing (not yet loaded / read failed). */
  readonly health = signal<KpiHealth | null>(null);

  /** Monotonic fetch token: re-fires on every kpiName change; a superseded response is dropped. */
  private reqToken = 0;

  constructor() {
    effect(() => {
      const name = this.kpiName();
      const token = ++this.reqToken;
      this.health.set(null); // clear stale state while the new name loads
      this.svc.getKpiHealthShared(name).subscribe({
        next: (h) => { if (token === this.reqToken) this.health.set(h); },
        error: () => { if (token === this.reqToken) this.health.set(null); }, // degrade silently
      });
    });
  }

  /** Navigate to Issue Management scoped to this KPI. Only reachable from the view's raised
   *  drill-down button, so no re-guard here (mirrors kpi-status-footer). */
  openIssues(): void {
    void this.bridge.openIssuesForKpi(this.kpiName());
  }
}
