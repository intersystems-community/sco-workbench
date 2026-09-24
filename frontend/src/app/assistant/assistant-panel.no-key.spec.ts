import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { AssistantPanelComponent } from './assistant-panel';
import { AssistantService } from './assistant.service';
import { setAiEnabled, AI_KEY_MISSING_PLACEHOLDER } from '../core/ai-status';

/** The backend's invalid-credentials message (the wording itself lives in backend
 *  ai-errors.ts; the panel only has to render whatever arrives). */
const REJECTED = 'Invalid credentials provided for Claude. Please use the correct credentials and restart the server to use the AI features.';

/**
 * The chat panel with no Claude key on the backend.
 *
 * The workbench itself doesn't need an LLM, so the panel still opens — it just has
 * to say why it can't answer INSTEAD of accepting a message and failing after the
 * send. The composer's placeholder is the notice, and the input/send are inert so
 * nobody types a paragraph into a box that will throw it away.
 *
 * The separate case — a key that IS configured but gets rejected — is invisible
 * until a turn runs, so it arrives as an SSE `error` event; the last test pins that
 * the panel shows that message (the backend's invalid-credentials explanation) in
 * the transcript.
 */
function setup() {
  const chat = vi.fn(() => new Subject<{ event: string; data: Record<string, unknown> }>());
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AssistantPanelComponent],
    providers: [
      { provide: AssistantService, useValue: { listSessions: vi.fn(async () => []), chat } },
    ],
  });
  const fixture = TestBed.createComponent(AssistantPanelComponent);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return {
    fixture,
    chat,
    component: fixture.componentInstance,
    textarea: el.querySelector('textarea.ax-composer__input') as HTMLTextAreaElement,
    sendBtn: el.querySelector('button.ax-send') as HTMLButtonElement,
    el,
  };
}

describe('AssistantPanelComponent — no Claude key', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setAiEnabled(false); // must be set BEFORE construction: the component reads it once
  });
  afterEach(() => {
    vi.useRealTimers();
    setAiEnabled(true);
  });

  it('shows "Claude key not provided" in the input box', () => {
    const { textarea, component } = setup();
    expect(component.composerPlaceholder).toBe(AI_KEY_MISSING_PLACEHOLDER);
    expect(textarea.placeholder).toBe('Claude key not provided');
  });

  it('does not run the typewriter over the notice', () => {
    // The animated "Ask the assistant to …" placeholder would overwrite the notice
    // one character at a time, which is how a user ends up never seeing it.
    const { textarea, component } = setup();
    vi.advanceTimersByTime(10_000);
    expect(component.composerPlaceholder).toBe(AI_KEY_MISSING_PLACEHOLDER);
    expect(textarea.placeholder).toBe(AI_KEY_MISSING_PLACEHOLDER);
  });

  it('disables the input and the send button, and says why on hover', async () => {
    const { textarea, sendBtn } = setup();
    // NgModel owns the `disabled` input on the textarea and applies it through the
    // value accessor on a microtask, so let that settle before reading the DOM.
    await Promise.resolve();
    expect(textarea.disabled).toBe(true);
    expect(sendBtn.disabled).toBe(true);
    // Provider-neutral: the workbench supports five Claude providers, so the
    // tooltip must point at the SELECTOR rather than at one provider's credentials
    // — naming AWS to an operator configuring Vertex or Foundry sends them to fix
    // the wrong thing.
    expect(textarea.getAttribute('title')).toMatch(/Claude provider/i);
    expect(textarea.getAttribute('title')).toMatch(/CLAUDE_PROVIDER/);
    expect(textarea.getAttribute('title')).not.toMatch(/Bedrock/i);
    expect(sendBtn.title).toBe('Claude key not provided');
  });

  it('send() starts no turn even when the disabled attribute is bypassed', () => {
    // Enter in the textarea and a form submit both reach send() directly, so the
    // guard has to be in the method too — not only in the template.
    const { component, chat } = setup();
    component.input = 'hello?';
    component.send();

    expect(chat).not.toHaveBeenCalled();
    expect(component.streaming()).toBe(false);
    // The text stays put: a discarded message the user has to retype is worse
    // than a message that was never accepted.
    expect(component.input).toBe('hello?');
    expect(component.turns()).toHaveLength(0);
  });

  it('still renders the transcript and the mode picker', () => {
    // Degrading must not blank the panel — history and settings stay reachable.
    const { el } = setup();
    expect(el.querySelector('.ax-messages')).toBeTruthy();
    expect(el.querySelector('.ax-mode-picker__btn')).toBeTruthy();
  });
});

describe('AssistantPanelComponent — key present', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setAiEnabled(true);
  });
  afterEach(() => vi.useRealTimers());

  it('leaves the composer usable', async () => {
    const { textarea, sendBtn, component, fixture } = setup();
    await Promise.resolve(); // let NgModel apply its disabled state (see above)
    expect(textarea.disabled).toBe(false);
    expect(component.composerPlaceholder).not.toBe(AI_KEY_MISSING_PLACEHOLDER);
    expect(textarea.getAttribute('title')).toBeNull();

    component.input = 'list my cubes';
    // detectChanges(false): skip the dev-mode verification pass. The animated
    // placeholder legitimately changes between the two passes (its typewriter runs
    // on its own timer), which is not what this test is about.
    fixture.detectChanges(false);
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.title).toBe('Send');
  });

  it('renders the backend\'s invalid-credentials answer in the transcript', () => {
    // A configured-but-rejected key only shows up mid-turn: the backend classifies
    // the failure and sends it as an SSE error event. The panel must surface that
    // text, not a generic "something went wrong".
    const { component, chat, fixture } = setup();
    component.input = 'hello?';
    component.send();
    const stream = chat.mock.results[0]!.value as Subject<{ event: string; data: Record<string, unknown> }>;

    stream.next({ event: 'error', data: { message: REJECTED } });
    stream.complete();
    fixture.detectChanges();

    const items = component.turns().flatMap((t) => t.items);
    expect(items.some((i) => i.kind === 'error' && (i as { text: string }).text === REJECTED)).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Invalid credentials provided for Claude');
    expect(component.streaming()).toBe(false);
  });
});
