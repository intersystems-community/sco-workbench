import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ConfirmDialogComponent } from './confirm-dialog';

/**
 * The dialog is normally a two-way confirmation (Confirm / Cancel), but it also
 * serves as a one-way NOTICE — "Claude key not provided", OK. A blank
 * `cancelLabel` is what switches it: a second button that does exactly what OK does
 * only asks the user to choose between identical outcomes.
 */
function render(inputs: Partial<ConfirmDialogComponent>): ComponentFixture<ConfirmDialogComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ConfirmDialogComponent] });
  const fixture = TestBed.createComponent(ConfirmDialogComponent);
  Object.assign(fixture.componentInstance, inputs);
  fixture.detectChanges();
  return fixture;
}

function buttonLabels(fixture: ComponentFixture<ConfirmDialogComponent>): string[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button.cd-btn'))
    .map((b) => (b.textContent ?? '').trim());
}

describe('ConfirmDialogComponent', () => {
  it('shows a single button in acknowledgement mode', () => {
    const fixture = render({
      title: 'Claude key not provided',
      message: 'The AI assistant needs AWS Bedrock credentials.',
      confirmLabel: 'OK',
      cancelLabel: '',
    });

    expect(buttonLabels(fixture)).toEqual(['OK']);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.cd-title')!.textContent).toContain('Claude key not provided');
    expect(el.querySelector('.cd-message')!.textContent).toContain('AWS Bedrock credentials');
  });

  it('keeps Cancel for a normal confirmation', () => {
    // Regression guard: the acknowledgement mode is opt-in via a blank label, so
    // every existing confirm (delete a cube, discard edits) still has its way out.
    const fixture = render({ confirmLabel: 'Delete', danger: true });
    expect(buttonLabels(fixture)).toEqual(['Cancel', 'Delete']);
  });

  it('emits cancelled from the backdrop even with no Cancel button', () => {
    // Clicking outside is the only other exit in acknowledgement mode; the host
    // closes on (cancelled), so it has to fire.
    const fixture = render({ confirmLabel: 'OK', cancelLabel: '' });
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.cd-backdrop')!.click();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('emits confirmed from the single button', () => {
    const fixture = render({ confirmLabel: 'OK', cancelLabel: '' });
    const confirmed = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('button.cd-btn')!.click();

    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});
