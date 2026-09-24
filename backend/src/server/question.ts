import { randomUUID } from 'node:crypto';

/**
 * Human-in-the-loop question broker.
 *
 * The agent asks the user structured questions through the `ask_user_question`
 * tool (see tools/ask-tools.ts). That tool call blocks on this broker, which
 * emits an `ask_request` SSE event to the UI. The UI renders a tabbed popup
 * (one tab per question), collects the user's selections/text, and POSTs them
 * back to resolve the promise — mirroring how ConfirmationBroker gates
 * state-changing actions.
 *
 * This is the structured analogue of asking in plain chat text: it lets the
 * agent gather required inputs (a source class, an adapter type, yes/no choices)
 * with a real UI instead of a free-text turn the user has to parse.
 */

/** One option the user can pick for a question. */
export interface AskOption {
  /** Short display label shown on the button/list item. */
  label: string;
  /** Optional longer explanation of what choosing this means. */
  description?: string;
}

/** A single question, rendered as one tab in the popup. */
export interface AskQuestion {
  /** The full question text. */
  question: string;
  /** Very short chip/tab label (e.g. "Adapter", "Source class"). */
  header: string;
  /** Selectable options. The UI always also offers a free-text "Other". */
  options: AskOption[];
  /** Allow selecting more than one option (checkbox-style) instead of one. */
  multiSelect?: boolean;
}

/** The request emitted to the UI. */
export interface AskRequest {
  askId: string;
  questions: AskQuestion[];
}

/**
 * The user's answer to one question: the chosen option label(s), or free text
 * they typed via "Other". Keyed by the question's `header` in the answers map.
 */
export interface AskAnswer {
  /** Selected option labels (one, or many when multiSelect). */
  selected: string[];
  /** Free-text answer when the user chose "Other" / typed their own. */
  other?: string;
}

/** Answers keyed by each question's `header`. */
export type AskAnswers = Record<string, AskAnswer>;

interface Pending {
  resolve: (answers: AskAnswers | null) => void;
  request: AskRequest;
}

export interface AskEmitter {
  (req: AskRequest): void;
}

export class QuestionBroker {
  private pending = new Map<string, Pending>();

  constructor(private readonly emit: AskEmitter) {}

  /**
   * Ask the user a set of questions. Resolves with their answers, or `null` if
   * the turn is aborted (client disconnect) — the caller treats null as "no
   * answer, stop and let the user restate".
   */
  ask(questions: AskQuestion[]): Promise<AskAnswers | null> {
    const askId = randomUUID();
    const request: AskRequest = { askId, questions };
    return new Promise<AskAnswers | null>((resolve) => {
      this.pending.set(askId, { resolve, request });
      this.emit(request);
    });
  }

  /** Resolve a pending ask from the UI. Returns false if the id is unknown. */
  resolveAnswers(askId: string, answers: AskAnswers): boolean {
    const p = this.pending.get(askId);
    if (!p) return false;
    this.pending.delete(askId);
    p.resolve(answers);
    return true;
  }

  /**
   * Cancel a pending ask (the user dismissed the popup without answering).
   * Resolves it with `null`; the caller aborts the whole turn. Returns false
   * if the id is unknown.
   */
  cancel(askId: string): boolean {
    const p = this.pending.get(askId);
    if (!p) return false;
    this.pending.delete(askId);
    p.resolve(null);
    return true;
  }

  /** Abort all outstanding asks (e.g. on client disconnect) with a null answer. */
  cancelAll(): void {
    for (const [, p] of this.pending) p.resolve(null);
    this.pending.clear();
  }

  get outstanding(): number {
    return this.pending.size;
  }
}
