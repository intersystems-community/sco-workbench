import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * A small, reusable confirmation modal used in place of the browser's native
 * `confirm()` for destructive or lossy actions (delete a cube/KPI, discard
 * unsaved edits). Purely presentational: the host toggles it with `*ngIf` (or
 * binds `open`) and reacts to (confirmed)/(cancelled).
 *
 *   <app-confirm-dialog
 *     *ngIf="showConfirm"
 *     title="Delete cube"
 *     [message]="'Delete \"' + name + '\"? This removes it from SCO.'"
 *     confirmLabel="Delete"
 *     [danger]="true"
 *     (confirmed)="doDelete()"
 *     (cancelled)="showConfirm = false">
 *   </app-confirm-dialog>
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The `title` @Input is passed as a static `title="…"` attribute, which the
  // browser also treats as a native tooltip on the host element (a grey box on
  // hover). Null out the host's DOM `title` so only our dialog uses the text.
  host: { '[attr.title]': 'null' },
  template: `
    <div class="cd-backdrop" (click)="onCancel()">
      <div class="cd-modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
        <div class="cd-icon" [class.cd-icon--danger]="danger" [class.cd-icon--warn]="!danger">
          <svg *ngIf="danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <svg *ngIf="!danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <h3 class="cd-title">{{ title }}</h3>
        <p class="cd-message">{{ message }}</p>
        <div class="cd-actions">
          <!-- Omitted when cancelLabel is blank: an ACKNOWLEDGEMENT dialog ("Claude
               key not provided", OK) has one way out, and a second button that
               does the same thing only asks the user to choose between identical
               outcomes. Confirmations keep their Cancel (the default label). -->
          <button *ngIf="cancelLabel" class="cd-btn cd-btn--ghost" (click)="onCancel()">{{ cancelLabel }}</button>
          <!-- Optional third action (e.g. "Leave without saving") — shown only
               when a label is provided. Styled as a neutral/ghost choice so the
               primary (confirm) stays the recommended path. -->
          <button *ngIf="tertiaryLabel" class="cd-btn cd-btn--ghost" (click)="onTertiary()">{{ tertiaryLabel }}</button>
          <button class="cd-btn" [class.cd-btn--danger]="danger" [class.cd-btn--primary]="!danger" (click)="onConfirm()" autofocus>
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './confirm-dialog.css',
})
export class ConfirmDialogComponent {
  @Input() title = 'Are you sure?';
  @Input() message = '';
  @Input() confirmLabel = 'Confirm';
  /** Label of the dismiss button. Set to '' for an acknowledgement-only dialog
   *  (single button); the backdrop still closes it via (cancelled). */
  @Input() cancelLabel = 'Cancel';
  /** Optional third action label (e.g. "Leave without saving"); hidden if unset. */
  @Input() tertiaryLabel = '';
  /**
   * Marks the action as destructive. Selects the ICON GLYPH only — a trash can rather
   * than a warning triangle — not a colour: every confirmation uses the same neutral
   * blue palette, because being asked to confirm is a normal step in editing, and red
   * reads as "something went wrong" (see confirm-dialog.css).
   */
  @Input() danger = false;

  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();
  @Output() tertiary = new EventEmitter<void>();

  onConfirm(): void { this.confirmed.emit(); }
  onCancel(): void { this.cancelled.emit(); }
  onTertiary(): void { this.tertiary.emit(); }
}
