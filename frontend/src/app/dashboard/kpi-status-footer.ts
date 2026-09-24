import { Component, ChangeDetectionStrategy, effect, computed, inject, input, signal } from '@angular/core';
import { KpiHealthService, type KpiHealth } from './services/kpi-health.service';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

/** The three threshold states, rendered as plain-language labels in the footer. */
const STATUS_LABEL: Record<'ok' | 'watching' | 'warning', string> = {
  ok: 'On track',
  watching: 'Watching',
  warning: 'Warning',
};

/**
 * A body-level STATUS FOOTER for a dashboard KPI tile (Phase 2 redesign, replaces the header
 * issue chip). Pinned to the bottom of the tile body like a table tile's pager row, it carries
 * the tile's state INSIDE the tile — a status dot in the threshold colour + plain label on the
 * left, and an issue summary on the right — so the state reads as tile content, not title-bar
 * chrome, and is present on EVERY KPI tile (not just ones with issues). A click on the footer
 * expands the tile (it is a child of the tile body and carries no expand opt-out), matching the
 * chart body above it (Fix 1).
 *
 * Self-fetches its own KpiHealthService envelope (same service the detail view uses; Decision
 * B-2: the health read degrades independently of /chart-data). A read failure, or an envelope
 * with neither a threshold nor issues, renders nothing — the chart tile is never disturbed and
 * a non-health KPI shows no footer. The tile keeps drawing the D3 bullet for the threshold; the
 * footer restates status in words + surfaces the issue count. OnPush.
 *
 * Reads `kpiName` REACTIVELY (an effect, mirroring chart-tile-view): the tile grid tracks by id
 * and `updateTile` keeps the id, so editing a tile's KPI in place changes the input without a
 * remount — the footer must re-fetch to match the chart beside it, not stay on ngOnInit's first
 * name (B-IMPL-01). Like chart-tile-view, the effect fires on every name change so two fetches
 * can be in flight at once; a monotonic reqToken drops any superseded response so a slow earlier
 * read can't overwrite a fast later one.
 */
@Component({
  selector: 'app-kpi-status-footer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './kpi-status-footer.css',
  template: `
    @if (health(); as h) {
      @if (h.threshold || h.issues) {
        <div class="ksf" data-testid="kpi-status-footer">
          @if (h.threshold; as t) {
            <span class="ksf__status">
              <span class="ksf__dot" data-testid="status-dot" aria-hidden="true"
                    [style.background-color]="t.statusColor || 'var(--db-text-secondary)'"></span>
              <span class="ksf__label" data-testid="status-label">{{ statusLabel(t.status) }}</span>
            </span>
          }
          @if (issueSummary(); as s) {
            @if (s.raised) {
              <button type="button" class="ksf__issues ksf__issues--raised"
                      data-testid="footer-issues" [title]="s.title"
                      [attr.aria-label]="'View ' + s.text + ' for ' + kpiName()"
                      (click)="openIssues()">
                <span class="ksf__warn" aria-hidden="true">⚠</span>
                {{ s.text }}
              </button>
            } @else {
              <span class="ksf__issues" data-testid="footer-issues" [title]="s.title">{{ s.text }}</span>
            }
          }
        </div>
      }
    }`,
})
export class KpiStatusFooterComponent {
  private readonly svc = inject(KpiHealthService);
  private readonly bridge = inject(WorkbenchBridgeService);
  readonly kpiName = input.required<string>();

  /** The fetched envelope, or null → render nothing (read failure or not yet loaded). */
  readonly health = signal<KpiHealth | null>(null);

  /**
   * Monotonic fetch token: the effect re-fires whenever `kpiName` changes (an in-place
   * tile edit keeps the id, so the input mutates without a remount), and two reads can
   * overlap. Each read captures the token and re-checks it before writing, so a superseded
   * response is dropped rather than clobbering the current KPI's health.
   */
  private reqToken = 0;

  constructor() {
    effect(() => {
      const name = this.kpiName();
      const token = ++this.reqToken;
      this.health.set(null); // clear stale state while the new name loads
      this.svc.getKpiHealth(name).subscribe({
        next: (h) => { if (token === this.reqToken) this.health.set(h); },
        error: () => { if (token === this.reqToken) this.health.set(null); }, // degrade silently — tile undisturbed
      });
    });
  }

  statusLabel(status: 'ok' | 'watching' | 'warning' | null): string {
    return status ? STATUS_LABEL[status] : 'Unknown';
  }

  /** Navigate to Issue Management scoped to this KPI. Only reachable from the raised
   *  affordance (the button renders only when issueSummary().raised), so no re-guard here. */
  openIssues(): void {
    void this.bridge.openIssuesForKpi(this.kpiName());
  }

  /**
   * The right-hand issue summary derived from the envelope's issues union:
   * null issues → "Issues not tracked" (muted; the KPI does not track issues); unavailable →
   * "issues unavailable"; 0 → "No issues"; N>0 → "N issue(s)" flagged as raised (⚠ + warn tone),
   * with the per-severity breakdown in the hover title.
   */
  readonly issueSummary = computed<{ text: string; title: string; raised: boolean } | null>(() => {
    const iss = this.health()?.issues;
    // A KPI that does not track issues (issues: null) is a distinct, intentional state — NOT
    // the same as "tracked, none raised" (which shows "No issues"). Surface it in the same
    // muted (raised:false) tone as "issues unavailable" so a blank right side never reads as
    // broken (Fix 2). It only renders when the footer is mounted (@if threshold || issues),
    // so a plain non-health KPI still shows nothing.
    if (!iss) return { text: 'Issues not tracked', title: 'This KPI does not track issues', raised: false };
    if ('unavailable' in iss) return { text: 'issues unavailable', title: 'Issue count unavailable', raised: false };
    if (iss.total === 0) return { text: 'No issues', title: 'No issues raised', raised: false };
    const noun = iss.total === 1 ? 'issue' : 'issues';
    const breakdown = iss.bySeverity.map((s) => `${s.count} sev-${s.severity}`).join(', ');
    return {
      text: `${iss.total} ${noun}`,
      title: `${iss.total} ${noun} raised${breakdown ? ` (${breakdown})` : ''}`,
      raised: true,
    };
  });
}
