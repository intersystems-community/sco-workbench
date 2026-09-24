import { Injectable, signal, computed } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Shared control channel between the AI assistant and the workbench UI.
 *
 * The workbench has no per-feature router — `WorkbenchComponent` swaps features
 * via an `activeView` string — and the feature form components are otherwise
 * isolated (no @Input/@Output). This root singleton is the seam that lets:
 *   - the assistant learn the current UI state (page + active form snapshot), and
 *   - Guided mode drive the UI (navigate, open a form, pre-fill a field, highlight)
 *     via `ui_directive` events streamed from the backend.
 *
 * Nothing here talks to the network; it only coordinates in-app state.
 */

/** The assistant's operating mode (mirrors the backend AssistantMode). */
export type AssistantMode = 'agent' | 'guided';

/** Feature keys — mirror WorkbenchComponent.activeView. */
export type FeatureKey =
  | 'introduction'
  | 'dashboard'
  | 'data-model'
  | 'data-integration'
  | 'bi-cubes'
  | 'kpi'
  | 'business-process'
  | 'others'
  | 'issue-management'
  | 'load-sample-data';

/**
 * Friendly, human-readable label for each feature view. Single source of truth:
 * WorkbenchComponent.navItems derives its labels from here, and the assistant
 * dock context badge shows FEATURE_LABELS[activeView]. Record<FeatureKey,string>
 * is exhaustive — adding a FeatureKey without a label is a compile error.
 */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  'introduction':     'Introduction',
  'dashboard':        'Dashboard',
  'data-model':       'Data Model',
  'data-integration': 'Data Integration',
  'bi-cubes':         'Analytics Cube',
  'kpi':              'Business KPI',
  'business-process': 'Business Process',
  'others':           'Others',
  'issue-management': 'Issue Management',
  'load-sample-data': 'Load sample data',
};

/**
 * One page of the workbench, as the sidebar ACTUALLY renders it. The shell
 * registers these at runtime (`setPages`) by flattening its own nav, and the
 * assistant is told about them in every turn's UI CONTEXT — so a page added to or
 * removed from the sidebar changes what the assistant knows about and can
 * navigate to, with no second list (backend enum, prompt text) to keep in step.
 */
export interface WorkbenchPage {
  /** The `ui_navigate` / `ui_open_form` feature key. */
  key: FeatureKey;
  label: string;
  /** Sidebar group heading this page sits under, when it has one. */
  group?: string;
  /** False where the assistant dock cannot stay open (the Dashboard, SC-2685). */
  assistantAvailable: boolean;
}

/** Every page the workbench knows how to render, labelled — the fallback catalog
 *  for before the shell has registered the nav it renders. FEATURE_LABELS is
 *  exhaustive over FeatureKey, so this cannot drift from the feature keys. */
function allKnownPages(): WorkbenchPage[] {
  return (Object.keys(FEATURE_LABELS) as FeatureKey[]).map((key) => ({
    key,
    label: FEATURE_LABELS[key],
    assistantAvailable: true,
  }));
}

/** One `availablePages` line for the UI CONTEXT block. */
function formatPage(p: WorkbenchPage): string {
  const notes = [
    p.group ? `under "${p.group}"` : '',
    p.assistantAvailable ? '' : 'the assistant panel closes on this page',
  ].filter(Boolean);
  return `- ${p.key} — ${p.label}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * A programmatic agent-run request from a feature button (e.g. Data Integration
 * Deploy). `prompt` is the full instruction SENT to the backend; `displayText`,
 * if set, is the friendly one-liner shown in the chat instead of the raw prompt.
 * `freshSession`, when true, starts the prompt in a BRAND-NEW chat session rather
 * than continuing the current one — so each Deploy is isolated (its own clean
 * context, not polluted by, or polluting, a prior conversation).
 */
export interface AgentPromptRequest {
  prompt: string;
  displayText?: string;
  freshSession?: boolean;
}

/** A UI directive emitted by the backend (mirrors the backend UiDirective). */
export interface UiDirective {
  action: 'navigate' | 'open_form' | 'open_entity' | 'set_field' | 'highlight' | 'report_status';
  target: string;
  value?: unknown;
}

/** Lifecycle phase an agent reports back for an entity via `ui_report_status`. */
export type StatusPhase = 'created' | 'deployed' | 'deleted';

/**
 * A status report from the agent (Agent mode). The agent calls `ui_report_status`
 * after finishing/failing a create/deploy/delete step a UI button handed it, so a
 * feature can set its badge from the REAL outcome instead of guessing optimistically.
 */
export interface StatusReport {
  /** The entity id whose status changed (e.g. a data-integration pipeline id). */
  id: string;
  phase: StatusPhase;
  ok: boolean;
  detail?: string;
}

/**
 * Result of applying a `set_field` directive: whether the value actually landed
 * in the form. A select/checkbox value that matches no option can't be applied,
 * and we report that back so the assistant doesn't claim success falsely.
 */
export interface SetFieldResult {
  applied: boolean;
  detail?: string;
}

/**
 * A feature component (cube / KPI) registers one of these so Guided mode can
 * drive its form. All methods are no-ops if the feature isn't currently mounted.
 */
export interface GuidedFormController {
  feature: FeatureKey;
  /**
   * Open the empty "new" create form. `opts.formKind` lets a feature with more
   * than one create form pick which to open (data-model: "object" vs
   * "attribute"); features with a single form ignore it.
   */
  openNewForm(opts?: { formKind?: string }): void;
  /**
   * Land on an EXISTING entity by name (the assistant navigated here to return to
   * or work on something specific), rather than opening a fresh "new" form:
   *  - data-model: select the object `name` and, when `opts.formKind === 'attribute'`,
   *    open its Add Custom Attribute form.
   *  - kpi / bi-cubes: reopen the user's SAVED DRAFT named `name` in edit mode.
   * Loading the entity may be async (the feature just remounted and is fetching its
   * list), so this returns a Promise. It resolves to `{ applied:false, detail }` when
   * no such entity/saved-draft exists — the feature never fabricates or auto-saves
   * one. A feature with no addressable entity can omit this.
   */
  openEntity?(name: string, opts?: { formKind?: string; mode?: 'view' | 'edit' }): Promise<SetFieldResult>;
  /**
   * The item this page currently has OPEN, as an opaque URL token — a name, an id,
   * or whatever string the page needs to find its way back — or null when it is
   * showing its overview/list instead of one item.
   *
   * The shell READS this (it is never pushed) and mirrors it into the `?item=`
   * query param, so a browser refresh comes back to the item on screen instead of
   * the overview. Reading it means the URL cannot drift from the real selection:
   * there is no "…and also tell the bridge" step to forget at a new call site.
   * The token's format is the page's own business — only its own `restoreItem`
   * parses it. A page with no item detail (Dashboard, Introduction) omits both.
   */
  currentItem?(): string | null;
  /**
   * Re-open the item a `?item=` token names, on a page that has just loaded (the
   * shell calls this once, after the page mounts). Resolve `false` when the token
   * names something that no longer exists — the shell then drops it from the URL
   * and leaves the overview on screen. A stale link is not a user-facing error, so
   * don't toast or throw for one.
   */
  restoreItem?(token: string): Promise<boolean>;
  /**
   * Read-only: does the open form have UNSAVED edits that would trigger the
   * "Save draft / Leave / Keep editing" leave dialog? Distinct from `canLeave`,
   * which has the side effect of SHOWING that dialog — this just reports the
   * state so the assistant can refuse to navigate away (and tell the user to save
   * a draft first) instead of firing a navigate that the guard will block. A
   * feature with no unsaved-edits concept can omit it (treated as "no").
   */
  hasUnsavedEdits?(): boolean;
  /**
   * Resolve the open form's unsaved edits ON THE USER'S BEHALF so a guided
   * navigation can proceed — the assistant asks the user "save or discard?", then
   * calls this instead of leaving the user to click the leave dialog themselves:
   *  - `'save'` persists the current form as a draft (same as the Save-draft
   *    button). Resolves `{ applied:false, detail }` if it can't (e.g. the form
   *    has no name yet, or the save request failed) so the assistant can ask.
   *  - `'discard'` drops the edits so the pending navigation isn't blocked.
   * After a successful resolve the form is no longer dirty, so the subsequent
   * view switch (and its leave-guard) passes cleanly. A feature with no
   * unsaved-edits concept can omit it.
   */
  resolveUnsaved?(disposition: 'save' | 'discard'): Promise<SetFieldResult>;
  /**
   * Resolve once this feature's LIST data has finished loading (its initial fetch
   * settled). Used right after a guided navigate so the tool can hand the freshly
   * loaded list back to the assistant IN THE SAME TURN — otherwise the assistant
   * lands on a page whose list is still loading and stalls waiting for a next turn
   * that never comes. A feature with no async list can omit it (treated as ready).
   */
  whenListReady?(): Promise<void>;
  /**
   * Set one field by dotted path (e.g. "name", "dimensions.0.name"). May return a
   * Promise when applying the value needs an async step first — e.g. the cube
   * form waits for the source class's property list to load before validating a
   * `sourceProperty` against it, so a value set right after the source class
   * isn't rejected/dropped by a race.
   */
  setField(path: string, value: unknown): SetFieldResult | Promise<SetFieldResult>;
  /** Visually highlight a field/button by path or id. */
  highlight(target: string): void;
  /** A compact map of the form's fields → filled value or empty marker. */
  snapshot(): Record<string, unknown>;
  /**
   * Guard an attempt to navigate AWAY from this feature (sidebar click, guided
   * navigate). Return true to allow the switch immediately. Return false to BLOCK
   * it and take over — the component shows its own "Save draft / Leave / Keep
   * editing" dialog and, if the user chooses to leave, calls the provided
   * `proceed` callback to perform the deferred navigation. Optional: a feature
   * with no unsaved-edits concept can omit it (treated as "always allow").
   */
  canLeave?(proceed: () => void): boolean;
}

/**
 * Render one snapshot value for the UI-context block. Empty scalars become
 * "(empty)"; arrays and objects are JSON-encoded in full (empty arrays as "[]")
 * so nested conditions/dimensions reach the assistant verbatim rather than as a
 * bare count.
 */
function formatSnapshotValue(v: unknown): string {
  if (v === '' || v === null || v === undefined) return '(empty)';
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : '[]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

@Injectable({ providedIn: 'root' })
export class WorkbenchBridgeService {
  /** Active assistant mode; the composer picker writes it, the panel reads it per turn. Defaults to Guided (teach-first). */
  readonly mode = signal<AssistantMode>('guided');

  /**
   * The active chat session id, held here (in a root singleton) rather than on
   * the panel, so the conversation SURVIVES the panel being destroyed/recreated
   * — e.g. when the user closes and reopens the docked chat, or navigates
   * around. Cleared only by "New chat". null = a fresh, unsaved session.
   */
  readonly currentSessionId = signal<string | null>(null);

  /** Current feature page; the workbench binds its activeView to this. */
  readonly activeView = signal<FeatureKey>('introduction');

  /**
   * The workbench's LIVE page list, registered by the shell from the nav it
   * renders (see WorkbenchComponent.ngOnInit). The assistant reads it out of the
   * per-turn UI CONTEXT and every guided navigation is validated against it, so
   * the set of pages is discovered at runtime rather than hardcoded anywhere.
   */
  readonly pages = signal<readonly WorkbenchPage[]>([]);

  /** The shell publishes the nav it renders. Copied, so callers can't mutate it. */
  setPages(pages: readonly WorkbenchPage[]): void {
    this.pages.set([...pages]);
  }

  /**
   * The pages the assistant is told about. Registered nav when the shell has
   * published it; otherwise every page the app can render — so the assistant is
   * never told the workbench has no pages at all (e.g. a test or a first turn
   * that lands before the shell's ngOnInit).
   */
  private pageCatalog(): readonly WorkbenchPage[] {
    const registered = this.pages();
    return registered.length ? registered : allKnownPages();
  }

  /**
   * Resolve a directive's page key against the live catalog. Returns the page, or
   * a failure the assistant can act on — carrying the REAL page list, so a bad
   * key (a stale name it remembered, a page that has since been removed) teaches
   * it what exists instead of silently switching to a view that renders nothing.
   */
  private resolvePage(target: string): { page: WorkbenchPage } | { error: SetFieldResult } {
    const catalog = this.pageCatalog();
    const page = catalog.find((p) => p.key === target);
    if (page) return { page };
    const list = catalog.map((p) => `${p.key} ("${p.label}")`).join(', ');
    return {
      error: {
        applied: false,
        detail:
          `There is no workbench page with the key "${target}". The pages that exist right now are: ${list}. ` +
          `Use one of those keys (they are also listed in every turn's UI CONTEXT under availablePages) — do not ` +
          `guess a key or tell the user about a page that is not in that list.`,
      },
    };
  }

  /**
   * Friendly label of the current feature page, derived from activeView. The
   * assistant dock badge binds to this so it updates on every view switch
   * (sidebar, guided, agent-driven) with no extra wiring.
   */
  readonly activeViewLabel = computed(() => FEATURE_LABELS[this.activeView()]);

  /**
   * Entity ids with an in-flight agent lifecycle step (e.g. a Data Integration
   * pipeline being deployed). Held HERE, in the root singleton, so the pending
   * state SURVIVES the feature component being destroyed/recreated when the user
   * navigates to another page and back — otherwise the spinner/disabled-Deploy
   * would vanish while the deploy is still running. Cleared by a real status
   * report or a turn-ended-without-report (see the assistant panel / feature).
   */
  readonly pendingDeploys = signal<ReadonlySet<string>>(new Set());
  markDeployPending(id: string): void {
    if (this.pendingDeploys().has(id)) return;
    this.pendingDeploys.set(new Set(this.pendingDeploys()).add(id));
  }
  clearDeployPending(id: string): void {
    if (!this.pendingDeploys().has(id)) return;
    const next = new Set(this.pendingDeploys());
    next.delete(id);
    this.pendingDeploys.set(next);
  }
  clearAllDeployPending(): void {
    if (this.pendingDeploys().size) this.pendingDeploys.set(new Set());
  }

  /** Highlight target for the active form (feature components bind to this). */
  readonly highlightTarget = signal<string | null>(null);

  /**
   * Field paths the assistant just filled via `ui_set_field` this turn. Each is
   * a set_field path (e.g. "name", "measures.0.aggregate"); the [axGuide] anchor
   * on the matching input lights up so the user sees WHAT changed. It's a set
   * because one turn can fill several fields. Cleared by clearHighlight() — which
   * the workbench calls on the next real click — so the marks vanish on interaction.
   */
  readonly changedFields = signal<ReadonlySet<string>>(new Set());

  /** The currently mounted guided-form controller, if any. */
  private controller: GuidedFormController | null = null;

  /** Feature components register on init / unregister on destroy. */
  register(controller: GuidedFormController): void {
    this.controller = controller;
  }
  unregister(controller: GuidedFormController): void {
    if (this.controller === controller) this.controller = null;
  }

  /**
   * Resolve once the controller for `feature` has registered — used after a view
   * switch, since the target feature's component (and its controller) mounts a few
   * frames later. Polls briefly and gives up after ~2s so a mis-routed directive
   * fails cleanly instead of hanging. Returns the controller, or null on timeout.
   */
  private waitForController(feature: FeatureKey): Promise<GuidedFormController | null> {
    const ready = () => (this.controller?.feature === feature ? this.controller : null);
    const immediate = ready();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let elapsed = 0;
      const step = 30;
      const timer = setInterval(() => {
        const c = ready();
        elapsed += step;
        if (c || elapsed >= 2000) {
          clearInterval(timer);
          resolve(c);
        }
      }, step);
    });
  }

  /**
   * The item the page on screen currently has open, for the shell to mirror into
   * `?item=`. Null when nothing is open, when the page has no item concept, or —
   * importantly — while a view switch is in flight: the OUTGOING page's controller
   * stays registered until Angular destroys its component, and its item must never
   * be written into the URL under the INCOMING page's key. Comparing the
   * controller's feature with `activeView` closes that window.
   */
  currentItemToken(): string | null {
    const c = this.controller;
    if (!c || c.feature !== this.activeView()) return null;
    const token = c.currentItem?.();
    return token ? token : null;
  }

  /**
   * Re-open the item a `?item=` token names on `view`, once that page has mounted.
   * Returns whether it landed: false for a page that can't address items, one that
   * never mounts, or a token naming something that no longer exists (a stale
   * bookmark). Never throws — a bad URL must not break the page load.
   */
  async restoreItem(view: FeatureKey, token: string): Promise<boolean> {
    const trimmed = token.trim();
    if (!trimmed) return false;
    const controller = await this.waitForController(view);
    if (!controller?.restoreItem) return false;
    try {
      return await controller.restoreItem(trimmed);
    } catch {
      return false;
    }
  }

  /**
   * Ask the mounted feature whether it's OK to navigate away now. If it has
   * unsaved edits it BLOCKS (returns false) and shows its own leave dialog,
   * invoking `proceed` only if the user chooses to leave. With no controller (or
   * no guard), navigation is always allowed. The shell calls this before any
   * view switch so a component isn't destroyed out from under unsaved edits.
   */
  canLeaveActive(proceed: () => void): boolean {
    if (!this.controller?.canLeave) return true;
    return this.controller.canLeave(proceed);
  }

  /**
   * Guard an assistant-driven navigation AWAY from the current feature: if the
   * mounted feature (a DIFFERENT one than `target`) has unsaved edits, the shell's
   * leave dialog will block the switch — so instead of firing a navigate that
   * silently hangs (waiting for a page that never mounts), return a failure the
   * assistant relays: the user must save a draft or discard first. Returns null
   * when navigation is safe (no edits, or a no-op switch to the same feature).
   */
  private async unsavedEditsBlock(
    target: FeatureKey,
    onUnsaved?: 'save' | 'discard',
  ): Promise<SetFieldResult | null> {
    const c = this.controller;
    if (!c || c.feature === target) return null;
    if (!c.hasUnsavedEdits?.()) return null;

    // The caller (assistant) supplied a disposition the user chose — resolve the
    // edits ON THE USER'S BEHALF so the navigation can proceed, instead of asking
    // again. This is what closes the reported dead-end: the assistant asks once,
    // then retries the navigate with onUnsaved and the edits are actually handled.
    if (onUnsaved) {
      if (!c.resolveUnsaved) {
        // Can't resolve here — fall back to discarding via the leave-guard path by
        // reporting we couldn't, so the assistant surfaces it rather than looping.
        return {
          applied: false,
          detail: `The ${FEATURE_LABELS[c.feature] ?? c.feature} page can't ${onUnsaved} its edits automatically. Ask the user to use the on-form buttons.`,
        };
      }
      const res = await c.resolveUnsaved(onUnsaved);
      if (!res.applied) {
        // Save failed (e.g. missing name) — report why so the assistant can ask.
        return res;
      }
      return null; // edits handled; navigation may proceed
    }

    // No disposition yet — tell the assistant to ask the user, then RETRY this
    // same navigation with onUnsaved:'save'|'discard' (it does not need to make the
    // user click the leave dialog — it resolves the edits itself on retry).
    return {
      applied: false,
      detail:
        `The user has unsaved changes on the ${FEATURE_LABELS[c.feature] ?? c.feature} page. Do NOT navigate yet. ` +
        `Ask the user whether to SAVE those changes as a draft or DISCARD them. Once they answer, call this same ` +
        `navigation tool again with onUnsaved:"save" or onUnsaved:"discard" — you will handle it for them (do NOT ` +
        `tell them to click any dialog or button themselves). Nothing is auto-saved.`,
    };
  }

  /** Request a feature page (the workbench watches this to swap views). */
  private readonly navRequests = new Subject<FeatureKey>();
  readonly navRequests$ = this.navRequests.asObservable();

  setActiveView(view: FeatureKey): void {
    this.activeView.set(view);
    this.navRequests.next(view);
  }

  /**
   * The in-app entry for a Dashboard KPI-tile issue click: switch to Issue
   * Management and select the issue slice for `kpiName`. No unsaved-edits handshake
   * — the only caller is a direct user gesture on the read-only Dashboard view (no
   * editable source form), exactly like openBusinessProcess. The assistant's
   * open_entity directive does NOT come here: it uses applyDirective's generic
   * open_entity case, which keeps the source-page handshake it may need.
   * Returns the page's openEntity result, or applied:false if the page never mounts.
   */
  async openIssuesForKpi(kpiName: string): Promise<SetFieldResult> {
    this.setActiveView('issue-management');
    const controller = await this.waitForController('issue-management');
    if (!controller?.openEntity) {
      return { applied: false, detail: 'The Issue Management page did not open in time.' };
    }
    return controller.openEntity(kpiName);
  }

  /**
   * A feature requests the assistant to run an agent turn with a prepared prompt
   * (e.g. the Data Integration "Create"/"Deploy" buttons hand off to the
   * data-integration skill). The workbench listens, opens the chat, forces Agent
   * mode, and injects the prompt so the user watches the progress stream. This is
   * how a UI action delegates real work to the agent instead of a bespoke route.
   */
  private readonly agentPrompts = new Subject<AgentPromptRequest>();
  readonly agentPrompts$ = this.agentPrompts.asObservable();

  /**
   * Force Agent mode, then emit a prompt for the assistant panel to run. The full
   * `prompt` (with system detail like the pipeline JSON) is what's SENT to the
   * backend; `displayText`, when given, is the friendly one-liner shown in the
   * chat as the user's message instead of the raw prompt — so internal deploy
   * instructions never surface in the UI. Omit `displayText` to show the prompt.
   *
   * `freshSession` starts the prompt in a NEW chat session (e.g. each Deploy runs
   * isolated, not continuing the prior conversation).
   */
  runAgentPrompt(prompt: string, displayText?: string, freshSession = false): void {
    this.mode.set('agent');
    this.agentPrompts.next({ prompt, displayText, freshSession });
  }

  /**
   * Ask the assistant a prepared QUESTION on the user's behalf (the Analytics Cube
   * intro's sample questions). Two deliberate differences from `runAgentPrompt`:
   *
   *  - **It does NOT force Agent mode.** A question is answered, not executed, and
   *    the teaching persona is Guided's — so it runs in whatever mode the user has
   *    selected, and nothing touches IRIS on their behalf.
   *  - **It CONTINUES the current chat session** (no `freshSession`), so the answer
   *    lands in the conversation the user already has and they can follow up on it.
   *    With no session yet, the panel opens one.
   *
   * `displayText` is the short question shown in the chat bubble; `prompt` may add
   * the framing that keeps the answer about SCO rather than BI in the abstract.
   */
  askAssistant(prompt: string, displayText?: string): void {
    this.agentPrompts.next({ prompt, displayText });
  }

  /**
   * Status reports from the agent (the `ui_report_status` tool → `report_status`
   * directive). A feature (e.g. Data Integration) subscribes and updates the
   * matching entity's badge from the REAL outcome — so the status is no longer an
   * optimistic guess the moment a button is clicked.
   */
  private readonly statusReports = new Subject<StatusReport>();
  readonly statusReports$ = this.statusReports.asObservable();

  /**
   * Fires when an agent turn ENDS (finished, stopped, or errored). A feature that
   * put an entity into a pending/working state on a button-triggered agent run
   * (e.g. Data Integration Deploy) subscribes to clear that state if the turn ends
   * WITHOUT a `ui_report_status` — otherwise stopping the chat mid-deploy would
   * leave the pipeline's spinner stuck forever. `reported` says whether the turn
   * emitted a status report (so the feature can skip clearing when the report
   * already settled it).
   */
  private readonly agentTurnEnded = new Subject<{ reported: boolean }>();
  readonly agentTurnEnded$ = this.agentTurnEnded.asObservable();
  /** Called by the assistant panel when a run settles (complete/stop/error). */
  notifyAgentTurnEnded(reported: boolean): void {
    // A turn that ended WITHOUT a status report (stopped/errored) can't settle any
    // pending deploy via report_status — clear them here so the spinner never
    // sticks, even if the owning feature page is currently unmounted.
    if (!reported) this.clearAllDeployPending();
    this.agentTurnEnded.next({ reported });
  }

  /**
   * Build the UI-context block sent with each assistant turn: the current page
   * plus a FULL snapshot of the active form or the selected cube/KPI. Every field
   * value is included verbatim (arrays and nested objects expanded, not collapsed
   * to a count) so the assistant can answer specific questions about exactly
   * what's on screen — a generic "[3]" told it nothing. Empty scalars are marked
   * "(empty)" so the model can see what's still unfilled.
   *
   * It also carries the workbench's LIVE page list (`availablePages`), read from
   * the nav the shell actually renders. That is how the assistant learns which
   * pages exist — pages come and go as the product grows, so it must never answer
   * from a list baked into a prompt or a tool schema.
   */
  getContextSnapshot(): string {
    const view = this.activeView();
    const lines = [`page: ${view}`];
    lines.push(
      'availablePages (the workbench sidebar right now; the key before the dash is the ' +
        'ui_navigate/ui_open_form `feature` value — these are the ONLY pages that exist):',
      ...this.pageCatalog().map(formatPage),
    );
    if (this.controller) {
      lines.push(`activeForm: ${this.controller.feature}`);
      const snap = this.controller.snapshot();
      const entries = Object.entries(snap).map(([k, v]) => `${k}: ${formatSnapshotValue(v)}`);
      if (entries.length) lines.push(...entries);
    } else {
      lines.push('activeForm: (none open)');
    }
    return lines.join('\n');
  }

  /**
   * Apply a UI directive from the backend (Guided mode). navigate/open_form
   * switch the page (and open the form); set_field/highlight target the active
   * form's controller. Returns the set_field result (whether the value landed)
   * so the panel can ack the backend with the truth; other actions return
   * applied:true (they don't fail meaningfully client-side).
   *
   * Async because a controller's `setField` may itself be async (e.g. the cube
   * form awaits the source class's property list before validating a
   * `sourceProperty`).
   */
  async applyDirective(d: UiDirective): Promise<SetFieldResult> {
    switch (d.action) {
      case 'navigate': {
        const resolved = this.resolvePage(d.target);
        if ('error' in resolved) return resolved.error;
        const target = resolved.page.key;
        const onUnsaved = (d.value as { onUnsaved?: 'save' | 'discard' } | undefined)?.onUnsaved;
        const blocked = await this.unsavedEditsBlock(target, onUnsaved);
        if (blocked) return blocked;
        this.setActiveView(target);
        // Wait for the destination feature to mount and its list to load, then hand
        // the freshly loaded page snapshot back in the tool result — so the assistant
        // sees the list IN THE SAME TURN and can resolve/open a match immediately,
        // instead of landing on a still-loading page and stalling.
        const controller = await this.waitForController(target);
        if (controller?.whenListReady) {
          try { await controller.whenListReady(); } catch { /* best-effort; fall through */ }
        }
        const snapshot = this.getContextSnapshot();
        return { applied: true, detail: `Now on ${FEATURE_LABELS[target] ?? target}. Current page context:\n${snapshot}` };
      }
      case 'open_form': {
        const resolved = this.resolvePage(d.target);
        if ('error' in resolved) return resolved.error;
        const target = resolved.page.key;
        const onUnsaved = (d.value as { onUnsaved?: 'save' | 'discard' } | undefined)?.onUnsaved;
        const blocked = await this.unsavedEditsBlock(target, onUnsaved);
        if (blocked) return blocked;
        this.setActiveView(target);
        // Optional formKind (data-model: "object" | "attribute") tells the
        // feature which create form to open.
        const formKind = (d.value as { formKind?: string } | undefined)?.formKind;
        // The controller for the target feature mounts only AFTER the view switch
        // (its component's ngOnInit calls register()), so WAIT for it before
        // opening the form — a bare queueMicrotask fired while `this.controller`
        // was still the previous page's (or null), so opening a form after
        // navigating from another page silently no-op'd and the assistant, seeing
        // no open form, fell back to "click New yourself". Waiting fixes that, and
        // returning the resulting snapshot lets the assistant confirm the form is
        // open and start filling it in the SAME turn.
        const controller = await this.waitForController(target);
        if (!controller) return { applied: false, detail: `The ${target} page did not open in time.` };
        controller.openNewForm(formKind ? { formKind } : undefined);
        const snapshot = this.getContextSnapshot();
        return { applied: true, detail: `Opened a new form on ${FEATURE_LABELS[target] ?? target}. It is now on screen — start filling fields, do not ask the user to click New. Current form context:\n${snapshot}` };
      }
      case 'open_entity': {
        // Navigate to the feature and land on an EXISTING entity by name — either
        // "view" (select + show detail; works for any item incl. built-ins) or
        // "edit" (reopen a saved KPI/cube draft, or a data-model object's form).
        const v = (d.value ?? {}) as { name?: string; formKind?: string; mode?: 'view' | 'edit'; onUnsaved?: 'save' | 'discard' };
        const name = (v.name ?? '').trim();
        if (!name) return { applied: false, detail: 'open_entity requires an entity name.' };
        const resolved = this.resolvePage(d.target);
        if ('error' in resolved) return resolved.error;
        const target = resolved.page.key;
        const blocked = await this.unsavedEditsBlock(target, v.onUnsaved);
        if (blocked) return blocked;
        this.setActiveView(target);
        // The target feature's controller mounts only AFTER the view switch, so
        // wait for it to register before asking it to open the entity. Fail clearly
        // if the feature doesn't support addressing an entity this way.
        const controller = await this.waitForController(target);
        if (!controller) return { applied: false, detail: `The ${target} page did not open in time.` };
        if (!controller.openEntity) {
          return { applied: false, detail: `The ${target} page cannot open a specific entity by name.` };
        }
        return controller.openEntity(name, {
          mode: v.mode ?? 'view',
          ...(v.formKind ? { formKind: v.formKind } : {}),
        });
      }
      case 'set_field': {
        if (!this.controller) {
          return { applied: false, detail: 'No form is open to set the field on.' };
        }
        const res = await this.controller.setField(d.target, d.value);
        // Mark the field as just-changed so its [axGuide] anchor lights up.
        // Only when it actually landed — a rejected value didn't change anything.
        if (res.applied) {
          const next = new Set(this.changedFields());
          next.add(d.target);
          this.changedFields.set(next);
        }
        return res;
      }
      case 'highlight':
        // The [axGuide] directive watches highlightTarget and applies a pulsing
        // ring to the matching element on any page. It PERSISTS until the user
        // takes an action (clearHighlight() is called on the next real click).
        this.highlightTarget.set(d.target);
        this.controller?.highlight(d.target);
        return { applied: true };
      case 'report_status': {
        // Agent mode: the agent reports a lifecycle step's real outcome. Clear the
        // pending state HERE (the bridge is always alive), so it settles even if
        // the owning feature page is currently unmounted; then fan the report out
        // to whichever feature owns the entity (unknown ids are simply ignored).
        const v = (d.value ?? {}) as { phase?: StatusPhase; ok?: boolean; detail?: string };
        this.clearDeployPending(d.target);
        if (v.phase) {
          this.statusReports.next({ id: d.target, phase: v.phase, ok: v.ok !== false, detail: v.detail });
        }
        return { applied: true };
      }
      default:
        return { applied: true };
    }
  }

  /**
   * Clear any active guided highlight AND the just-changed field marks (called
   * when the user interacts — a click anywhere outside the assistant dock). Both
   * are transient cues meant to vanish the moment the user acts.
   */
  clearHighlight(): void {
    if (this.highlightTarget() !== null) this.highlightTarget.set(null);
    if (this.changedFields().size) this.changedFields.set(new Set());
  }
}
