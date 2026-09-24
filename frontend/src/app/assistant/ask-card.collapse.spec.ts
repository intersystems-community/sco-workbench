import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AskCardComponent } from './ask-card';
import type { AskRequest } from './models';

/**
 * Collapsing the question card.
 *
 * The card floats over the chat, so the user needs to be able to tuck it away to read
 * what's underneath. The risks that matter are (a) losing answers already given — they
 * must live in the component, not the DOM — and (b) the card becoming a dead end: the
 * agent is BLOCKED waiting on this answer, so a collapsed card must still be findable,
 * cancellable, and must not submit anything the user can't see.
 */
function request(questionCount = 1): AskRequest {
  return {
    questions: Array.from({ length: questionCount }, (_, i) => ({
      header: `Q${i + 1}`,
      question: `Question ${i + 1}?`,
      multiSelect: false,
      options: [
        { label: 'First', description: 'the first option' },
        { label: 'Second' },
      ],
    })),
  } as AskRequest;
}

function setup(questionCount = 1) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [AskCardComponent] });
  const fixture: ComponentFixture<AskCardComponent> = TestBed.createComponent(AskCardComponent);
  fixture.componentInstance.req = request(questionCount);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

/** The card's rendered text, for asserting what is and isn't on screen. */
function text(fixture: ComponentFixture<AskCardComponent>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

/**
 * Click the header chevron, the way the user does. Driving it through the DOM (rather
 * than calling toggleCollapsed()) both exercises the real wiring and marks the view
 * dirty — this app is zoneless, so a plain field mutation alone would not re-render.
 */
function clickChevron(fixture: ComponentFixture<AskCardComponent>): void {
  const btn = (fixture.nativeElement as HTMLElement).querySelector(
    '[aria-label="Collapse question"], [aria-label="Expand question"]',
  ) as HTMLButtonElement | null;
  if (!btn) throw new Error('No collapse chevron found in the card header.');
  btn.click();
  fixture.detectChanges();
}

describe('AskCardComponent — collapse', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts expanded, showing the question and its options', () => {
    const { fixture, component } = setup();
    expect(component.collapsed).toBe(false);
    expect(text(fixture)).toContain('Question 1?');
    expect(text(fixture)).toContain('First');
  });

  it('collapses to the header: the question, options and actions come off screen', () => {
    const { fixture, component } = setup();

    clickChevron(fixture);

    expect(component.collapsed).toBe(true);
    const body = text(fixture);
    expect(body).not.toContain('Question 1?');
    expect(body).not.toContain('First');
    expect(body).not.toContain('Submit');
    // The header — and so the way back — is still there.
    expect(body).toContain('Question');
    expect(fixture.nativeElement.querySelector('.ax-ask--collapsed')).toBeTruthy();
  });

  it('re-expands, and KEEPS the answers given before collapsing', () => {
    // The whole point: the selection lives in `answers`, not in the DOM that *ngIf
    // tears down. Losing it would make collapsing destructive.
    const { fixture, component } = setup();
    component.toggle('First');
    component.answers[0]!.other = 'my own answer';

    clickChevron(fixture);
    clickChevron(fixture);

    expect(component.collapsed).toBe(false);
    expect(component.isSelected('First')).toBe(true);
    expect(component.answers[0]!.other).toBe('my own answer');
    expect(text(fixture)).toContain('Question 1?');
  });

  it('keeps the multi-question tab strip and the active tab across a collapse', () => {
    const { fixture, component } = setup(2);
    component.active = 1;
    component.toggle('Second');

    clickChevron(fixture);
    clickChevron(fixture);

    expect(component.active).toBe(1);
    expect(component.isSelected('Second')).toBe(true);
    expect(text(fixture)).toContain('Question 2?');
  });

  it('shows the answered count while collapsed, so a pending question is not forgotten', () => {
    const { fixture, component } = setup(2);
    component.toggle('First');

    clickChevron(fixture);

    expect(text(fixture).replace(/\s+/g, ' ')).toContain('1/2');
  });

  it('does not show that count for a single question — there is nothing to track', () => {
    const { fixture, component } = setup(1);
    clickChevron(fixture);
    expect(text(fixture)).not.toContain('1/1');
  });

  it('Esc still cancels while collapsed — the card must never be a dead end', () => {
    const { component } = setup();
    const cancelled = vi.fn();
    component.cancelled.subscribe(cancelled);
    component.toggleCollapsed();

    component.onKey(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('Enter EXPANDS while collapsed instead of advancing or submitting', () => {
    // Submitting an answer the user cannot see would be the worst outcome here.
    const { component } = setup();
    const answered = vi.fn();
    component.answered.subscribe(answered);
    component.toggle('First');
    component.toggleCollapsed();

    component.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(component.collapsed).toBe(false);
    expect(answered).not.toHaveBeenCalled();
  });

  it('Cmd+Enter does not submit from a collapsed card either', () => {
    const { component } = setup();
    const answered = vi.fn();
    component.answered.subscribe(answered);
    component.toggle('First');
    component.toggleCollapsed();

    component.onKey(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));

    expect(answered).not.toHaveBeenCalled();
    expect(component.collapsed).toBe(false);
  });

  it('submits normally once expanded again', () => {
    const { component } = setup();
    const answered = vi.fn();
    component.answered.subscribe(answered);
    component.toggle('First');
    component.toggleCollapsed();
    component.toggleCollapsed();

    component.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(answered).toHaveBeenCalledTimes(1);
    expect(answered.mock.calls[0]![0]).toEqual({ Q1: { selected: ['First'] } });
  });
});
