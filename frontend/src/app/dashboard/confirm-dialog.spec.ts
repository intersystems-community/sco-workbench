// frontend/src/app/dashboard/confirm-dialog.spec.ts
import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfirmDialogComponent, type ConfirmRequest } from './confirm-dialog';

@Component({
  standalone: true,
  imports: [ConfirmDialogComponent],
  template: `<app-confirm-dialog [open]="req()" (confirm)="onConfirm()" (cancel)="onCancel()" />`,
})
class Host {
  readonly req = signal<ConfirmRequest | null>(null);
  confirmed = 0;
  cancelled = 0;
  onConfirm(): void { this.confirmed += 1; }
  onCancel(): void { this.cancelled += 1; }
  readonly dlg = viewChild.required(ConfirmDialogComponent);
}

function host() {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ConfirmDialogComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing when closed', () => {
    const { el } = host();
    expect(el.querySelector('[role="dialog"]')).toBeFalsy();
  });

  it('shows the title + message when open, with role=dialog and aria-modal', () => {
    const { fixture, el } = host();
    fixture.componentInstance.req.set({ title: 'Delete tile?', message: 'This removes the tile.' });
    fixture.detectChanges();
    const dlg = el.querySelector('[role="dialog"]');
    expect(dlg).toBeTruthy();
    expect(dlg!.getAttribute('aria-modal')).toBe('true');
    expect(el.textContent).toContain('Delete tile?');
    expect(el.textContent).toContain('This removes the tile.');
  });

  it('uses the default Delete / Cancel labels, or the overrides when given', () => {
    const { fixture, el } = host();
    fixture.componentInstance.req.set({ title: 't', message: 'm' });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="confirm-ok"]')?.textContent?.trim()).toBe('Delete');
    expect(el.querySelector('[data-testid="confirm-cancel"]')?.textContent?.trim()).toBe('Cancel');

    fixture.componentInstance.req.set({ title: 't', message: 'm', confirmLabel: 'Remove it', cancelLabel: 'Keep it' });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="confirm-ok"]')?.textContent?.trim()).toBe('Remove it');
    expect(el.querySelector('[data-testid="confirm-cancel"]')?.textContent?.trim()).toBe('Keep it');
  });

  it('emits confirm from the confirm button', () => {
    const { fixture, el } = host();
    fixture.componentInstance.req.set({ title: 't', message: 'm' });
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="confirm-ok"]')!.click();
    expect(fixture.componentInstance.confirmed).toBe(1);
    expect(fixture.componentInstance.cancelled).toBe(0);
  });

  it('emits cancel from the Cancel button, the backdrop, and Escape', () => {
    const { fixture, el } = host();
    fixture.componentInstance.req.set({ title: 't', message: 'm' });
    fixture.detectChanges();

    el.querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!.click();
    expect(fixture.componentInstance.cancelled).toBe(1);

    // Backdrop click (the overlay itself, not the dialog) cancels.
    el.querySelector<HTMLElement>('.cd-backdrop')!.click();
    expect(fixture.componentInstance.cancelled).toBe(2);

    // Escape on the dialog cancels.
    el.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fixture.componentInstance.cancelled).toBe(3);
  });

  it('a click INSIDE the dialog does not cancel (backdrop handler is stopped)', () => {
    const { fixture, el } = host();
    fixture.componentInstance.req.set({ title: 't', message: 'm' });
    fixture.detectChanges();
    el.querySelector<HTMLElement>('[role="dialog"]')!.click();
    expect(fixture.componentInstance.cancelled).toBe(0);
    expect(fixture.componentInstance.confirmed).toBe(0);
  });
});
