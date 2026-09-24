import {
  ApplicationRef,
  Component,
  ElementRef,
  ViewChild,
  AfterViewChecked,
  OnInit,
  OnDestroy,
  HostListener,
  signal,
  computed,
  effect,
  untracked,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { AssistantService } from './assistant.service';
import {
  WorkbenchBridgeService,
  type AssistantMode,
  type FeatureKey,
  type SetFieldResult,
} from '../core/workbench-bridge.service';
import { isAiEnabled, AI_KEY_MISSING_PLACEHOLDER } from '../core/ai-status';
import { MarkdownPipe } from './markdown.pipe';
import { ConfirmCardComponent } from './confirm-card';
import { AskCardComponent } from './ask-card';
import { ContextBadgeComponent } from '../workbench/context-badge';
import {
  type UiTurn,
  type UiItem,
  type TurnEvent,
  type AskRequest,
  type ConfirmRequest,
  type SessionSummary,
  type AskAnswer,
  type UiDirective,
} from './models';
import {
  stepLabel,
  stepToolName,
  summarizeToolResult,
  prettyToolResult,
  showsResultPreview,
  pretty,
  hasInput,
} from './tool-format';

/**
 * One in-flight-or-finished turn for a single chat session. Lets multiple
 * sessions stream at once: each keeps its own subscription + timeline, so
 * switching away doesn't unsubscribe (which would abort the backend turn).
 */
interface Run {
  /** Session id once known; until the backend assigns one, a temp key. */
  sessionId: string | null;
  /** Stable map key (the temp key at first, then the real session id). */
  key: string;
  /** This run's timeline (the foreground run's array is shared into `turns`). */
  turns: UiTurn[];
  /** The assistant turn currently being streamed into. */
  turn: UiTurn;
  sub: Subscription;
  streaming: boolean;
  /** A pending confirm/ask for THIS run (shown only while it's foreground). */
  confirmReq: ConfirmRequest | null;
  askReq: AskRequest | null;
  /** The final assistant text, once emitted. */
  finalText?: string;
  /** True once this run emitted a `report_status` directive (a feature button's
   *  deploy/delete outcome). Lets the panel tell features whether a turn that just
   *  ended already settled their pending state. */
  reportedStatus: boolean;
}

/**
 * The embedded SCO Workbench AI assistant — a native Angular port of the
 * standalone chat UI. Renders an assistant turn as a timeline (prose + tool/skill
 * steps + summary), streams tokens over SSE, gates state-changing IRIS actions
 * behind an inline approval card, and asks tabbed questions inline.
 *
 * This component is the panel BODY; the docking chrome (toggle, resize, header)
 * lives in the workbench shell that hosts it.
 */
@Component({
  selector: 'app-assistant-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MarkdownPipe,
    ConfirmCardComponent,
    AskCardComponent,
    ContextBadgeComponent,
  ],
  templateUrl: './assistant-panel.html',
  styleUrl: './assistant-panel.css',
})
export class AssistantPanelComponent implements OnInit, AfterViewChecked, OnDestroy {
  private readonly api = inject(AssistantService);
  private readonly bridge = inject(WorkbenchBridgeService);
  private readonly appRef = inject(ApplicationRef);

  @ViewChild('messages') private messagesRef?: ElementRef<HTMLDivElement>;
  @ViewChild('inputEl') private inputRef?: ElementRef<HTMLTextAreaElement>;

  /** Whether the session-history popover is shown (floats over the transcript). */
  showHistory = signal(false);
  /** Free-text filter for the history popover. */
  historyFilter = '';

  turns = signal<UiTurn[]>([]);
  sessions = signal<SessionSummary[]>([]);
  /** Backed by the bridge so the session survives the panel being recreated
   *  (chat close/reopen, navigation). Reset only by New chat / page reload. */
  get currentSessionId(): string | null {
    return this.bridge.currentSessionId();
  }
  set currentSessionId(id: string | null) {
    this.bridge.currentSessionId.set(id);
  }
  streaming = signal(false);
  input = '';

  /** Friendly label of the current feature page, shown as an ambient context
   *  badge in the composer controls row. Bound straight to the bridge so it
   *  tracks navigation reactively (same source as the sidebar labels). */
  readonly contextLabel = this.bridge.activeViewLabel;

  /** The active confirm / ask prompt, rendered as an inline overlay card. */
  confirmReq = signal<ConfirmRequest | null>(null);
  askReq = signal<AskRequest | null>(null);

  // ---- Assistant mode picker (in the composer, opens upward) ----
  // Only Guided mode is offered in the UI for now. Agent mode remains fully
  // supported in the backend (and is still forced programmatically by feature
  // buttons via bridge.runAgentPrompt, e.g. Data Integration Create/Deploy) —
  // we just don't expose it as a user-selectable option yet. To re-enable it,
  // add `{ value: 'agent', label: 'Agent', hint: 'AI takes the actions for you' }`.
  modeMenuOpen = signal(false);
  readonly modeOptions: Array<{ value: AssistantMode; label: string; hint: string }> = [
    { value: 'guided', label: 'Guided', hint: 'AI guides you step by step' },
  ];
  /** Current mode (reads the shared bridge signal). */
  readonly mode = computed(() => this.bridge.mode());
  readonly modeLabel = computed(
    () => this.modeOptions.find((m) => m.value === this.bridge.mode())?.label ?? 'Guided',
  );
  toggleModeMenu(): void {
    this.modeMenuOpen.update((v) => !v);
  }
  selectMode(value: AssistantMode): void {
    this.bridge.mode.set(value);
    this.modeMenuOpen.set(false);
    // Restart the animated placeholder on the new mode's task list.
    this.restartPlaceholder();
  }
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    // Close the mode menu on any click outside it.
    if (this.modeMenuOpen() && !target.closest('.ax-mode-picker')) {
      this.modeMenuOpen.set(false);
    }
    // Close the session-history popover on any click outside it — but NOT when
    // clicking the toggle button itself (that button toggles it in the shell).
    if (
      this.showHistory() &&
      !target.closest('.ax-history-pop') &&
      !target.closest('.ax-history-toggle')
    ) {
      this.showHistory.set(false);
    }
  }

  readonly isEmpty = computed(() => this.turns().length === 0);

  /**
   * Whether the backend has Claude credentials at all. Read once at
   * construction: it comes from `/config.json`, which is fetched during bootstrap
   * and never changes for the life of the page.
   *
   * When false the composer is inert — placeholder, disabled input, dead Send —
   * because a message here could only ever come back as an error. It says
   * "Claude key not provided" instead of accepting the message and then failing.
   */
  readonly aiEnabled = isAiEnabled();

  /**
   * What the composer's input prompts with. Four states, most specific first:
   * no key at all → say so (and the box is disabled); a turn in flight → we're
   * waiting; a fresh, untouched session → the animated example tasks; otherwise a
   * plain invitation.
   */
  get composerPlaceholder(): string {
    if (!this.aiEnabled) return AI_KEY_MISSING_PLACEHOLDER;
    if (this.streaming()) return 'Waiting for the response…';
    return this.isEmpty() && !this.input ? this.placeholder() : 'Ask the assistant…';
  }

  // ---- Animated input placeholder (only for a fresh, empty session) ----
  /**
   * Task suffixes cycled after "Ask the assistant to ", chosen by mode AND by the
   * feature page the user is on, so the examples always name something that page
   * can actually do:
   *  - agent  ("worker"): concrete build/deploy tasks it does end-to-end in IRIS.
   *  - guided ("teacher"): learn/walk-me-through tasks it co-pilots in the UI.
   *
   * Business Process and Scenario Analysis aren't authored in the Workbench yet
   * (their pages are feature overviews), so their tasks stay explanatory.
   */
  private readonly placeholderTasks: Record<AssistantMode, Record<FeatureKey, string[]>> = {
    agent: {
      'introduction': [
        'build my first cube from SC.Data.SalesOrder…',
        'create a KPI counting late supplier shipments…',
        'ingest a customer CSV into SC.Data.Customer…',
        'set up a dashboard for supplier performance…',
      ],
      dashboard: [
        'add a tile charting orders by region…',
        'chart my late-shipment KPI as a gauge tile…',
        'build a bubble chart from the sales cube…',
        'lay out a dashboard for supplier performance…',
      ],
      'data-model': [
        'add a custom object for supplier contracts…',
        'add a lead-time attribute to SC.Data.Supplier…',
        'extend SC.Data.Customer with a region attribute…',
        'compile and deploy SC.Data.Order into SCO…',
        'compile and deploy SC.Data.Order into SCO…',
      ],
      'data-integration': [
        'build a pipeline that ingests a customer CSV into SC.Data.Customer…',
        'poll an SFTP folder and map the records into SCO…',
        'poll an SFTP folder and map the records into SCO…',
        'pull daily inventory files from an S3 bucket…',
        'deploy this integration onto the running production…',
      ],
      'bi-cubes': [
        'build a cube on SC.Data.SalesOrder with an order-value measure…',
        'build a cube that aggregates orders by region and month…',
        'add a time dimension to this cube and rebuild it…',
        'compile and deploy this cube into SCO…',
        'compile and deploy this cube into SCO…',
      ],
      kpi: [
        'create a KPI counting late supplier shipments…',
        'add a percentage KPI for early-delivered supply shipments…',
        'create a KPI for average order value by region…',
        'deploy this KPI so a dashboard tile can chart it…',
      ],
      'business-process': [
        'deploy a business process onto the running production…',
        'list the business processes in this production…',
        'check whether a business process is currently running…',
        'trace the messages through a recent process run…',
      ],
      others: [
        'explain what SCO Scenario Analysis can do…',
        'explain how ML-Based Forecasting works in SCO…',
        'tell me about the AI Assistant for business users…',
        'explain the Track & Trace service…',
      ],
      'issue-management': [
        'show me all High-severity issues…',
        'show open issues for Supplier On-Time Delivery…',
        'list Work Queue issues that need attention…',
        'summarize the issues on screen…',
      ],
      'load-sample-data': [
        'explain what the sample data sets contain…',
        'ingest the example CSVs into the SCO data model…',
        'build a pipeline that loads a sample data set into SCO…',
        'tell me which SCO objects the example CSVs map onto…',
      ],
    },
    guided: {
      'introduction': [
        'show me around the Workbench…',
        'explain what a cube, a KPI, and a dashboard tile are…',
        'suggest a first project for my supply chain data…',
        'walk me through the SCO data model…',
      ],
      dashboard: [
        'walk me through adding my first dashboard tile…',
        'help me pick a chart type for this data…',
        'explain the difference between a KPI tile and a cube tile…',
        'show me how to filter a chart by time period…',
      ],
      'data-model': [
        'explain how SC.Data.SalesOrder relates to its line items…',
        'walk me through adding a custom object…',
        'explain what the attributes on this object mean…',
        'show me which object my CSV should map into…',
      ],
      'data-integration': [
        'help me fill out this integration form…',
        'explain the difference between S3, SFTP, and local file sources…',
        'walk me through mapping CSV columns to object attributes…',
        'explain what deploying a pipeline actually does…',
      ],
      'bi-cubes': [
        'walk me through building my first cube…',
        'explain what a cube dimension, hierarchy, and level are…',
        'help me fill out this cube form…',
        'guide me through adding a measure to my cube…',
      ],
      kpi: [
        'help me create a KPI step by step…',
        'explain the MDX query behind this KPI…',
        'explain raw vs percentage KPI value types…',
        'help me choose a cube and measure for this KPI…',
      ],
      'business-process': [
        'explain what Business Process Language is…',
        'explain how a business process differs from a data pipeline…',
        'walk me through the key concepts on this page…',
        'show me where business processes are authored today…',
      ],
      others: [
        'explain what SCO Scenario Analysis can do…',
        'explain how ML-Based Forecasting works in SCO…',
        'tell me about the AI Assistant for business users…',
        'explain the Track & Trace service…',
      ],
      'issue-management': [
        'explain what triggered the High-severity issues…',
        'walk me through the Work Queue issues…',
        'explain the difference between severity and urgency…',
        'help me understand an issue and its next steps…',
      ],
      'load-sample-data': [
        'explain what the sample data sets are for…',
        'help me pick a sample data set to start with…',
        'walk me through loading a sample data set…',
        'explain how the example CSVs map onto the SCO data model…',
      ],
    },
  };
  private readonly placeholderPrefix = 'Ask the assistant to ';
  /** The animated input placeholder: prefix + a task typed out character-by-character. */
  placeholder = signal(this.placeholderPrefix);
  /**
   * The empty-chat greeting — one line, no supporting text.
   *
   * A statement rather than a question, because the composer's animated placeholder
   * ("Ask the assistant to …") already does the asking, and it rotates real per-page
   * examples — so this line deliberately does not list capabilities as well.
   */
  readonly greeting = 'Ask anything about SCO and build it with AI';
  /** Whether the composer textarea is focused (drives the container's focus ring). */
  composerFocused = false;
  private placeholderTimer: ReturnType<typeof setTimeout> | null = null;
  private placeholderIndex = 0;
  private placeholderChar = 0;
  /** Restart the placeholder animation on the current page's task list (the user
   *  navigated, or a guided directive did). `untracked` keeps the effect watching
   *  only activeView — typePlaceholder itself reads other signals. */
  private readonly pageChangeRestart = effect(() => {
    this.bridge.activeView();
    untracked(() => this.restartPlaceholder());
  });

  /** Restart the typewriter from the first task of the current mode + page list. */
  private restartPlaceholder(): void {
    if (this.placeholderTimer) clearTimeout(this.placeholderTimer);
    // With no Claude key the composer shows a fixed "Claude key not provided", so
    // there is nothing to animate — and a timer that keeps typing example tasks
    // into a signal nobody renders would run for the life of the page.
    if (!this.aiEnabled) return;
    this.placeholderIndex = 0;
    this.placeholderChar = 0;
    this.typePlaceholder();
  }

  /** Sessions filtered by the popover's search box (case-insensitive title match). */
  filteredSessions(): SessionSummary[] {
    const q = this.historyFilter.trim().toLowerCase();
    const all = this.sessions();
    if (!q) return all;
    return all.filter((s) => (s.title || 'Untitled').toLowerCase().includes(q));
  }

  /**
   * A single in-flight (or just-finished) turn for ONE session. Runs live in
   * `runs`, keyed by session id, so a session keeps streaming in the background
   * while the user views/starts another — switching sessions never unsubscribes a
   * run (which would abort its backend turn). The component's `turns` / `streaming`
   * / `confirmReq` / `askReq` signals mirror whichever run is FOREGROUND; a
   * background run mutates its OWN `turns` array and only refreshes the signals
   * when it is the foreground run.
   */
  private foreground: Run | null = null;
  /** Live runs keyed by session id. A run whose session id isn't known yet (the
   *  backend assigns it on the first `session` event) is keyed by `tempKey` until
   *  then, then re-keyed. */
  private readonly runs = new Map<string, Run>();
  private tempRunSeq = 0;
  private scrollPending = false;
  /** Autoscroll follows new content while true; a user scroll-up turns it off. */
  private stick = true;
  /** Last observed scrollTop, used to tell scroll DIRECTION apart in onScroll. */
  private lastScrollTop = 0;
  /** Distance from the bottom (px) still counted as "at the bottom". */
  private static readonly STICK_THRESHOLD = 40;
  // Working indicator shows a single, literal label (SC-2679) — no rotating verbs.
  readonly thinkingWord = signal('Thinking…');
  private uid = 0;

  ngOnInit(): void {
    void this.refreshSessions();
    // The placeholder animation starts from pageChangeRestart's first effect run.
    // If a session is already active (the panel was recreated on chat reopen or
    // navigation), reload its transcript so the conversation continues.
    const existing = this.bridge.currentSessionId();
    if (existing) void this.restoreSession(existing);
  }

  /** Reload a session's transcript into the panel without toggling history. If a
   *  live run for this session is still in memory (panel recreated mid-stream),
   *  foreground it instead of showing a stale transcript. */
  private async restoreSession(id: string): Promise<void> {
    const live = this.runs.get(id);
    if (live) {
      this.foreground = live;
      this.syncForeground(live);
      return;
    }
    const messages = await this.api.loadSession(id);
    if (this.bridge.currentSessionId() !== id) return; // switched meanwhile
    this.rebuildTurns(messages);
  }

  ngOnDestroy(): void {
    // Tear down every live run's subscription. The panel is now ALWAYS mounted
    // while the workbench is open (closing the chat dock only hides it with a
    // class), so this fires only on a real teardown — navigating away from the
    // whole workbench or a full page reload — where the backend turns can't
    // survive anyway. Closing/reopening the dock keeps runs streaming.
    for (const run of this.runs.values()) run.sub.unsubscribe();
    this.runs.clear();
    this.foreground = null;
    if (this.placeholderTimer) clearTimeout(this.placeholderTimer);
  }

  /**
   * Typewriter for the empty-composer placeholder: types the current task one
   * character at a time after the fixed "Ask the assistant to " prefix, holds it
   * for ~3s, then moves to the next task and retypes. Self-scheduling via
   * setTimeout (no interval); it keeps running but only shows while the textarea
   * is empty (Angular's placeholder attribute).
   */
  private typePlaceholder(): void {
    const tasks = this.placeholderTasks[this.bridge.mode()][this.bridge.activeView()];
    const task = tasks[this.placeholderIndex % tasks.length]!;
    if (this.placeholderChar <= task.length) {
      this.placeholder.set(this.placeholderPrefix + task.slice(0, this.placeholderChar));
      this.placeholderChar++;
      // Grow the box to fit the (wrapping) placeholder while the field is empty.
      const el = this.inputRef?.nativeElement;
      if (el && !el.value && this.isEmpty()) this.sizeToPlaceholder(el);
      this.placeholderTimer = setTimeout(() => this.typePlaceholder(), 45);
    } else {
      // Finished typing this task — hold, then advance to the next and retype.
      this.placeholderChar = 0;
      this.placeholderIndex = (this.placeholderIndex + 1) % tasks.length;
      this.placeholderTimer = setTimeout(() => this.typePlaceholder(), 3000);
    }
  }

  ngAfterViewChecked(): void {
    if (this.scrollPending) {
      this.scrollToBottom();
      this.scrollPending = false;
    }
  }

  // ---------- Sending ----------

  send(): void {
    if (this.streaming()) {
      this.stop();
      return;
    }
    // No key, no turn. The input and the Send button are already disabled, so this
    // only catches the paths a disabled attribute doesn't cover — Enter in the
    // textarea, a submit on the form — rather than starting a turn that can only
    // come back as an error.
    if (!this.aiEnabled) return;
    const text = this.input.trim();
    if (!text) return;
    this.input = '';
    this.autoGrowReset();
    void this.startTurn(text);
  }

  /**
   * Run a prepared prompt programmatically (a feature button delegating work to
   * the agent, e.g. Data Integration Deploy). No-op while a turn is already
   * streaming, so a double-click can't launch two overlapping turns.
   *
   * `displayText`, when given, is shown in the chat as the user's message instead
   * of `text` — so a prompt carrying system detail (the deploy JSON, internal
   * step instructions) never surfaces in the UI while the full `text` is still
   * what's sent to the backend.
   *
   * `freshSession` starts the prompt in a brand-new chat session (clears the
   * current session id + timeline) so the run is isolated — e.g. each Deploy gets
   * its own clean context instead of continuing the previous conversation.
   */
  runPrompt(text: string, displayText?: string, freshSession = false): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (freshSession) {
      // Start clean: null session id → the backend creates a new session. Any run
      // already streaming keeps going in the BACKGROUND (we don't unsubscribe it),
      // so this deploy is isolated AND concurrent. Clear the visible timeline for
      // the new foreground run.
      this.currentSessionId = null;
      this.turns.set([]);
      this.showHistory.set(false);
    } else if (this.streaming()) {
      // Continuing the current session, but it already has a live turn — don't
      // stack two turns on one session.
      return;
    }
    void this.startTurn(trimmed, displayText?.trim() || undefined);
  }

  private async startTurn(text: string, displayText?: string): Promise<void> {
    this.showHistory.set(false);

    // Build a fresh run. It starts FOREGROUND (the user is looking at it); its
    // timeline seeds from whatever is currently shown so a follow-up turn on an
    // existing session appends to that session's transcript.
    const key = this.currentSessionId ?? `__temp_${this.tempRunSeq++}`;
    const seedTurns = this.currentSessionId ? [...this.turns()] : [];
    const run: Run = {
      sessionId: this.currentSessionId,
      key,
      turns: seedTurns,
      turn: { id: this.uid++, role: 'assistant', items: [], thinking: true },
      sub: null as unknown as Subscription, // assigned below
      streaming: true,
      confirmReq: null,
      askReq: null,
      reportedStatus: false,
    };
    // Push the user bubble (friendly label if given) + the assistant turn.
    run.turns.push({
      id: this.uid++,
      role: 'user',
      text: displayText ?? text,
      items: [],
      thinking: false,
    });
    run.turns.push(run.turn);
    this.runs.set(key, run);
    this.foreground = run;
    this.stick = true;
    this.scrollPending = true;
    this.syncForeground(run);

    run.sub = this.api
      .chat(run.sessionId, text, {
        mode: this.bridge.mode(),
        uiContext: this.bridge.getContextSnapshot(),
        // Persist the friendly label so reloading this session's history shows it
        // (not the full prompt). Only when it differs from the sent text.
        displayText: displayText && displayText !== text ? displayText : undefined,
      })
      .subscribe({
        next: ({ event, data }) => {
          switch (event) {
            case 'session':
              if (data.sessionId && data.sessionId !== run.sessionId) {
                this.assignRunSession(run, data.sessionId);
                void this.refreshSessions();
              }
              break;
            case 'token':
              this.appendToken(run.turn, data.text);
              break;
            case 'tool_use':
              this.startStep(run.turn, data.name, data.input);
              break;
            case 'tool_result':
              this.resolveStep(run.turn, data.ok, data.text);
              break;
            case 'confirm_request':
              run.turn.thinking = true;
              run.confirmReq = data as ConfirmRequest;
              if (this.foreground === run) this.confirmReq.set(run.confirmReq);
              break;
            case 'ask_request':
              run.turn.thinking = true;
              run.askReq = data as AskRequest;
              if (this.foreground === run) this.askReq.set(run.askReq);
              break;
            case 'ui_directive': {
              // Guided mode: apply the directive to the live workbench UI
              // (navigate / open form / set field / highlight), THEN ack so the
              // agent proceeds only AFTER the UI has actually caught up.
              const dir = data as UiDirective;
              // A report_status directive means a feature button's run reported its
              // real outcome — remember it so finishRun knows the feature's pending
              // state was already settled (no need to force-clear it).
              if (dir.action === 'report_status') run.reportedStatus = true;
              void this.applyDirectiveAndAck(dir);
              break;
            }
            case 'result':
              if (data.text) {
                run.finalText = data.text;
                this.setFinalText(run.turn, data.text);
              }
              break;
            case 'error':
              this.appendError(run.turn, data.message);
              break;
            case 'stopped':
              this.appendNote(run.turn, 'Stopped.');
              break;
          }
          this.bumpRun(run);
        },
        error: (err: unknown) => {
          this.appendError(run.turn, err instanceof Error ? err.message : String(err));
          this.finishRun(run);
        },
        complete: () => {
          this.finishRun(run);
        },
      });
  }

  /** The backend assigned this run's session id — record it and re-key the map so
   *  a later switch finds the live run. Updates the foreground session id too. */
  private assignRunSession(run: Run, sessionId: string): void {
    this.runs.delete(run.key);
    run.sessionId = sessionId;
    run.key = sessionId;
    this.runs.set(sessionId, run);
    if (this.foreground === run) this.currentSessionId = sessionId;
  }

  /** Point the visible signals at `run` (its timeline, streaming + confirm/ask). */
  private syncForeground(run: Run): void {
    this.turns.set([...run.turns]);
    this.streaming.set(run.streaming);
    this.confirmReq.set(run.confirmReq);
    this.askReq.set(run.askReq);
  }

  /** Refresh the visible timeline ONLY when `run` is the foreground run; a
   *  background run mutates its own turn objects silently (shown on switch). */
  private bumpRun(run: Run): void {
    if (this.foreground === run) {
      this.turns.set([...run.turns]);
    } else {
      // A background event tried to flag a scroll of the (foreground) list — cancel it.
      this.scrollPending = false;
    }
  }

  /** Finish a run: mark it done, drop it from the live map, and — if it's the one
   *  on screen — settle the visible streaming/word-cycle state. A finished run's
   *  transcript is already persisted, so switching back reloads it from history. */
  private finishRun(run: Run): void {
    run.streaming = false;
    run.turn.thinking = false;
    for (const it of run.turn.items)
      if (it.kind === 'step' && it.status === 'running') it.status = 'done';
    if (run.turn.items.length === 0)
      run.turn.items.push({ kind: 'text', raw: '(no response)', dot: 'muted' });
    this.runs.delete(run.key);

    // Tell features (e.g. Data Integration) the turn ended, so a button-triggered
    // pending state (Deploy spinner) is cleared even when the run was STOPPED or
    // errored before the agent could call ui_report_status.
    this.bridge.notifyAgentTurnEnded(run.reportedStatus);

    if (this.foreground === run) {
      this.streaming.set(false);
      // Agent mode is a one-shot programmatic force (a feature button). Once its
      // turn finishes, restore Guided so the next user message runs guided.
      if (!this.modeOptions.some((m) => m.value === 'agent') && this.bridge.mode() === 'agent') {
        this.bridge.mode.set('guided');
      }
      this.turns.set([...run.turns]);
      setTimeout(() => this.inputRef?.nativeElement.focus(), 0);
    }
  }

  /**
   * Apply a Guided-mode UI directive to the live workbench, then ack the backend
   * — but only once the change has actually rendered. This ordering matters twice:
   *
   *  1. **Correctness of `set_field` on dropdowns/checkboxes.** This app runs
   *     ZONELESS (no zone.js), so a plain model mutation + `markForCheck()` is not
   *     enough to push the new value into a `<select>`/checkbox: Angular's
   *     `NgModel` writes the DOM value through its ControlValueAccessor from
   *     `ngOnChanges`, which only runs inside a change-detection pass. Text inputs
   *     happened to work because the two-way binding re-rendered their value
   *     interpolation-style, but selects/checkboxes silently kept the old DOM
   *     value. We force a synchronous CD pass with `appRef.tick()` so the
   *     accessor's `writeValue()` runs and the control visibly updates.
   *
   *  2. **The agent must not race ahead.** The backend blocks the tool call until
   *     this ack (see UiControlBroker), so the model's next step (e.g. "you're now
   *     on the Cubes page", or a following `set_field` that needs the form
   *     mounted) only runs after the UI is really there. We tick, let Angular's
   *     writeValue microtasks flush, then wait for the next animation frame (a
   *     rendered paint) before acking.
   */
  private async applyDirectiveAndAck(d: UiDirective): Promise<void> {
    // The ack MUST be sent no matter what — the backend broker BLOCKS the tool
    // call until it arrives (UiControlBroker), so a throw anywhere below would
    // make the tool report a spurious "no ack within 8000ms". That was the
    // open_form hang: applying the directive succeeded (the form opened), but the
    // forced `appRef.tick()` below threw a zoneless re-entrant-CD error before
    // uiAck ran, so the agent saw a timeout on a directive that actually applied.
    // Capture the best result we have and GUARANTEE the ack in `finally`.
    let result: SetFieldResult = { applied: true };
    try {
      result = await this.bridge.applyDirective(d);
      // open_form defers mounting the target form's controller to a microtask, so
      // flush microtasks first, then run a synchronous CD pass so any NgModel
      // (including newly-mounted dropdowns) writes its value into the DOM.
      await Promise.resolve();
      // Guard the tick: unlike `navigate` (whose applyDirective awaits the
      // controller + list, letting the signal-scheduled CD drain first),
      // `open_form` returns synchronously, so this forced pass can re-enter a CD
      // still in flight and throw (NG0100 in this zoneless app). Swallow it — the
      // already-scheduled CD still renders the change, and the ack must not be
      // lost to it.
      try {
        this.appRef.tick();
      } catch {
        /* re-entrant/NG0100 CD pass — the scheduled CD still applies it */
      }
      // Wait for a rendered frame so the user sees the change before we let the
      // agent continue. rAF fires after layout/paint; the extra frame gives the
      // browser time to actually present it. Fall back to a timeout if rAF is
      // unavailable (e.g. a background tab throttling frames).
      await this.nextFrame();
    } catch (err) {
      // Applying the directive itself failed — tell the backend the truth so the
      // tool surfaces a real error instead of an opaque 8s timeout.
      result = { applied: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      await this.api.uiAck(d.sessionId, d.directiveId, result);
    }
  }

  /** Resolve after the next painted frame (or a short fallback timeout). */
  private nextFrame(): Promise<void> {
    return new Promise<void>((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        res();
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
      // Safety net: never leave the agent blocked if frames aren't scheduled.
      setTimeout(finish, 120);
    });
  }

  /** Interrupt the FOREGROUND run — unsubscribing aborts the fetch → backend stop.
   *  Background runs keep going; use the history list to return to one. */
  stop(): void {
    const run = this.foreground;
    if (!run || !run.streaming) return;
    run.sub.unsubscribe();
    this.appendNote(run.turn, 'Stopped.');
    this.finishRun(run);
  }

  // ---------- Timeline mutation ----------

  /** Append streamed text to the open text block (create one if needed). */
  private appendToken(turn: UiTurn, text: string): void {
    const last = turn.items[turn.items.length - 1];
    if (last && last.kind === 'text' && last.dot === 'muted') {
      last.raw += text;
    } else {
      turn.items.push({ kind: 'text', raw: text, dot: 'muted' });
    }
    turn.thinking = true; // keep the working indicator pinned below the text
    this.scrollPending = true;
  }

  private startStep(turn: UiTurn, name: string, input: unknown): void {
    turn.items.push({
      kind: 'step',
      name,
      label: stepLabel(name, input),
      toolName: stepToolName(name, input),
      isSkill: name === 'Skill',
      input,
      status: 'running',
      expanded: false,
    });
    turn.thinking = true;
    this.scrollPending = true;
  }

  private resolveStep(turn: UiTurn, ok: boolean, outputText: string): void {
    // Resolve the most recent running step.
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const it = turn.items[i]!;
      if (it.kind === 'step' && it.status === 'running') {
        it.status = ok ? 'done' : 'error';
        // Some tools (e.g. Read) return large content we don't preview — the
        // label already says what happened (which file). Skip their result.
        if (showsResultPreview(it.name)) {
          it.summary = summarizeToolResult(outputText) || undefined;
          it.output = prettyToolResult(outputText) || undefined;
        }
        break;
      }
    }
    turn.thinking = true; // agent may act again (e.g. hidden ask) — keep spinner
    this.scrollPending = true;
  }

  private setFinalText(turn: UiTurn, text: string): void {
    // If the last streamed block is a prefix of the final text, upgrade it to
    // the green "result" dot; otherwise append a fresh finalized block.
    const last = turn.items[turn.items.length - 1];
    if (last && last.kind === 'text' && text.startsWith(last.raw.trim().slice(0, 20))) {
      last.raw = text;
      last.dot = 'ok';
    } else if (text.trim()) {
      turn.items.push({ kind: 'text', raw: text, dot: 'ok' });
    }
    turn.thinking = false;
    this.scrollPending = true;
  }

  private appendError(turn: UiTurn, message: string): void {
    turn.thinking = false;
    turn.items.push({ kind: 'error', text: message });
    this.scrollPending = true;
  }

  private appendNote(turn: UiTurn, message: string): void {
    turn.thinking = false;
    turn.items.push({ kind: 'note', text: message });
    this.scrollPending = true;
  }

  toggleStep(item: UiItem): void {
    if (item.kind === 'step') item.expanded = !item.expanded;
    this.bump();
  }

  stepHasDetails(item: Extract<UiItem, { kind: 'step' }>): boolean {
    // Tools we don't preview (e.g. Read) show no disclosure — the label alone
    // (which file was read) is the whole story.
    if (!showsResultPreview(item.name)) return false;
    return hasInput(item.input) || Boolean(item.output);
  }
  prettyInput(v: unknown): string {
    return pretty(v);
  }

  // ---------- Confirm / Ask handling ----------

  onConfirm(decision: 'approve' | 'reject'): void {
    const req = this.confirmReq();
    this.confirmReq.set(null);
    if (this.foreground) this.foreground.confirmReq = null;
    if (req) void this.api.confirm(req.sessionId, req.confirmId, decision);
  }

  onAnswered(answers: Record<string, AskAnswer>): void {
    const req = this.askReq();
    this.askReq.set(null);
    if (this.foreground) this.foreground.askReq = null;
    if (req) void this.api.answer(req.sessionId, req.askId, answers);
  }

  onAskCancelled(): void {
    const req = this.askReq();
    this.askReq.set(null);
    if (this.foreground) this.foreground.askReq = null;
    if (req) void this.api.cancelAnswer(req.sessionId, req.askId);
  }

  // ---------- Sessions ----------

  async refreshSessions(): Promise<void> {
    this.sessions.set(await this.api.listSessions());
  }

  /** True while session `id` has a live (streaming) run — used to badge the
   *  history list so background runs are visible. */
  isSessionRunning(id: string): boolean {
    const run = this.runs.get(id);
    return !!run && run.streaming;
  }

  async openSession(id: string): Promise<void> {
    // Switching is always allowed now — a currently-streaming session keeps
    // running in the BACKGROUND (we don't touch its subscription).
    this.currentSessionId = id;
    this.showHistory.set(false);

    // If this session has a LIVE run in memory, foreground it (show its in-flight
    // timeline + streaming/confirm state) instead of reloading a stale transcript.
    const live = this.runs.get(id);
    if (live) {
      this.foreground = live;
      this.syncForeground(live);
      this.stick = true;
      this.scrollPending = true;
      void this.refreshSessions();
      return;
    }

    // No live run → this session is idle; load its persisted transcript.
    this.foreground = null;
    const messages = await this.api.loadSession(id);
    if (this.currentSessionId !== id) return; // switched again meanwhile
    this.streaming.set(false);
    this.confirmReq.set(null);
    this.askReq.set(null);
    this.rebuildTurns(messages);
    void this.refreshSessions();
  }

  /**
   * Delete a chat session from the history list. `event` is stopped so the row's
   * open-session click doesn't also fire. If the session has a live run, we tear
   * it down first (unsubscribe aborts its backend turn). If it's the session on
   * screen, reset to a fresh, empty chat. Optimistically drops it from the list,
   * refreshing from the server afterward.
   */
  async deleteSession(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    // Abort + forget any live run for this session.
    const live = this.runs.get(id);
    if (live) {
      live.sub.unsubscribe();
      this.runs.delete(live.key);
      if (this.foreground === live) this.foreground = null;
    }
    // Optimistically remove from the list.
    this.sessions.set(this.sessions().filter((s) => s.id !== id));
    // If the deleted session is the one being viewed, reset to a fresh chat.
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
      this.turns.set([]);
      this.streaming.set(false);
      this.confirmReq.set(null);
      this.askReq.set(null);
    }
    const ok = await this.api.deleteSession(id);
    // Re-sync with the server (restores the row if the delete failed).
    void this.refreshSessions();
    if (!ok) return;
  }

  /** Rebuild the transcript from persisted session messages. */
  private rebuildTurns(
    messages: Array<{
      role: string;
      content: string;
      displayText?: string | null;
      toolCalls?: unknown;
    }>,
  ): void {
    const rebuilt: UiTurn[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        // Prefer the short display label (e.g. a Deploy's one-liner) over the full
        // prompt that was actually sent to the agent.
        rebuilt.push({
          id: this.uid++,
          role: 'user',
          text: m.displayText || m.content,
          items: [],
          thinking: false,
        });
      } else if (m.role === 'assistant') {
        const events = Array.isArray(m.toolCalls) ? (m.toolCalls as TurnEvent[]) : null;
        const turn: UiTurn = { id: this.uid++, role: 'assistant', items: [], thinking: false };
        if (events && events.length) this.replay(turn, events);
        else if (m.content.trim()) turn.items.push({ kind: 'text', raw: m.content, dot: 'ok' });
        rebuilt.push(turn);
      }
    }
    this.turns.set(rebuilt);
    this.stick = true;
    this.scrollPending = true;
  }

  /** Rebuild a persisted assistant turn from its stored timeline events. */
  private replay(turn: UiTurn, events: TurnEvent[]): void {
    for (const ev of events) {
      if (ev.t === 'text') {
        turn.items.push({ kind: 'text', raw: ev.text, dot: 'muted' });
      } else if (ev.t === 'result') {
        turn.items.push({ kind: 'text', raw: ev.text, dot: 'ok' });
      } else if (ev.t === 'tool') {
        turn.items.push({
          kind: 'step',
          name: ev.name,
          label: stepLabel(ev.name, ev.input),
          toolName: stepToolName(ev.name, ev.input),
          isSkill: ev.name === 'Skill',
          input: ev.input,
          status: ev.ok === undefined ? 'done' : ev.ok ? 'done' : 'error',
          summary:
            ev.output && showsResultPreview(ev.name)
              ? summarizeToolResult(ev.output) || undefined
              : undefined,
          output:
            ev.output && showsResultPreview(ev.name)
              ? prettyToolResult(ev.output) || undefined
              : undefined,
          expanded: false,
        });
      }
    }
  }

  newSession(): void {
    // Allowed even while another session streams — that run keeps going in the
    // background (untouched); we just move the foreground to a fresh, empty chat.
    this.foreground = null;
    this.currentSessionId = null;
    this.turns.set([]);
    this.streaming.set(false);
    this.confirmReq.set(null);
    this.askReq.set(null);
    this.showHistory.set(false);
    void this.refreshSessions();
    setTimeout(() => this.inputRef?.nativeElement.focus(), 0);
  }

  toggleHistory(): void {
    this.showHistory.update((v) => !v);
    if (this.showHistory()) {
      this.historyFilter = '';
      void this.refreshSessions();
    }
  }
  closeHistory(): void {
    this.showHistory.set(false);
  }

  // ---------- Composer ergonomics ----------

  onInputKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  autoGrow(el: HTMLTextAreaElement): void {
    if (!el.value && this.isEmpty()) {
      // Empty on a fresh session → size to the (possibly wrapped) placeholder,
      // which the browser doesn't include in scrollHeight on its own.
      this.sizeToPlaceholder(el);
      return;
    }
    el.style.height = 'auto';
    // Clamp between the initial min (matches the controls row) and the max.
    el.style.height = Math.min(Math.max(el.scrollHeight, 42), 200) + 'px';
  }

  /**
   * Grow the textarea to fit the current animated placeholder (which wraps but
   * doesn't affect scrollHeight while the field is empty). We briefly put the
   * placeholder text into `value` to measure the wrapped height, then restore.
   */
  private sizeToPlaceholder(el: HTMLTextAreaElement): void {
    const text = this.placeholder();
    const prev = el.value;
    el.value = text;
    el.style.height = 'auto';
    const h = Math.min(Math.max(el.scrollHeight, 42), 200);
    el.value = prev;
    el.style.height = h + 'px';
  }
  private autoGrowReset(): void {
    const el = this.inputRef?.nativeElement;
    if (el) el.style.height = 'auto';
  }

  // ---------- Scroll & word cycling ----------

  /**
   * React to scrolls. We must NOT let our own programmatic scroll-to-bottom flip
   * the stick flag: a `scrollTop = scrollHeight` schedules a `scroll` event that
   * fires a beat later — by then the next streamed token has already grown
   * `scrollHeight`, so a naive distance-from-bottom check reads "not at bottom"
   * and cancels autoscroll after the very first token (the "only scrolls when
   * done" bug). Instead we ignore the event we caused, and otherwise key off the
   * scroll DIRECTION: a user scrolling UP detaches autoscroll; returning to the
   * bottom re-attaches it.
   */
  onScroll(): void {
    const el = this.messagesRef?.nativeElement;
    if (!el) return;
    if (this.programmaticScroll) {
      this.programmaticScroll = false;
      this.lastScrollTop = el.scrollTop;
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < this.lastScrollTop - 1;
    if (scrolledUp) {
      this.stick = false; // user is reading history — stop following
    } else if (distanceFromBottom <= AssistantPanelComponent.STICK_THRESHOLD) {
      this.stick = true; // user came back to the bottom — resume following
    }
    this.lastScrollTop = el.scrollTop;
  }
  /** Whether the next `scroll` event was triggered by our own scrollToBottom. */
  private programmaticScroll = false;
  private scrollToBottom(): void {
    if (!this.stick) return;
    const el = this.messagesRef?.nativeElement;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight) return; // already there
    this.programmaticScroll = true;
    el.scrollTop = el.scrollHeight;
    this.lastScrollTop = el.scrollTop;
  }

  /** Force a re-render of the turns signal after in-place item mutation. */
  private bump(): void {
    this.turns.set([...this.turns()]);
  }
}
