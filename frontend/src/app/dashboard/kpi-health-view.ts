import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { KpiHealth } from './services/kpi-health.service';

/**
 * Shared, fetch-free presentational view of a KPI's health envelope (Track B). Renders the
 * value in its status colour, a threshold band strip (same band semantics + colours as the
 * D3 bullet — the envelope bakes BAND_COLORS in), and an issues summary. Every degrade state
 * renders cleanly: threshold:null → plain value; valueUnavailable → strip w/o marker;
 * issues null → 'Issues not tracked'; 0/unavailable/N each first-class. Theme-aware via --db-* tokens. OnPush.
 *
 * When issues ARE raised (total > 0), the summary is a real <button> that emits `openIssues`
 * (SC-2663 Bug 1): in the expand overlay a plain <span> click fell through to the overlay's
 * close handler, so the tile just zoomed out again. A <button> is an interactive target the
 * shared isInteractiveTarget guard recognizes, so it both suppresses the overlay close AND
 * gives a drill-down into the KPI-scoped Issue list. The non-raised states (tracked-but-zero,
 * unavailable, not-tracked) stay inert text — no dead click.
 */
@Component({
  selector: 'app-kpi-health-view',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './kpi-health-view.css',
  template: `
    @if (health(); as h) {
      <div class="khv">
        <div class="khv__value-row">
          @if (h.value !== null) {
            <span class="khv__value" data-testid="health-value" [style.color]="h.threshold?.statusColor || 'inherit'">
              {{ h.value | number }}
            </span>
          }
          @if (h.valueUnavailable) {
            <span class="khv__note" data-testid="value-unavailable">value unavailable</span>
          }
        </div>

        @if (h.threshold; as t) {
          <div class="khv__strip" data-testid="band-strip" role="img"
               [attr.aria-label]="'Threshold status: ' + (t.status ?? 'unknown')">
            @for (b of t.bands; track $index) {
              <span class="khv__zone" data-testid="band-zone" [style.background-color]="b.color"></span>
            }
          </div>
        }

        @if (h.issues; as iss) {
          <div class="khv__issues" data-testid="issues">
            @if (isUnavailable(iss)) {
              <span class="khv__note" data-testid="issues-unavailable">issue count unavailable</span>
            } @else if (total(iss) === 0) {
              <span class="khv__no-issues">No issues raised</span>
            } @else {
              <button type="button" class="khv__issues-open" data-testid="issues-open"
                      [attr.aria-label]="'View ' + total(iss) + ' ' + (total(iss) === 1 ? 'issue' : 'issues') + ' for this KPI'"
                      (click)="openIssues.emit()">
                <span class="khv__issues-total">{{ total(iss) }} {{ total(iss) === 1 ? 'issue' : 'issues' }}</span>
                @for (s of bySeverity(iss); track s.severity) {
                  <span class="khv__sev" data-testid="sev-chip" [class]="'khv__sev--' + s.severity">
                    {{ s.count }} sev-{{ s.severity }}
                  </span>
                }
              </button>
            }
          </div>
        } @else {
          <span class="khv__note" data-testid="issues-not-tracked">Issues not tracked</span>
        }
      </div>
    } @else {
      <div class="khv khv--skeleton" data-testid="health-skeleton" aria-hidden="true">
        <div class="khv__value-row"><span class="khv__sk khv__sk--value"></span></div>
        <div class="khv__strip">
          <span class="khv__sk khv__sk--zone"></span><span class="khv__sk khv__sk--zone"></span><span class="khv__sk khv__sk--zone"></span>
        </div>
        <div class="khv__issues"><span class="khv__sk khv__sk--issues"></span></div>
      </div>
    }`,
})
export class KpiHealthViewComponent {
  readonly health = input<KpiHealth | null>(null);
  /** Emitted when the raised-issues summary is clicked — the wrapper opens the KPI-scoped
   *  Issue list. Only the raised branch renders the button, so this never fires from an
   *  inert state (SC-2663 Bug 1). */
  readonly openIssues = output<void>();

  /** Narrow the issues union in the template (structural checks; no re-derivation). */
  isUnavailable(iss: NonNullable<KpiHealth['issues']>): boolean {
    return 'unavailable' in iss;
  }
  total(iss: NonNullable<KpiHealth['issues']>): number {
    return 'total' in iss ? iss.total : 0;
  }
  bySeverity(iss: NonNullable<KpiHealth['issues']>): { severity: number; count: number }[] {
    return 'bySeverity' in iss ? iss.bySeverity : [];
  }
}
