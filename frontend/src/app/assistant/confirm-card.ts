import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { ConfirmRequest } from './models';
import { pretty, shortName } from './tool-format';

/**
 * Approve / reject card for a state-changing IRIS tool call. Rendered inline as
 * an overlay within the assistant panel (the docked-panel equivalent of the
 * original floating confirm modal). Emits the user's decision once.
 */
@Component({
  selector: 'app-confirm-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ax-modal ax-confirm" role="dialog" aria-modal="false">
      <div class="ax-modal__head">
        <span class="ax-modal__title">Approve SCO change</span>
        <span class="ax-modal__subtitle">This will modify the running instance.</span>
      </div>
      <div class="ax-modal__content">
        <p class="ax-confirm__summary">{{ req.summary }}</p>
        <div class="ax-confirm__tool">
          <span class="ax-confirm__toollabel">{{ short(req.toolName) }}</span>
          <pre class="ax-confirm__input">{{ prettyInput(req.input) }}</pre>
        </div>
        <div class="ax-modal__actions">
          <button class="ax-btn ax-btn--ghost" (click)="decide('reject')">Reject</button>
          <button class="ax-btn ax-btn--primary" (click)="decide('approve')" #approve>Approve</button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './assistant-modals.css',
})
export class ConfirmCardComponent {
  @Input({ required: true }) req!: ConfirmRequest;
  @Output() decision = new EventEmitter<'approve' | 'reject'>();

  private done = false;

  decide(d: 'approve' | 'reject'): void {
    if (this.done) return;
    this.done = true;
    this.decision.emit(d);
  }

  short(name: string): string {
    return shortName(name);
  }
  prettyInput(input: unknown): string {
    return pretty(input);
  }
}
