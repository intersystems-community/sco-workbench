import { randomUUID } from 'node:crypto';

/**
 * UI-control broker for Guided mode.
 *
 * In Guided mode the assistant does NOT touch IRIS. Instead it drives the
 * Angular workbench UI — navigating to a feature page, opening a form,
 * pre-filling a field, or highlighting an element — so it can teach the user by
 * doing it *with* them. Each UI-directive tool (see tools/ui-tools.ts) calls
 * this broker, which emits a `ui_directive` SSE event to the frontend.
 *
 * The broker BLOCKS until the frontend acknowledges the directive was applied
 * (POST /api/agent/ui-ack), mirroring the ConfirmationBroker/QuestionBroker.
 * This matters because the model chains steps — e.g. navigate → open form →
 * set field: if navigate returned before the page actually switched, the model
 * would race ahead (setting fields on a form that isn't mounted, or telling the
 * user "you're now on the Cubes page" before they are). Awaiting the ack keeps
 * the tool sequence in lockstep with the real UI.
 */

/**
 * The kinds of UI actions the assistant can request.
 *  - navigate/open_form/set_field/highlight — **Guided mode**: drive the form.
 *  - report_status — **Agent mode**: report a create/deploy/delete step's REAL
 *    outcome back to the workbench so a feature's status reflects the truth
 *    (not an optimistic guess). This is the only UI action available in Agent mode.
 */
export type UiDirectiveAction =
  | 'navigate'
  | 'open_form'
  | 'open_entity'
  | 'set_field'
  | 'highlight'
  | 'report_status';

/** A single UI directive emitted to the frontend. */
export interface UiDirective {
  action: UiDirectiveAction;
  /**
   * The directive target:
   *  - navigate/open_form → a feature key ('bi-cubes' | 'kpi' | ...)
   *  - set_field/highlight → a field path within the active form ('name',
   *    'dimensions.0.name', 'kpiConditions.0', ...)
   *  - report_status → the id of the entity whose status is being reported
   *    (e.g. a data-integration pipeline id).
   */
  target: string;
  /**
   * The payload:
   *  - set_field → the value to set.
   *  - navigate → optional `{ onUnsaved: 'save'|'discard' }` — how to resolve the
   *    CURRENT page's unsaved edits so the switch can proceed.
   *  - open_form → optional `{ formKind?, onUnsaved? }` (data-model create-form
   *    selector; unsaved-edits disposition as above).
   *  - open_entity → `{ name, formKind?, mode?, onUnsaved? }` — the existing entity
   *    to land on (a data-model object to select, or a saved KPI/cube draft to
   *    reopen), plus the unsaved-edits disposition.
   *  - report_status → `{ phase: 'created'|'deployed'|'deleted', ok: boolean,
   *    detail?: string }` — the phase reached and whether it succeeded.
   */
  value?: unknown;
}

/** The directive plus its correlation id, as emitted to the UI. */
export interface UiDirectiveRequest extends UiDirective {
  directiveId: string;
}

export interface UiDirectiveEmitter {
  (request: UiDirectiveRequest): void;
}

/**
 * What the frontend reports back when it acks a directive. For `set_field` this
 * says whether the value actually landed in the form (a select/checkbox value
 * that doesn't match any option can't be applied), so the tool — and therefore
 * the assistant — reports the truth instead of a blind success.
 */
export interface UiAckResult {
  applied: boolean;
  detail?: string;
}

interface Pending {
  resolve: (result: UiAckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long to wait for the frontend ack before giving up and continuing. */
const ACK_TIMEOUT_MS = 8000;

export class UiControlBroker {
  private pending = new Map<string, Pending>();

  constructor(private readonly emit: UiDirectiveEmitter) {}

  /**
   * Emit a UI directive and wait until the frontend acknowledges it applied
   * (or a short timeout elapses, so a dropped ack never wedges the turn). On a
   * lost/timed-out ack it resolves applied:false — a VISIBLE failure the tool
   * surfaces to the agent — instead of an ambiguous empty result.
   */
  send(directive: UiDirective): Promise<UiAckResult> {
    const directiveId = randomUUID();
    return new Promise<UiAckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(directiveId);
        resolve({ applied: false, detail: 'no ack within 8000ms' });
      }, ACK_TIMEOUT_MS);
      this.pending.set(directiveId, { resolve, timer });
      this.emit({ directiveId, ...directive });
    });
  }

  /** Resolve a pending directive from the UI's ack. False if id is unknown. */
  ack(directiveId: string, result: UiAckResult): boolean {
    const p = this.pending.get(directiveId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(directiveId);
    p.resolve(result);
    return true;
  }

  /** Resolve all outstanding directives (e.g. on client disconnect). */
  ackAll(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ applied: false, detail: 'client disconnected before ack' });
    }
    this.pending.clear();
  }
}
