// frontend/src/app/dashboard/confirm-dialog.ts
import {
  Component, ChangeDetectionStrategy, ElementRef, effect, input, output, viewChild,
} from '@angular/core';

/** What the dialog asks: a title, a message, and optional button labels. */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Defaults to "Delete" (the action is destructive by design — see the class comment). */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
}

/**
 * A small themed confirmation modal (redesign R5 / spec §12). With the
 * dashboard-level Discard removed (autosave, R4), deleting a tile is the one
 * destructive layout action that is not trivially reversible, so it asks first.
 * Mirrors the tile-editor's proven modal shape: a backdrop, `role="dialog"`/
 * `aria-modal`, focus moved in on open, an `Esc`-to-cancel handler and a minimal
 * Tab focus trap (spec §5, keyboard-first). Renders nothing when `open()` is null.
 *
 * Initial focus lands on Cancel — the safe default for a destructive confirm, so a
 * stray Enter does not delete. The confirm button is styled destructive (--db-danger)
 * so it reads as destructive in both themes.
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './confirm-dialog.css',
  template: `
    @if (open(); as o) {
      <div class="cd-backdrop" (click)="onCancel()">
        <div #dialog class="cd-modal" role="dialog" aria-modal="true"
             [attr.aria-label]="o.title" tabindex="-1"
             (click)="$event.stopPropagation()" (keydown)="onKeydown($event)">
          <h2 class="cd-title">{{ o.title }}</h2>
          <p class="cd-message">{{ o.message }}</p>
          <div class="cd-actions">
            <button #cancelBtn type="button" class="cd-btn cd-btn--ghost" data-testid="confirm-cancel"
                    (click)="onCancel()">{{ o.cancelLabel ?? 'Cancel' }}</button>
            <button type="button" class="cd-btn cd-btn--danger" data-testid="confirm-ok"
                    (click)="onConfirm()">{{ o.confirmLabel ?? 'Delete' }}</button>
          </div>
        </div>
      </div>
    }`,
})
export class ConfirmDialogComponent {
  /** Non-null opens the modal; null keeps it closed. */
  readonly open = input<ConfirmRequest | null>(null);
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly cancelBtn = viewChild<ElementRef<HTMLElement>>('cancelBtn');

  constructor() {
    // Focus the safe default (Cancel) once the dialog renders — destructive confirm.
    effect(() => {
      if (this.open() && this.cancelBtn()) this.cancelBtn()!.nativeElement.focus();
    });
  }

  onConfirm(): void { this.confirm.emit(); }
  onCancel(): void { this.cancel.emit(); }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onCancel();
      return;
    }
    if (event.key === 'Tab') this.trapTab(event);
  }

  /** Keep Tab focus within the dialog (a minimal, jsdom-tolerant focus trap; copied from tile-editor). */
  private trapTab(event: KeyboardEvent): void {
    const root = this.dialogEl()?.nativeElement;
    if (!root) return;
    const focusables = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusables.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = (root.ownerDocument.activeElement as HTMLElement) ?? null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
