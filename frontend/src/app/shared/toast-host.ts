import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../core/toast.service';

/**
 * Renders the app's transient status toasts (from ToastService) as a fixed stack
 * in the bottom-right corner. Mounted once in the workbench shell.
 *
 * Accessibility: the container is an ARIA live region so screen readers announce
 * new toasts. Success/info use `role="status"` (polite); errors use
 * `role="alert"` (assertive) so failures are surfaced promptly.
 *
 * Toasts auto-dismiss on a timer in the service; clicking one (or its ✕) removes
 * it early. Purely presentational — it only reads the signal and calls dismiss.
 */
@Component({
  selector: 'app-toast-host',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" aria-live="polite" aria-relevant="additions">
      <div
        *ngFor="let t of toasts.toasts()"
        class="toast toast--{{ t.kind }}"
        [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        (click)="toasts.dismiss(t.id)"
      >
        <span class="toast-icon" aria-hidden="true">
          <svg *ngIf="t.kind === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <svg *ngIf="t.kind === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <svg *ngIf="t.kind === 'info'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <svg *ngIf="t.kind === 'warning'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </span>
        <span class="toast-text">{{ t.text }}</span>
        <button class="toast-close" type="button" aria-label="Dismiss" (click)="$event.stopPropagation(); toasts.dismiss(t.id)">✕</button>
      </div>
    </div>
  `,
  styles: [`
    .toast-stack {
      position: fixed;
      top: 20px;
      /* Sit in the top-right corner, but when the assistant dock is open shift
         left by its width so toasts land just LEFT of the panel instead of on
         top of it. The shell sets --toast-offset to the dock width when open,
         0 when closed (inherited here even though we're position:fixed). */
      right: calc(20px + var(--toast-offset, 0px));
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: min(400px, calc(100vw - 40px - var(--toast-offset, 0px)));
      pointer-events: none;
      transition: right 0.16s ease;
    }
    .toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 11px 12px 11px 14px;
      border-radius: 10px;
      background: #ffffff;
      border: 1px solid #e0e0e0;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
      font-size: 13px;
      line-height: 1.4;
      color: #1d1d1f;
      cursor: pointer;
      border-left: 4px solid #8a8a8f;
      animation: toast-in 0.18s ease-out;
    }
    .toast--success { border-left-color: #2e7d32; }
    .toast--error   { border-left-color: #cf222e; }
    .toast--info    { border-left-color: #0066cc; }
    .toast--warning { border-left-color: #b26a00; }

    .toast-icon { flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; }
    .toast-icon svg { width: 18px; height: 18px; display: block; }
    .toast--success .toast-icon { color: #2e7d32; }
    .toast--error .toast-icon { color: #cf222e; }
    .toast--info .toast-icon { color: #0066cc; }
    .toast--warning .toast-icon { color: #b26a00; }

    .toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-word; white-space: pre-line; }

    .toast-close {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #999;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .toast-close:hover { color: #1d1d1f; background: #f0f0f0; }

    @keyframes toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast { animation: none; }
    }
  `],
})
export class ToastHostComponent {
  readonly toasts = inject(ToastService);
}
