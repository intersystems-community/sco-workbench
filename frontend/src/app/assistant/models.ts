/**
 * Shared types for the embedded SCO Workbench AI assistant.
 *
 * These mirror the backend's SSE contract (see backend/src/server/sse.ts) and the
 * persisted per-turn timeline (TurnEvent). Ported from the original standalone
 * chat UI into the Angular workbench.
 */

/** A raw Server-Sent Event decoded from the /api/agent/chat stream. */
export interface SseEvent {
  event: string;
  data: any;
}

/** Persisted per-turn timeline event (mirrors the backend TurnEvent). */
export type TurnEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; name: string; input: unknown; ok?: boolean; output?: string; id?: string }
  | { t: 'result'; text: string };

/** A single option in an ask_user_question prompt. */
export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskRequest {
  sessionId: string;
  askId: string;
  questions: AskQuestion[];
}

/** Per-question answer: chosen option labels, plus optional free-text. */
export interface AskAnswer {
  selected: string[];
  other?: string;
}

/** A state-changing tool call awaiting the user's approval. */
export interface ConfirmRequest {
  sessionId: string;
  confirmId: string;
  toolName: string;
  summary: string;
  input: any;
}

/** A Guided-mode UI directive streamed from the backend (mirrors UiDirective). */
export interface UiDirective {
  sessionId: string;
  /** Correlation id — the frontend POSTs this back once the directive is applied. */
  directiveId: string;
  action: 'navigate' | 'open_form' | 'set_field' | 'highlight' | 'report_status';
  target: string;
  value?: unknown;
}

/** A chat session summary as returned by /api/sessions. */
export interface SessionSummary {
  id: string;
  title: string;
}

/** Backend health snapshot from /healthz. */
export interface HealthStatus {
  ok: boolean;
  namespace?: string;
  atelier?: string;
}

// ---------- UI-side timeline model (the rendered turn) ----------

/** Status dot styles used across the timeline. */
export type DotKind = 'muted' | 'run' | 'ok' | 'err';

/** A rendered timeline item within an assistant turn. */
export type UiItem =
  | { kind: 'text'; raw: string; dot: 'muted' | 'ok' }
  | {
      kind: 'step';
      /** Underlying tool/skill name (e.g. mcp__sco__sco_compile_class or "Skill"). */
      name: string;
      /** Human label shown on the row (e.g. "Compiling SC.Data.Customer"). */
      label: string;
      /** Short name shown in the details disclosure toggle. */
      toolName: string;
      isSkill: boolean;
      input: unknown;
      status: 'running' | 'done' | 'error';
      summary?: string;
      output?: string;
      expanded: boolean;
    }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

/** A rendered chat turn — a right-aligned user bubble or an assistant timeline. */
export interface UiTurn {
  id: number;
  role: 'user' | 'assistant';
  /** For user turns: the message text. */
  text?: string;
  /** For assistant turns: the ordered timeline items. */
  items: UiItem[];
  /** Whether the working indicator is showing (assistant turns only). */
  thinking: boolean;
}
