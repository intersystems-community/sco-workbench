import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { BiCubesComponent } from './bi-cubes';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';
import { ScModelService } from '../services/sc-model.service';
import { CubeService } from '../services/cube.service';
import { ToastService } from '../core/toast.service';
import { CUBE_INTRO_QUESTIONS, cubeQuestionPrompt } from './cube-intro-questions';
import { setAiEnabled } from '../core/ai-status';

/**
 * The Analytics Cube intro's "Learn the Concepts" questions. Each is a handoff to
 * the AI Assistant, and the pins that matter are about HOW it hands off:
 *  - it does NOT force Agent mode (these teach; they must not act on the user's
 *    behalf, and the product ships Guided-only), and
 *  - it does NOT start a fresh session (the answer joins the conversation the user
 *    already has, so they can follow up).
 * Both are what separates this from the Data Integration Deploy handoff, which
 * deliberately does the opposite of each.
 */
function setup() {
  TestBed.resetTestingModule();
  const scModel = { getObjects: vi.fn(() => of([])) };
  const cubes = {
    list: vi.fn(() => of({ cubes: [] })),
    sourceProperties: vi.fn(() => of({ className: '', properties: [] })),
  };
  const toasts = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
  TestBed.configureTestingModule({
    imports: [BiCubesComponent],
    providers: [
      { provide: ScModelService, useValue: scModel },
      { provide: CubeService, useValue: cubes },
      { provide: ToastService, useValue: toasts },
    ],
  });
  const fixture: ComponentFixture<BiCubesComponent> = TestBed.createComponent(BiCubesComponent);
  const bridge = TestBed.inject(WorkbenchBridgeService);
  fixture.detectChanges();
  return { fixture, bridge, component: fixture.componentInstance, toasts };
}

/** The rendered question buttons, in DOM order. */
function questionButtons(fixture: ComponentFixture<BiCubesComponent>): HTMLButtonElement[] {
  const host = fixture.nativeElement as HTMLElement;
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="cube-intro-questions"] .ac-question'));
}

describe('cube-intro-questions data', () => {
  it('offers exactly five questions with unique ids', () => {
    expect(CUBE_INTRO_QUESTIONS).toHaveLength(5);
    const ids = CUBE_INTRO_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('covers the vocabulary the create form asks the user for', () => {
    // The point of the set is that someone who reads all five can fill the form:
    // every term the cube form uses has to appear somewhere across the questions.
    const corpus = CUBE_INTRO_QUESTIONS.map((q) => `${q.question} ${q.concepts}`).join(' ').toLowerCase();
    for (const term of ['cube', 'dimension', 'hierarch', 'level', 'member', 'measure', 'aggregate', 'source class', 'mdx']) {
      expect(corpus, `missing concept: ${term}`).toContain(term);
    }
  });

  it('writes the questions with plain punctuation, no em dashes', () => {
    for (const q of CUBE_INTRO_QUESTIONS) {
      expect(q.question, `em dash in ${q.id}`).not.toContain('—');
    }
  });

  it('frames the sent prompt for SCO and forbids side effects', () => {
    const prompt = cubeQuestionPrompt(CUBE_INTRO_QUESTIONS[0]!);
    // The question itself leads, so the assistant answers what was clicked…
    expect(prompt.startsWith(CUBE_INTRO_QUESTIONS[0]!.question)).toBe(true);
    // …grounded in the product, and explicitly read-only: the user clicked to learn.
    expect(prompt).toContain('Supply Chain Orchestrator');
    expect(prompt).toContain('Do not change anything');
    // Never "IRIS" in anything the user can see (CLAUDE.md naming rule).
    expect(prompt).not.toContain('IRIS');
  });

  it('carries the concept terms in the prompt only', () => {
    // `concepts` steers the answer; it is not copy, so it must not leak into the
    // chat bubble (which is the question verbatim) — see the DOM pin below.
    const q = CUBE_INTRO_QUESTIONS[2]!;
    expect(cubeQuestionPrompt(q)).toContain(q.concepts);
  });
});

describe('BiCubes intro questions → assistant handoff', () => {
  afterEach(() => {
    setAiEnabled(true);
    TestBed.resetTestingModule();
  });

  it('renders one clickable button per question on the intro page', () => {
    const { fixture } = setup();
    const buttons = questionButtons(fixture);
    expect(buttons).toHaveLength(CUBE_INTRO_QUESTIONS.length);
    expect(buttons.map((b) => b.getAttribute('data-question-id'))).toEqual(
      CUBE_INTRO_QUESTIONS.map((q) => q.id),
    );
    // Real buttons, so they're keyboard-reachable and announced as actions.
    expect(buttons.every((b) => b.tagName === 'BUTTON')).toBe(true);
    expect(buttons[0]?.textContent).toContain(CUBE_INTRO_QUESTIONS[0]!.question);
  });

  it('renders the question as the row\'s only text, with no concept sub-line', () => {
    const { fixture } = setup();
    for (const [i, button] of questionButtons(fixture).entries()) {
      const q = CUBE_INTRO_QUESTIONS[i]!;
      // `concepts` is prompt framing, not copy — five rows of small grey terms just
      // stood between the reader and the questions.
      expect(button.textContent, `concepts leaked into ${q.id}`).not.toContain(q.concepts);
      // The visible text is the question and nothing else (the chevron is decorative).
      expect(button.querySelector('.ac-question__text')?.textContent?.trim()).toBe(q.question);
      expect(button.querySelector('.ac-question__covers')).toBeNull();
    }
  });

  it('clicking a question runs it in the CURRENT session and leaves the mode alone', () => {
    const { fixture, bridge } = setup();
    const seen: Array<{ prompt: string; displayText?: string; freshSession?: boolean }> = [];
    const sub = bridge.agentPrompts$.subscribe((req) => seen.push(req));

    questionButtons(fixture)[1]!.click();

    expect(seen).toHaveLength(1);
    const q = CUBE_INTRO_QUESTIONS[1]!;
    // The chat bubble shows the question; the framed prompt is what's sent.
    expect(seen[0]!.displayText).toBe(q.question);
    expect(seen[0]!.prompt).toBe(cubeQuestionPrompt(q));
    // NOT a fresh session — the answer joins the conversation the user has.
    expect(seen[0]!.freshSession).toBeUndefined();
    // NOT forced into Agent mode, unlike the Deploy handoff.
    expect(bridge.mode()).toBe('guided');
    sub.unsubscribe();
  });

  it('explains itself instead of asking an assistant that has no key', () => {
    const { fixture, bridge, toasts } = setup();
    setAiEnabled(false);
    const seen: unknown[] = [];
    const sub = bridge.agentPrompts$.subscribe((req) => seen.push(req));

    questionButtons(fixture)[0]!.click();

    // Nothing is handed off, and the user is told why rather than watching a dock
    // open onto a failure. The button stays enabled — see askConceptQuestion.
    expect(seen).toHaveLength(0);
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('Claude key not provided'));
    sub.unsubscribe();
  });
});
