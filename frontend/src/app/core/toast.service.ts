import { Injectable, signal } from '@angular/core';

/** A transient status message shown as a toast. */
export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  /** Stable id used to track/dismiss the toast. */
  id: number;
  kind: ToastKind;
  text: string;
}

/** Auto-dismiss timings (ms). Cautions and errors linger longer so they can be read. */
const DISMISS_MS: Record<ToastKind, number> = {
  success: 3000,
  info: 3000,
  warning: 5000,
  error: 6000,
};

/**
 * App-wide transient status messages ("toasts"/"snackbars"). A single host
 * component (see ToastHostComponent, mounted in the workbench shell) renders the
 * `toasts` signal; features just call `success` / `error` / `info` after an
 * action resolves.
 *
 * Each toast auto-dismisses after a kind-specific timeout (success/info ~3s,
 * error ~6s) and can be dismissed early. This is the modern pattern for
 * "operation running → succeeded/failed" feedback: the button shows an inline
 * spinner while in flight (owned by the feature), and the outcome is announced
 * here as a toast in an ARIA live region.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  /** Active toasts, newest last. The host renders these. */
  readonly toasts = signal<readonly Toast[]>([]);

  private nextId = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Show a success toast (auto-dismiss ~3s). */
  success(text: string): number {
    return this.show('success', text);
  }
  /** Show an error toast (auto-dismiss ~6s — longer so it can be read). */
  error(text: string): number {
    return this.show('error', text);
  }
  /** Show a neutral/info toast (auto-dismiss ~3s). */
  info(text: string): number {
    return this.show('info', text);
  }
  /** Show a caution toast (auto-dismiss ~5s) — an advisory, not a hard failure. */
  warning(text: string): number {
    return this.show('warning', text);
  }

  /** Add a toast and schedule its auto-dismiss. Returns its id. */
  show(kind: ToastKind, text: string): number {
    const id = this.nextId++;
    this.toasts.update((list) => [...list, { id, kind, text }]);
    const timer = setTimeout(() => this.dismiss(id), DISMISS_MS[kind]);
    this.timers.set(id, timer);
    return id;
  }

  /** Remove a toast now (user click or programmatic). Idempotent. */
  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
