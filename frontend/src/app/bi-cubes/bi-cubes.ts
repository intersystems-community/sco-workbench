import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, ViewChild, ElementRef, Injector, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScModelService } from '../services/sc-model.service';
import { CubeService, type CubeSummary, type CubeDetail } from '../services/cube.service';
import { formToCubeDefinition } from './cube-payload';
import { CUBE_INTRO_QUESTIONS, cubeQuestionPrompt, type CubeIntroQuestion } from './cube-intro-questions';
import { isAiEnabled, AI_KEY_MISSING_SHORT } from '../core/ai-status';
import { ConfirmDialogComponent } from '../shared/confirm-dialog';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult } from '../core/workbench-bridge.service';
import { resolveOption } from '../core/option-match';
import { GuideHighlightDirective } from '../core/guide-highlight.directive';
import { ToastService } from '../core/toast.service';

// ── Display model ─────────────────────────────────────────────
interface CubeLevelDef {
  name: string;
  displayName: string;
  sourceProperty: string;
  sourceExpression?: string;
  timeFunction?: string;
  sort?: string;
  hidden?: boolean;
}

interface CubeHierarchyDef {
  name: string;
  displayName?: string;
  levels: CubeLevelDef[];
}

interface CubeDimensionDef {
  name: string;
  displayName: string;
  type: string;
  hasAll: boolean;
  hidden: boolean;
  hierarchies: CubeHierarchyDef[];
}

interface CubeMeasureDef {
  name: string;
  displayName: string;
  sourceProperty: string;
  sourceExpression?: string;
  aggregate: string;
  type: string;
  hidden?: boolean;
  searchable?: boolean;
}

interface CubeDefinition {
  name: string;
  displayName: string;
  description: string;
  sourceClass: string;
  status: string;
  /** Lifecycle state used to section the list. */
  state?: 'draft' | 'compiled' | 'built';
  editable?: boolean;
  buildRestriction?: string;
  nullReplacement?: string;
  dimensions: CubeDimensionDef[];
  measures: CubeMeasureDef[];
}

// ── Form model (adds UI state to display model) ───────────────
interface LevelForm extends CubeLevelDef {
  /** Which source the user is providing: a class property, or an expression. */
  srcKind: 'property' | 'expression';
}

interface HierForm {
  name: string;
  displayName: string;
  levels: LevelForm[];
}

interface DimForm {
  name: string;
  displayName: string;
  type: string;
  hierarchies: HierForm[];
  expanded: boolean;
}

interface MeasureForm {
  name: string;
  displayName: string;
  sourceProperty: string;
  sourceExpression: string;
  /** Which source the user is providing: a class property, or an expression. */
  srcKind: 'property' | 'expression';
  aggregate: string;
  type: string;
  expanded: boolean;
}

interface CubeForm {
  name: string;
  displayName: string;
  description: string;
  sourceClass: string;
  dimensions: DimForm[];
  measures: MeasureForm[];
}

@Component({
  selector: 'app-bi-cubes',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, GuideHighlightDirective],
  templateUrl: './bi-cubes.html',
  styleUrl: './bi-cubes.css',
  changeDetection: ChangeDetectionStrategy.Default,
})
export class BiCubesComponent implements OnInit, OnDestroy {
  allCubes: CubeDefinition[] = [];
  filteredCubes: CubeDefinition[] = [];
  selectedCube: CubeDefinition | null = null;

  // Full structure (measures/dimensions/listings) for the selected cube,
  // fetched from the backend on selection.
  selectedDetail: CubeDetail | null = null;
  detailLoading = false;
  /** Non-empty when the detail fetch for the selected cube failed (shows an
   *  inline error + retry in the detail panel instead of a silent blank shell). */
  detailError = '';

  /** Base objects for the source-class dropdown: friendly name + real class. */
  baseObjects: Array<{ objectName: string; className: string }> = [];
  /** className → objectName, for the /objects/{objectName} properties lookup. */
  private classToObjectName: Record<string, string> = {};
  selectedBaseObject = '';
  /** True when the user chose "Other" and types a custom source class name. */
  sourceClassOther = false;

  // List load state
  loading = false;
  loadError = '';

  /** Whether the left list panel is collapsed to a slim rail. */
  listCollapsed = false;
  toggleList(): void {
    this.listCollapsed = !this.listCollapsed;
    this.cdr.markForCheck();
  }

  // Form state
  creatingNew = false;
  editingCube = false;
  editOriginalName = '';
  cubeForm: CubeForm = this.emptyForm();
  /** Backing field for `formError`; the setter scrolls the message into view. */
  private _formError = '';
  /** Inline form-level error banner. Setting a non-empty value scrolls to it so
   *  the user sees why an action failed (the banner sits at the top of the form). */
  get formError(): string { return this._formError; }
  set formError(msg: string) {
    this._formError = msg;
    if (msg) this.scrollErrorIntoView();
  }
  @ViewChild('formErrorEl') private formErrorEl?: ElementRef<HTMLElement>;

  /**
   * A structured build failure (BUILD_FAILED): the deduped per-row errors IRIS
   * recorded, rendered in a foldable box so a long list (e.g. 1445 rows) doesn't
   * flood the form. `null` when the last failure wasn't a build error — plain
   * failures use the inline `formError` banner. Collapsed by default.
   */
  buildError: { summary: string; lines: string[]; expanded: boolean } | null = null;
  /** Toggle the build-error details fold. */
  toggleBuildErrorDetails(): void {
    if (this.buildError) {
      this.buildError = { ...this.buildError, expanded: !this.buildError.expanded };
      this.cdr.markForCheck();
    }
  }
  formSaving = false; // true while loading a definition into the edit form
  /** Which action is in flight (disables buttons + shows per-button spinner). */
  formBusy: 'save' | 'compile' | 'build' | null = null;
  /** Unsaved edits present — drives auto-save-on-navigate and the dirty hint. */
  formDirty = false;

  // Delete state
  deleting = false;

  // Confirmation modals (replace native confirm()).
  showDeleteConfirm = false;
  showCancelConfirm = false;
  /** "Save draft / Leave / Keep editing" prompt shown when navigating away with unsaved edits. */
  showLeaveConfirm = false;

  /**
   * Generic confirm dialog for smaller destructive actions inside the form
   * (removing a measure/dimension/hierarchy/level). Any such action arms this
   * with a title/message and a callback that runs only on approve.
   */
  confirmPrompt: { title: string; message: string; confirmLabel: string; onConfirm: () => void } | null = null;

  /** Open the generic confirm dialog for a destructive action. */
  private askConfirm(title: string, message: string, onConfirm: () => void, confirmLabel = 'Remove'): void {
    this.confirmPrompt = { title, message, confirmLabel, onConfirm };
    this.cdr.markForCheck();
  }
  /** Run the pending generic-confirm action and close the dialog. */
  runConfirmPrompt(): void {
    const action = this.confirmPrompt?.onConfirm;
    this.confirmPrompt = null;
    action?.();
    this.cdr.markForCheck();
  }
  /** Dismiss the generic confirm dialog without acting. */
  cancelConfirmPrompt(): void {
    this.confirmPrompt = null;
    this.cdr.markForCheck();
  }

  /** Starter questions on the intro page — clicking one asks the assistant. */
  readonly introQuestions = CUBE_INTRO_QUESTIONS;

  /**
   * Hand an intro question to the AI Assistant: the shell opens the chat dock and
   * runs it in the session the user already has (a new one if they have none).
   *
   * Deliberately NOT a forced Agent-mode run like the Data Integration Deploy — the
   * user clicked to be taught, so it goes to whatever mode they have selected and
   * takes no action on their behalf. With no Claude key there is nobody to ask, so
   * say so in a toast rather than opening a dock that can only fail; the questions
   * stay clickable because a disabled row with no explanation teaches nothing.
   */
  askConceptQuestion(q: CubeIntroQuestion): void {
    if (!isAiEnabled()) {
      this.toasts.error(`${AI_KEY_MISSING_SHORT} The AI Assistant answers these questions.`);
      return;
    }
    this.bridge.askAssistant(cubeQuestionPrompt(q), q.question);
  }

  trackByQuestionId(_i: number, q: CubeIntroQuestion): string { return q.id; }

  // Only data + time dimensions are supported (age/computed need Architect-only
  // config the Workbench can't round-trip).
  readonly DIM_TYPES   = ['data', 'time'];
  readonly AGGREGATES  = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
  readonly MEASURE_TYPES = ['integer', 'number', 'boolean', 'string', 'date'];
  readonly TIME_FUNCTIONS = ['Year', 'QuarterYear', 'MonthYear', 'WeekYear', 'DayMonthYear', 'DayWeek', 'HourNumber'];

  /**
   * The COMPLETE set of dotted `ui_set_field` paths the cube form accepts, shown
   * verbatim in the UI-context snapshot so the assistant fills real fields
   * instead of inventing a nested backend shape. Repeating array paths use `.N.`
   * for "any index"; the assistant substitutes 0, 1, 2, …. Keep in lockstep with
   * guidedSetField / setDimensionField / setMeasureField.
   */
  readonly SET_FIELD_PATHS = [
    'name', 'displayName', 'description', 'sourceClass',
    'measures.N.name', 'measures.N.displayName', 'measures.N.srcKind',
    'measures.N.sourceProperty', 'measures.N.sourceExpression', 'measures.N.aggregate', 'measures.N.type',
    'dimensions.N.name', 'dimensions.N.displayName', 'dimensions.N.type',
    'dimensions.N.hierarchies.M.name', 'dimensions.N.hierarchies.M.displayName',
    'dimensions.N.hierarchies.M.levels.L.name', 'dimensions.N.hierarchies.M.levels.L.displayName',
    'dimensions.N.hierarchies.M.levels.L.srcKind', 'dimensions.N.hierarchies.M.levels.L.sourceProperty',
    'dimensions.N.hierarchies.M.levels.L.sourceExpression', 'dimensions.N.hierarchies.M.levels.L.timeFunction',
  ];

  // Properties of the currently selected source class
  sourceClassProperties: string[] = [];
  /**
   * The in-flight source-class property load, if any. Guided mode awaits this
   * before validating a `sourceProperty` so a value set right after the source
   * class isn't dropped by the async fetch race (the earlier bug: the assistant
   * set sourceClass then sourceProperty in one turn, the list was still empty,
   * the value was accepted optimistically but the <select> had no matching
   * option, so it silently vanished). Resolves once the list is populated (or
   * the fetch failed). Null when no class is set / nothing is loading.
   */
  private sourcePropsLoading: Promise<void> | null = null;

  /** Field path currently highlighted by Guided mode (bound in the template). */
  highlightPath: string | null = null;

  constructor(
    private scModel: ScModelService,
    private cubes: CubeService,
    private cdr: ChangeDetectorRef,
    private bridge: WorkbenchBridgeService,
    private toasts: ToastService,
  ) {}

  /** Controller the assistant (Guided mode) uses to drive this form. */
  private readonly guidedController: GuidedFormController = {
    feature: 'bi-cubes',
    openNewForm: () => this.openNewForm(),
    openEntity: (name, opts) => this.guidedOpenEntity(name, opts),
    setField: (path, value) => this.guidedSetField(path, value),
    highlight: (target) => {
      this.highlightPath = target;
      this.cdr.markForCheck();
    },
    snapshot: () => this.formSnapshot(),
    canLeave: (proceed) => this.guardLeave(proceed),
    hasUnsavedEdits: () => (this.creatingNew || this.editingCube) && this.formDirty,
    resolveUnsaved: (disposition) => this.guidedResolveUnsaved(disposition),
    whenListReady: () => this.whenReady(),
    // Deep link: which cube is on screen, and how to get back to it on reload.
    currentItem: () => this.selectedCube?.name ?? null,
    restoreItem: (name) => this.restoreCube(name),
  };

  /**
   * Re-select the cube `?item=` names after a page reload, once the cube list has
   * arrived. Lands on the DETAIL view (never the edit form): a refresh is not a
   * request to resume editing, and the detail view works for built-in cubes too.
   * False when no such cube exists any more, leaving the page on its overview.
   */
  private async restoreCube(name: string): Promise<boolean> {
    await this.listReady;
    const found = this.allCubes.find((c) => c.name === name);
    if (!found) return false;
    this.selectCube(found);
    return true;
  }

  /** Resolves when the cube list's initial load settles (see loadCubes); lets a
   *  guided navigate hand the loaded list back in the same turn. */
  private resolveListReady!: () => void;
  private listReady = new Promise<void>((res) => { this.resolveListReady = res; });
  /** Resolves when the source-class options (baseObjects) have loaded — a SEPARATE
   *  fetch from the cube list. A guided navigate must await THIS too, or the
   *  assistant lands with an empty source-class dropdown and invents a class. */
  private resolveBaseObjectsReady!: () => void;
  private baseObjectsReady = new Promise<void>((res) => { this.resolveBaseObjectsReady = res; });

  /** Both the cube list AND the source-class options are loaded — the full context
   *  a guided navigate needs to act in the same turn (list + valid source classes). */
  private whenReady(): Promise<void> {
    return Promise.all([this.listReady, this.baseObjectsReady]).then(() => undefined);
  }

  ngOnDestroy(): void {
    if (this.justAddedTimer) clearTimeout(this.justAddedTimer);
    this.bridge.unregister(this.guidedController);
  }

  /**
   * Leave-guard for view switches (sidebar / guided navigate). When the open form
   * has unsaved edits, BLOCK the switch and show a dialog offering Save draft /
   * Leave without saving / Keep editing. `pendingLeave` holds the deferred
   * navigation so the chosen action can run it. Returns true (allow) when there's
   * nothing to save.
   */
  private pendingLeave: (() => void) | null = null;
  private guardLeave(proceed: () => void): boolean {
    if ((this.creatingNew || this.editingCube) && this.formDirty) {
      this.pendingLeave = proceed;
      this.showLeaveConfirm = true;
      this.cdr.markForCheck();
      return false;
    }
    return true;
  }

  /** Leave prompt → "Save draft": persist the draft, then run the deferred nav. */
  leaveSaveDraft(): void {
    this.showLeaveConfirm = false;
    if (!this.cubeForm.name.trim()) {
      // Can't save without a name — surface it and keep the user on the form.
      this.pendingLeave = null;
      this.formError = 'Cube name is required to save a draft.';
      this.cdr.markForCheck();
      return;
    }
    const proceed = this.pendingLeave;
    this.pendingLeave = null;
    this.runAction('save', proceed ?? undefined);
  }

  /** Leave prompt → "Leave without saving": discard edits and run the deferred nav. */
  leaveWithoutSaving(): void {
    this.showLeaveConfirm = false;
    this.formDirty = false; // discard so a subsequent guard doesn't re-prompt
    const proceed = this.pendingLeave;
    this.pendingLeave = null;
    proceed?.();
  }

  /** Leave prompt → "Keep editing": cancel the navigation, stay on the form. */
  leaveKeepEditing(): void {
    this.showLeaveConfirm = false;
    this.pendingLeave = null;
    this.cdr.markForCheck();
  }

  /**
   * Resolve the open form's unsaved edits on the user's behalf (Guided mode), so
   * the assistant can save-or-discard-then-navigate itself instead of leaving the
   * user to click the leave dialog. `'save'` persists the draft (rejecting if the
   * cube has no name or the save fails); `'discard'` drops the edits. Any open
   * leave dialog is dismissed either way. Returns whether the disposition applied.
   */
  private guidedResolveUnsaved(disposition: 'save' | 'discard'): Promise<SetFieldResult> {
    // Abandon any pending leave dialog — the assistant is driving the decision now.
    this.showLeaveConfirm = false;
    this.pendingLeave = null;
    if (disposition === 'discard') {
      this.formDirty = false; // so the next leave-guard passes cleanly
      this.cdr.markForCheck();
      return Promise.resolve({ applied: true });
    }
    // save: needs a name (same rule as the Save-draft button / leave prompt).
    if (!this.cubeForm.name.trim()) {
      return Promise.resolve({
        applied: false,
        detail: 'The cube has no name yet, so it can\'t be saved as a draft. Ask the user for a name (or to discard the changes) before navigating.',
      });
    }
    // runAction('save', …) is async; resolve only when it truly settles so the
    // navigation proceeds after the draft is persisted, and reports the real error
    // (never hangs the turn) if the save fails.
    return new Promise<SetFieldResult>((resolve) => {
      this.runAction(
        'save',
        () => resolve({ applied: true }),
        (message) => resolve({ applied: false, detail: `Couldn't save the cube draft: ${message}. Ask the user how to proceed.` }),
      );
    });
  }

  // ── Guarded entry points (template) ───────────────────────────
  // Any action that LEAVES the open edit form must first run the leave-guard, so
  // unsaved edits always prompt (Save draft / Leave / Keep editing) — no matter
  // the path. When the form is clean (or none is open) the guard allows it
  // immediately, so there's no prompt. The raw selectCube/openNewForm stay for
  // internal callers (e.g. after a save/cancel that already resolved the form).

  /** Select a cube from the list — guarded so unsaved edits prompt first. */
  attemptSelectCube(cube: CubeDefinition): void {
    if (this.guardLeave(() => this.selectCube(cube))) this.selectCube(cube);
  }

  /** Open the new-cube form — guarded so unsaved edits prompt first. */
  attemptNewForm(): void {
    if (this.guardLeave(() => this.openNewForm())) this.openNewForm();
  }

  /**
   * Scroll the inline error banner into view so a failure isn't missed when the
   * form is scrolled down. Deferred a tick so the *ngIf'd banner has rendered.
   */
  private scrollErrorIntoView(): void {
    this.cdr.markForCheck();
    setTimeout(() => this.formErrorEl?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  }

  /**
   * Mark the form dirty on any edit. This ONLY tracks that there are unsaved
   * edits (so leaving prompts to save) — it does NOT flip the cube's list badge
   * to "draft". A cube becomes 'draft' only when the user explicitly clicks Save
   * Draft (or chooses "Save draft" on the leave prompt); editing a built cube
   * without saving leaves its badge as-is.
   */
  markDirty(): void {
    this.formDirty = true;
  }

  // ── Guided-mode co-pilot (assistant fills fields for the user) ────

  /**
   * Set one form field by dotted path on behalf of Guided mode, creating the
   * dimension / hierarchy / level / measure rows the path implies so the model
   * can fill a nested structure step by step. Ensures a form is open first.
   *
   * Returns whether the value actually LANDED. Dropdown-backed fields (a
   * measure's aggregate/type, a dimension's type, a level's time function or
   * source property, the source class, status) only accept a value that matches
   * an option; anything else is rejected with a detail message so the assistant
   * is told the truth instead of a blind success (the earlier bug — free-text
   * inputs worked, but selects silently ignored an off-list value while the tool
   * still reported OK).
   *
   * Supported paths (examples):
   *   name · displayName · description · sourceClass
   *   dimensions.0.name · dimensions.0.type
   *   dimensions.0.hierarchies.0.name
   *   dimensions.0.hierarchies.0.levels.0.name|sourceProperty|sourceExpression|timeFunction|srcKind
   *   measures.0.name|srcKind|sourceProperty|sourceExpression|aggregate|type
   */
  private async guidedSetField(path: string, value: unknown): Promise<SetFieldResult> {
    if (!this.creatingNew && !this.editingCube) this.openNewForm();
    const parts = path.split('.');
    let result: SetFieldResult;
    try {
      const [head] = parts;
      if (head === 'dimensions') {
        const di = Number(parts[1]);
        this.ensureDimension(di);
        result = await this.setDimensionField(di, parts.slice(2), value);
      } else if (head === 'measures') {
        const mi = Number(parts[1]);
        this.ensureMeasure(mi);
        result = await this.setMeasureField(mi, parts.slice(2), value);
      } else if (head === 'sourceClass') {
        // Resolve the value against the REAL source-class options (matching the
        // fully-qualified className OR its short object name, case/spacing-
        // insensitive) so a plain term like "inventory" lands on the actual class
        // rather than being accepted as an invented one. The options are in the
        // snapshot's availableSourceClasses, so the assistant should pass a real
        // one; this catches near-misses and rejects hallucinations.
        const raw = String(value).trim();
        const res = resolveOption(raw, this.baseObjects.map((o) => ({ value: o.className, labels: [o.objectName] })));
        if (res.status === 'ambiguous') {
          result = { applied: false, detail: `"${raw}" matches more than one source class: ${res.candidates.join(', ')}. Ask the user which one.` };
        } else if (res.status === 'matched') {
          this.cubeForm.sourceClass = res.value;
          this.sourceClassOther = false;
          this.onSourceClassChange();
          await this.sourcePropsLoading;
          result = {
            applied: true,
            detail: this.sourceClassProperties.length
              ? `Source class set to ${this.cubeForm.sourceClass}. Its properties (use these for any sourceProperty; do not invent others): ${this.sourceClassProperties.join(', ')}.`
              : `Source class set to ${this.cubeForm.sourceClass}. No introspectable properties were found; a sourceProperty will be accepted as typed or you can use a sourceExpression.`,
          };
          if (result.applied) this.markDirty();
          this.cdr.markForCheck();
          return result;
        } else if (this.baseObjects.length && !raw.includes('.')) {
          // A plain term that matched nothing, with a loaded list → don't invent a
          // class; tell the assistant to pick a real one (or ask the user).
          result = {
            applied: false,
            detail: `"${raw}" is not one of the available source classes. Choose one of: ${this.baseObjects.map((o) => o.className).join(', ')}.`,
          };
        } else {
          // A fully-qualified name not in the known list — accept via the "Other"
          // custom-class path (a legitimate escape hatch: the list can't be
          // verified against IRIS here), but flag that it wasn't recognized.
          this.cubeForm.sourceClass = raw;
          this.sourceClassOther = true;
          this.onSourceClassChange();
          // Wait for the property list so a follow-up sourceProperty set (often in
          // the same turn) validates against a loaded list, and hand those
          // now-unlocked properties straight back in this result.
          await this.sourcePropsLoading;
          result = {
            applied: true,
            detail: this.sourceClassProperties.length
              ? `Source class set to the custom class ${this.cubeForm.sourceClass} (not in the known list). Its properties: ${this.sourceClassProperties.join(', ')}.`
              : `Source class set to the custom class ${this.cubeForm.sourceClass} (not in the known list); no introspectable properties were found.`,
          };
        }
      } else {
        // Top-level free-text scalar (name/displayName/description).
        (this.cubeForm as unknown as Record<string, unknown>)[head!] = value;
        result = { applied: true };
      }
      if (result.applied) this.markDirty();
      this.cdr.markForCheck();
      return result;
    } catch {
      // Best-effort: an unknown path is reported rather than crashing the turn.
      return { applied: false, detail: `Unknown or unsupported field path "${path}".` };
    }
  }

  /**
   * Assign a value to an enum-backed (dropdown) field, matching case-insensitively
   * against the allowed options. Returns applied:false (with the valid options)
   * when nothing matches, so the caller can report the value was NOT set.
   */
  private assignEnum(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
    options: readonly string[],
    label: string,
  ): SetFieldResult {
    const match = options.find((o) => o.toLowerCase() === String(value).trim().toLowerCase());
    if (!match) {
      return { applied: false, detail: `"${value}" is not a valid ${label}. Choose one of: ${options.join(', ')}.` };
    }
    target[key] = match;
    return { applied: true };
  }

  private ensureDimension(di: number): void {
    while (this.cubeForm.dimensions.length <= di) this.addDimension();
    this.cubeForm.dimensions[di]!.expanded = true;
  }
  private ensureMeasure(mi: number): void {
    while (this.cubeForm.measures.length <= mi) this.addMeasure();
    this.cubeForm.measures[mi]!.expanded = true;
  }

  private async setDimensionField(di: number, rest: string[], value: unknown): Promise<SetFieldResult> {
    const dim = this.cubeForm.dimensions[di]! as unknown as Record<string, unknown>;
    if (rest[0] === 'hierarchies') {
      const hi = Number(rest[1]);
      while ((dim['hierarchies'] as unknown[]).length <= hi) this.addHierarchy(di);
      const hier = this.cubeForm.dimensions[di]!.hierarchies[hi]! as unknown as Record<string, unknown>;
      if (rest[2] === 'levels') {
        const li = Number(rest[3]);
        while ((hier['levels'] as unknown[]).length <= li) this.addLevel(di, hi);
        const level = this.cubeForm.dimensions[di]!.hierarchies[hi]!.levels[li]! as unknown as Record<string, unknown>;
        const field = rest[4]!;
        if (field === 'timeFunction') {
          const r = this.assignEnum(level, field, value, this.TIME_FUNCTIONS, 'time function');
          if (r.applied) level['srcKind'] = 'property'; // a time function reads from a date property
          return r;
        }
        if (field === 'srcKind') return this.assignEnum(level, field, value, ['property', 'expression'], 'source kind');
        if (field === 'sourceProperty') {
          level['srcKind'] = 'property';
          return this.assignSourceProperty(level, value);
        }
        if (field === 'sourceExpression') level['srcKind'] = 'expression';
        level[field] = value;
        return { applied: true };
      }
      hier[rest[2]!] = value;
      return { applied: true };
    }
    if (rest[0] === 'type') return this.assignEnum(dim, 'type', value, this.DIM_TYPES, 'dimension type');
    dim[rest[0]!] = value;
    return { applied: true };
  }

  private async setMeasureField(mi: number, rest: string[], value: unknown): Promise<SetFieldResult> {
    const measure = this.cubeForm.measures[mi]! as unknown as Record<string, unknown>;
    const field = rest[0]!;
    if (field === 'aggregate') return this.assignEnum(measure, field, value, this.AGGREGATES, 'aggregate');
    if (field === 'type') return this.assignEnum(measure, field, value, this.MEASURE_TYPES, 'measure type');
    if (field === 'srcKind') return this.assignEnum(measure, field, value, ['property', 'expression'], 'source kind');
    // Source is a Property XOR an Expression, just like a dimension level. Setting
    // one flips srcKind so the matching input shows and only that value is emitted.
    if (field === 'sourceProperty') {
      measure['srcKind'] = 'property';
      return this.assignSourceProperty(measure, value);
    }
    if (field === 'sourceExpression') measure['srcKind'] = 'expression';
    measure[field] = value;
    return { applied: true };
  }

  /**
   * Set a level's/measure's source property. This is a DROPDOWN of the source
   * class's properties, so the value MUST match one — anything else can't render
   * as a selected <option> and would silently vanish. If a property load is still
   * in flight (the source class was just set), await it first so we validate
   * against the real list rather than accepting optimistically and losing the
   * value to the race. Only if no source class is set (nothing to load) do we
   * accept the value as-is.
   */
  private async assignSourceProperty(level: Record<string, unknown>, value: unknown): Promise<SetFieldResult> {
    const v = String(value).trim();
    // Wait out any in-flight load so the list reflects the current source class.
    if (this.sourcePropsLoading) await this.sourcePropsLoading;
    if (this.sourceClassProperties.length) {
      // Resolve a plain/partial term to the real property name (case/spacing/
      // punctuation-insensitive) rather than demanding an exact match.
      const res = resolveOption(v, this.sourceClassProperties);
      if (res.status === 'ambiguous') {
        return {
          applied: false,
          detail: `"${v}" matches more than one property: ${res.candidates.join(', ')}. Ask the user which one.`,
        };
      }
      if (res.status === 'none') {
        return {
          applied: false,
          detail: `"${v}" is not a property of the source class. Available: ${this.sourceClassProperties.join(', ')}.`,
        };
      }
      level['sourceProperty'] = res.value;
      return { applied: true };
    }
    // No source class chosen yet → no list to validate against. Reject with a
    // clear reason instead of accepting a value the dropdown can't display.
    if (!this.cubeForm.sourceClass) {
      return {
        applied: false,
        detail: `Set the source class first — "sourceProperty" is a dropdown of that class's properties.`,
      };
    }
    // Source class set but the list came back empty (e.g. a custom class the
    // properties endpoint couldn't introspect): accept as-is so guidance isn't
    // blocked, and the value still round-trips to the backend.
    level['sourceProperty'] = v;
    return { applied: true };
  }

  /**
   * Full field map for the assistant's UI-context block. Reflects the create/edit
   * FORM when one is open (EVERY field, including each measure and each
   * dimension→hierarchy→level, so the assistant can answer questions about any of
   * them and know exactly what's filled), otherwise the CUBE the user has selected
   * in the detail view (its complete structure). Mirrors the KPI snapshot: values
   * are included verbatim rather than collapsed to names, so "what does this
   * measure/level do?" is answered for the concrete cube on screen.
   */
  private formSnapshot(): Record<string, unknown> {
    if (this.creatingNew || this.editingCube) {
      const f = this.cubeForm;
      return {
        mode: this.creatingNew ? 'creating new cube' : 'editing cube',
        // The exact ui_set_field paths this form accepts — fill ONLY these.
        validFieldPaths: this.SET_FIELD_PATHS,
        name: f.name,
        displayName: f.displayName,
        description: f.description,
        sourceClass: f.sourceClass,
        // Every option in the Source Class dropdown — the fully-qualified class
        // names the form will accept (plus their short object name for matching).
        // Mirrors the KPI form's availableCubes: the assistant MUST pick a
        // sourceClass from this list (or ask), never invent one like
        // "SC.Data.InventoryItem". `sourceClass` is a dropdown, so a value that
        // matches nothing here can't render; the form resolves a plain term (e.g.
        // "inventory") to the closest class. Empty only if the object list hasn't
        // loaded yet (or failed) — in that case say so rather than guessing.
        availableSourceClasses: this.baseObjects.length
          ? this.baseObjects.map((o) => o.className)
          : '(source-class list not loaded yet — do not guess a class; wait or ask the user)',
        sourceClassChoices: this.baseObjects.map((o) => ({ objectName: o.objectName, className: o.className })),
        measures: f.measures.map((m) => ({
          name: m.name,
          displayName: m.displayName,
          srcKind: m.srcKind,
          sourceProperty: m.sourceProperty,
          sourceExpression: m.sourceExpression,
          aggregate: m.aggregate,
          type: m.type,
        })),
        dimensions: f.dimensions.map((d) => ({
          name: d.name,
          displayName: d.displayName,
          type: d.type,
          hierarchies: d.hierarchies.map((h) => ({
            name: h.name,
            displayName: h.displayName,
            levels: h.levels.map((l) => ({
              name: l.name,
              displayName: l.displayName,
              srcKind: l.srcKind,
              sourceProperty: l.sourceProperty,
              sourceExpression: l.sourceExpression,
              timeFunction: l.timeFunction,
            })),
          })),
        })),
        // Options available in the source-class-dependent dropdown, so the
        // assistant suggests only properties that actually exist. Made explicit
        // so an empty list never reads as "no constraint" (which invited the
        // model to guess a property): if the source class is set but no
        // properties are loaded yet, say so; if unset, say a source class must
        // be chosen first. The assistant must pick from this list or ask —
        // NEVER invent a property name.
        sourceClassProperties: !this.cubeForm.sourceClass
          ? '(source class not set — choose it first; no properties available yet)'
          : this.sourceClassProperties.length
            ? this.sourceClassProperties
            : '(loading properties for the source class — do not guess; wait or ask the user)',
      };
    }
    if (this.selectedCube) {
      const c = this.selectedCube;
      const d = this.selectedDetail;
      return {
        mode: 'viewing cube detail',
        selectedCube: c.name,
        sourceClass: c.sourceClass || d?.sourceClass || '',
        className: d?.className,
        factClass: d?.factClass,
        state: c.state ?? 'built',
        editable: d?.editable ?? c.editable ?? false,
        exists: d?.exists,
        factCount: d?.factCount,
        measures: (d?.measures ?? []).map((m) => ({
          name: m.name,
          caption: m.caption,
          type: m.type,
          factName: m.factName,
        })),
        dimensions: (d?.dimensions ?? []).map((dim) => ({
          name: dim.name,
          kind: this.dimKind(dim),
          hierarchies: dim.hierarchies.map((h) => ({
            name: h.name,
            levels: h.levels.map((l) => ({
              name: l.name,
              caption: l.caption,
              type: l.type,
              sourceProperty: l.sourceProperty,
              sourceExpression: l.sourceExpression,
            })),
          })),
        })),
        listings: (d?.listings ?? []).map((l) => ({ name: l.name, type: l.type, order: l.order, fields: l.fields })),
      };
    }
    // List view: no cube selected, but the user may ask about ANY listed cube —
    // surface a compact summary of every one (full structure loads on selection).
    const cubes = this.allCubes.map((c) => ({
      name: c.name,
      sourceClass: c.sourceClass ?? '',
      state: c.state ?? 'built',
      editable: c.editable ?? false,
    }));
    return { mode: 'cube list (no cube selected)', cubeCount: cubes.length, cubes };
  }

  ngOnInit(): void {
    // Expose this form to the assistant's Guided mode.
    this.bridge.register(this.guidedController);
    this.scModel.getObjects().subscribe({
      next: objs => {
        // The cube's sourceClass must be the FULLY-QUALIFIED class name
        // (e.g. SC.Data.SalesOrder) or its DependsOn fails to compile (#5373).
        // The dropdown value is therefore the className; we keep an objectName
        // map for the read-only /objects/{objectName} properties lookup, which
        // takes the short object name, not the class.
        const list = (Array.isArray(objs) ? objs : []) as Array<{ objectName?: string; className?: string }>;
        this.baseObjects = list
          .filter((o) => o.className)
          .map((o) => ({ objectName: o.objectName ?? o.className!, className: o.className! }))
          .sort((a, b) => a.objectName.localeCompare(b.objectName));
        this.classToObjectName = {};
        for (const o of this.baseObjects) this.classToObjectName[o.className] = o.objectName;
        this.resolveBaseObjectsReady(); // options available (idempotent)
        this.cdr.markForCheck();
      },
      // Even on error, unblock a waiting guided navigate — it'll just see an empty
      // source-class list (and the snapshot says so) rather than hang.
      error: () => this.resolveBaseObjectsReady(),
    });
    this.loadCubes();
  }

  /**
   * Load the real cube list from the backend (/api/cubes). The list endpoint
   * returns a summary (name, class, source class); the rich dimension/measure
   * detail is only needed inside the edit form, so we keep the display model
   * lightweight here and hydrate full definitions on demand elsewhere.
   */
  loadCubes(selectName?: string): void {
    this.loading = true;
    this.loadError = '';
    this.cdr.markForCheck();
    this.cubes.list().subscribe({
      next: ({ cubes }) => {
        this.allCubes = (cubes ?? []).map((c) => this.summaryToDisplay(c));
        this.loading = false;
        this.resolveListReady(); // list populated (idempotent after first call)
        this.onFilterChange();
        if (selectName) {
          const found = this.allCubes.find((c) => c.name === selectName);
          if (found) this.selectCube(found);
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        this.resolveListReady(); // settle even on error so navigate doesn't hang
        this.loadError = err?.error?.error || err?.message || 'Failed to load cubes.';
        this.allCubes = [];
        this.onFilterChange();
      },
    });
  }

  /** Map a backend cube summary to the component's display model. */
  private summaryToDisplay(c: CubeSummary): CubeDefinition {
    const state = c.state ?? (c.editable ? 'draft' : 'built');
    return {
      name: c.cubeName,
      displayName: c.cubeName,
      description: '',
      sourceClass: c.sourceClass ?? '',
      status: state.charAt(0).toUpperCase() + state.slice(1),
      state,
      editable: c.editable,
      dimensions: [],
      measures: [],
    };
  }

  // ── List sorted by lifecycle state (draft → compiled → built) ─
  /** A single flat list ordered by state; the row keeps its state badge. */
  get sortedCubes(): CubeDefinition[] {
    const rank: Record<string, number> = { draft: 0, compiled: 1, built: 2 };
    return [...this.filteredCubes].sort((a, b) => {
      const ra = rank[a.state ?? 'built'] ?? 2;
      const rb = rank[b.state ?? 'built'] ?? 2;
      if (ra !== rb) return ra - rb;
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    });
  }

  onFilterChange(): void {
    this.filteredCubes = this.selectedBaseObject
      ? this.allCubes.filter(c => c.sourceClass === this.selectedBaseObject)
      : [...this.allCubes];
    // Match by NAME, not object identity. loadCubes() rebuilds allCubes with
    // fresh objects, so a reference check (.includes) would drop the selection on
    // every refresh (e.g. after a build) and blank the detail. Re-point the
    // selection at the fresh object if it's still in the list; only clear it when
    // the cube is genuinely gone.
    if (this.selectedCube) {
      const match = this.filteredCubes.find((c) => c.name === this.selectedCube!.name);
      this.selectedCube = match ?? null;
    }
    this.cdr.markForCheck();
  }

  selectCube(cube: CubeDefinition): void {
    this.selectedCube = cube;
    this.creatingNew = false;
    this.editingCube = false;
    this.selectedDetail = null;
    this.detailError = '';
    this.detailLoading = true;
    this.cdr.markForCheck();
    // Fetch the full structure (measures, dimensions→hierarchies→levels,
    // listings) from the backend, which reads the D2CLIENT Info API.
    this.cubes.get(cube.name).subscribe({
      next: ({ cube: detail }) => {
        // Ignore a stale response if the user has since switched cubes — do NOT
        // touch detailLoading either, or an out-of-order response would clear the
        // spinner for the cube that's actually still loading.
        if (this.selectedCube?.name !== cube.name) return;
        this.detailLoading = false;
        this.selectedDetail = detail;
        this.cdr.markForCheck();
      },
      error: (err) => {
        if (this.selectedCube?.name !== cube.name) return;
        this.detailLoading = false;
        // Surface the failure instead of silently leaving a blank panel (the old
        // bug: an empty shell with no error and no retry). Edit/Delete still show
        // because they're gated on the list summary's `editable`, so the user can
        // act; a retry link reloads the detail.
        this.detailError = err?.error?.error || err?.message || 'Could not load the cube structure.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Retry the detail fetch for the currently selected cube (after a load error). */
  retryDetail(): void {
    if (this.selectedCube) this.selectCube(this.selectedCube);
  }

  /**
   * Whether the selected cube is editable. Prefer the detail's `editable`, but
   * fall back to the list summary's — the list value is always available (no
   * async wait) and is computed the same way (isWorkbenchCube), so a slow/failed
   * detail fetch, or a transient backend dictionary hiccup that flips detail
   * `editable` to false, never hides the Edit/Delete buttons for a real
   * Workbench cube. Matches the template gate.
   */
  get selectedEditable(): boolean {
    return (this.selectedDetail?.editable ?? this.selectedCube?.editable) ?? false;
  }

  get totalCount(): number { return this.filteredCubes.length; }

  // ── Form open/close ───────────────────────────────────────────

  /**
   * Guided mode: land on an existing cube by name.
   *  - mode "view" (default): select it and show its detail/definition — works for
   *    ANY cube, including non-editable built-in SCO cubes. Use when the user just
   *    wants to SEE the cube (e.g. the cube backing a KPI).
   *  - mode "edit": reopen it in the edit form. Only an editable Workbench cube
   *    saved as a draft can be edited; a built-in or non-draft cube fails clearly
   *    and STAYS on the detail view so the user still sees it. Nothing is auto-saved.
   * The component remounts on navigation, so we reload the list and resolve against
   * fresh data.
   */
  private guidedOpenEntity(name: string, opts?: { mode?: 'view' | 'edit' }): Promise<SetFieldResult> {
    const target = name.trim();
    const edit = opts?.mode === 'edit';
    return new Promise((resolve) => {
      this.cubes.list().subscribe({
        next: ({ cubes }) => {
          this.allCubes = (cubes ?? []).map((c) => this.summaryToDisplay(c));
          this.loading = false;
          this.onFilterChange();
          const found = this.allCubes.find((c) => c.name === target);
          if (!found) {
            // List the real cubes (name + source class) so the assistant can pick
            // the right one — the user often refers to a cube by its base class.
            const available = this.allCubes
              .map((c) => `${c.name}${c.sourceClass ? ` (source: ${c.sourceClass})` : ''}`)
              .join(', ');
            resolve({
              applied: false,
              detail: `No cube named "${target}" was found. Available cubes: ${available || '(none)'}.`,
            });
            return;
          }
          // Always select so the user SEES the cube's definition (detail view).
          this.selectCube(found);
          if (!edit) {
            this.cdr.markForCheck();
            resolve({ applied: true, detail: `Opened the detail view for cube "${target}".` });
            return;
          }
          if (!found.editable) {
            this.cdr.markForCheck();
            resolve({
              applied: false,
              detail: `"${target}" is a built-in SCO cube and cannot be edited — it's showing in detail view instead. Only a Workbench cube can be edited.`,
            });
            return;
          }
          this.openEditForm(); // reads selectedEditable (summary-authoritative), fetches the definition
          this.cdr.markForCheck();
          resolve({ applied: true, detail: `Reopened the cube "${target}" in edit mode.` });
        },
        error: (err) => {
          this.loading = false;
          resolve({ applied: false, detail: err?.error?.error || err?.message || 'Could not load cubes.' });
        },
      });
    });
  }

  /**
   * Load the selected cube's saved definition into the edit form.
   *
   * `onLoaded` runs only once the definition is actually IN the form — the fetch is
   * async, so the detail view's Compile/Build shortcuts must chain on it rather than
   * calling straight through (acting on the form a tick later would act on the
   * PREVIOUS cube's form, or an empty one).
   */
  openEditForm(onLoaded?: () => void): void {
    const cube = this.selectedCube;
    if (!cube) return;
    // Only Workbench-created cubes are editable. Use the list-authoritative
    // editability (immune to a slow/failed detail fetch) so a genuine Workbench
    // cube is never wrongly blocked.
    if (!this.selectedEditable) {
      this.formError = 'This cube is an SCO built-in and cannot be edited in the Workbench.';
      return;
    }
    // The editable definition is NOT the runtime detail — fetch the parsed
    // class definition from the backend (source properties, aggregates, time
    // functions live only in the class, not the D2CLIENT Info API).
    this.editOriginalName = cube.name;
    this.formError = '';
    this.formSaving = true; // reuse as a "loading definition" flag
    this.cdr.markForCheck();
    this.cubes.getDefinition(cube.name).subscribe({
      next: ({ definition }) => {
        this.formSaving = false;
        this.cubeForm = this.definitionToForm(definition);
        this.editingCube = true;
        this.creatingNew = false;
        this.formDirty = false; // freshly loaded — not dirty until the user edits
        this.sourceClassProperties = [];
        // A source class not in the /objects list (a custom class) is shown as
        // free text so its real value is visible and editable.
        this.sourceClassOther =
          !!this.cubeForm.sourceClass && !this.baseObjects.some((o) => o.className === this.cubeForm.sourceClass);
        if (this.cubeForm.sourceClass) this.onSourceClassChange();
        this.cdr.markForCheck();
        onLoaded?.();
      },
      error: (err) => {
        this.formSaving = false;
        this.formError = err?.error?.error || err?.message || 'Could not load the cube definition for editing.';
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * Compile / Build the SELECTED cube straight from its detail view, without the user
   * having to open the form first.
   *
   * Runs exactly what the form's own Compile/Build buttons run — the saved definition
   * is loaded into the form and the same validated action is dispatched — so there is
   * no second, subtly different path to IRIS. Two deliberate differences from pressing
   * the buttons inside the form:
   *   • it waits for the definition to load (see openEditForm's `onLoaded`);
   *   • on success it returns to the detail view, since that is where the user was —
   *     whereas the in-form buttons keep the user on the form to carry on editing.
   * A validation problem leaves the form open with the error showing, which is the one
   * place the user can actually fix it.
   */
  compileSelectedCube(): void { this.runFromDetail('compile'); }
  buildSelectedCube(): void { this.runFromDetail('build'); }

  private runFromDetail(mode: 'compile' | 'build'): void {
    if (!this.selectedCube || this.formBusy || this.formSaving) return;
    const name = this.selectedCube.name;
    this.openEditForm(() => {
      if (!this.validateForBuild()) { this.cdr.markForCheck(); return; }
      this.runAction(mode, () => {
        // Back to the detail view for the cube we started from, with the list
        // refreshed so its state badge reflects what just happened.
        this.editingCube = false;
        this.creatingNew = false;
        this.loadCubes(name);
        this.cdr.markForCheck();
      });
    });
  }

  /** Map a backend CubeDefinition (from /definition) into the edit form model. */
  private definitionToForm(def: any): CubeForm {
    const dims: DimForm[] = (def?.dimensions ?? []).map((d: any) => ({
      name: d.name ?? '',
      displayName: d.displayName ?? '',
      type: d.type ?? 'data',
      expanded: false,
      hierarchies: (d.hierarchies ?? []).map((h: any) => ({
        name: h.name ?? 'H1',
        displayName: h.displayName ?? '',
        levels: (h.levels ?? []).map((l: any) => ({
          name: l.name ?? '',
          displayName: l.displayName ?? '',
          sourceProperty: l.sourceProperty ?? '',
          sourceExpression: l.sourceExpression ?? '',
          timeFunction: l.timeFunction ?? '',
          sort: l.sort ?? 'asc',
          hidden: l.hidden ?? false,
          // Pick the kind from whichever source the stored level carries.
          srcKind: l.sourceExpression ? 'expression' : 'property',
        })),
      })),
    }));
    const measures: MeasureForm[] = (def?.measures ?? []).map((m: any) => ({
      name: m.name ?? '',
      displayName: m.displayName ?? '',
      sourceProperty: m.sourceProperty ?? '',
      sourceExpression: m.sourceExpression ?? '',
      // Pick the kind from whichever source the stored measure carries.
      srcKind: m.sourceExpression ? 'expression' : 'property',
      aggregate: m.aggregate ?? 'SUM',
      type: m.type ?? 'number',
      expanded: false,
    }));
    return {
      name: def?.cubeName ?? '',
      displayName: def?.displayName ?? '',
      description: def?.description ?? '',
      sourceClass: def?.sourceClass ?? '',
      dimensions: dims,
      measures,
    };
  }

  cancelForm(): void {
    // Only double-check when there are unsaved edits to lose; otherwise leave
    // immediately (nothing to discard).
    if (this.formDirty) {
      this.showCancelConfirm = true;
      this.cdr.markForCheck();
      return;
    }
    this.performCancel();
  }

  /** Discard the form and return to the edited cube's detail view. */
  performCancel(): void {
    const wasEditing = this.editingCube;
    const name = this.editOriginalName;
    this.showCancelConfirm = false;
    this.creatingNew = false;
    this.editingCube = false;
    this.formError = '';
    this.buildError = null;
    this.formDirty = false; // discard: don't auto-save on the next navigate
    // Reload so an edited-but-cancelled cube shows its real persisted state, then
    // jump to that cube's detail view (Cancel is the only way to leave the form).
    this.loadCubes(wasEditing && name ? name : undefined);
    this.cdr.markForCheck();
  }

  /** Save the current form as a draft — allows an incomplete cube. */
  saveDraft(): void {
    if (!this.cubeForm.name.trim()) { this.formError = 'Cube name is required.'; return; }
    this.runAction('save');
  }

  /** Save + compile the cube class into IRIS (no build). */
  compileCube(): void {
    if (!this.validateForBuild()) return;
    this.runAction('compile');
  }

  /** Save + compile + build (populate) the cube. */
  buildCube(): void {
    if (!this.validateForBuild()) return;
    this.runAction('build');
  }

  /** Full validation required before compile/build (save is more lenient). */
  private validateForBuild(): boolean {
    if (!this.cubeForm.name.trim()) { this.formError = 'Cube name is required.'; return false; }
    if (!this.cubeForm.sourceClass) { this.formError = 'Source class (base object) is required.'; return false; }
    if (!this.cubeForm.measures.some(m => m.name.trim() && !m.name.trim().startsWith('%'))
        && !this.cubeForm.dimensions.some(d => d.name.trim())) {
      this.formError = 'Add at least one dimension or measure.';
      return false;
    }
    // The following mirror the backend validateCubeDefinition rules so the user
    // sees a clear inline error immediately (like any other required field),
    // instead of an untranslatable IRIS #5001/#5490/<SUBSCRIPT>/<UNDEFINED> error.
    const isTime = (d: DimForm) => d.type === 'time';

    for (const d of this.cubeForm.dimensions) {
      if (!d.name.trim()) continue;
      // A named dimension needs at least one hierarchy with at least one NAMED level.
      const namedLevels = d.hierarchies.flatMap((h) => h.levels.filter((l) => l.name.trim()));
      if (!namedLevels.length) {
        this.formError =
          `Dimension “${d.name.trim()}” needs at least one level with a name. ` +
          `Add a level (give it a name and a source) or remove the dimension.`;
        return false;
      }
      // A hierarchy that carries a named level must itself be named.
      const unnamedHier = d.hierarchies.find(
        (h) => !h.name.trim() && h.levels.some((l) => l.name.trim()),
      );
      if (unnamedHier) {
        this.formError = `A hierarchy in dimension “${d.name.trim()}” needs a name (e.g. “H1”).`;
        return false;
      }
      // Each named level needs a SOURCE: a property, an expression, or (time dims)
      // a time function. A level with no source builds into a <UNDEFINED> crash.
      const noSource = namedLevels.find(
        (l) => !l.sourceProperty.trim() && !(l.sourceExpression ?? '').trim() && !(l.timeFunction ?? '').trim(),
      );
      if (noSource) {
        this.formError = isTime(d)
          ? `Level “${noSource.name.trim()}” in dimension “${d.name.trim()}” needs a source: pick a source property or a time function.`
          : `Level “${noSource.name.trim()}” in dimension “${d.name.trim()}” needs a source: choose a source property or enter a source expression.`;
        return false;
      }
    }

    // A measure's source is OPTIONAL — a measure with no source property/
    // expression defaults to a COUNT of the source rows (the backend generator
    // coerces the aggregate to COUNT), so we do not require one here.
    return true;
  }

  /**
   * `onDone` runs after a SUCCESSFUL action — used by the leave prompt's "Save
   * draft" so the deferred navigation happens once the draft is persisted. On
   * failure it is not called (the user stays on the form to see the error).
   */
  private runAction(mode: 'save' | 'compile' | 'build', onDone?: () => void, onError?: (message: string) => void): void {
    this.formError = '';
    this.buildError = null;
    this.formBusy = mode;
    this.cdr.markForCheck();

    const definition = formToCubeDefinition(this.cubeForm);
    const name = this.cubeForm.name.trim();
    // When editing, pass the original name so a rename cleans up the old cube
    // (draft + IRIS class) instead of leaving a duplicate.
    const original = this.editingCube ? this.editOriginalName : undefined;
    const req$ =
      mode === 'save' ? this.cubes.save(definition, original)
      : mode === 'compile' ? this.cubes.compile(definition, original)
      : this.cubes.build(definition, original);

    req$.subscribe({
      next: (result) => {
        this.formBusy = null;
        if (result?.ok === false) {
          this.formError = result.message || `Cube ${mode} failed.`;
          this.toasts.error(this.formError);
          this.cdr.markForCheck();
          onError?.(this.formError);
          return;
        }
        this.formDirty = false;
        // All actions (save/compile/build) keep the user ON the edit page — only
        // Cancel leaves. After a successful action the cube now exists under this
        // name, so switch a "new" form into edit mode (and track the name) so a
        // subsequent rename cleans up the old cube instead of duplicating it.
        this.creatingNew = false;
        this.editingCube = true;
        this.editOriginalName = name;
        this.toasts.success(SUCCESS_MESSAGE[mode](name));
        // Refresh the list (states/badges) WITHOUT selecting away from the form.
        this.loadCubes();
        this.cdr.markForCheck();
        // A deferred navigation (leave prompt → "Save draft") runs only after the
        // save succeeded, so the draft is persisted before we leave the form.
        onDone?.();
      },
      error: (err) => {
        this.formBusy = null;
        const body = err?.error;
        // A BUILD_FAILED envelope carries the deduped per-row errors IRIS
        // recorded (backend already stripped the "run %PrintBuildErrors
        // yourself" hint). Show them in a foldable box so a long list doesn't
        // flood the form; the toast + inline banner stay a one-line summary.
        if (body?.code === 'BUILD_FAILED' && Array.isArray(body?.samples) && body.samples.length) {
          const lines = (body.samples as Array<{ message: string; count: number }>).map((s) =>
            s.count > 1 ? `(×${s.count}) ${s.message}` : s.message,
          );
          const total = typeof body.total === 'number' ? body.total : lines.length;
          const summary =
            total === 1
              ? `Build failed with 1 row error.`
              : `Build failed with ${total} row error${total === 1 ? '' : 's'}` +
                (body.distinct && body.distinct < total ? ` (${body.distinct} distinct).` : '.');
          this.buildError = { summary, lines, expanded: lines.length <= 3 };
          this.formError = '';
          this.toasts.error(summary);
          this.cdr.markForCheck();
          onError?.(summary);
          return;
        }
        this.formError =
          body?.problems?.join('\n') ||
          body?.details?.join?.('\n') ||
          body?.error ||
          err?.message ||
          `Cube ${mode} failed.`;
        this.toasts.error(this.formError);
        this.cdr.markForCheck();
        onError?.(this.formError);
      },
    });
  }

  /** Ask for confirmation before deleting the selected cube. */
  deleteSelectedCube(): void {
    if (!this.selectedCube || this.deleting) return;
    this.showDeleteConfirm = true;
    this.cdr.markForCheck();
  }

  /** Perform the delete once the user confirms (drops fact data + class on IRIS). */
  confirmDelete(): void {
    const cube = this.selectedCube;
    this.showDeleteConfirm = false;
    if (!cube || this.deleting) return;
    this.deleting = true;
    this.cdr.markForCheck();
    const name = cube.name;
    this.cubes.delete(name).subscribe({
      next: () => {
        this.deleting = false;
        this.selectedCube = null;
        this.toasts.success(`Cube “${name}” deleted.`);
        this.loadCubes();
      },
      error: (err) => {
        this.deleting = false;
        this.loadError = err?.error?.error || err?.message || 'Failed to delete cube.';
        this.toasts.error(this.loadError);
        this.cdr.markForCheck();
      },
    });
  }

  // ── Dimension helpers ─────────────────────────────────────────

  /**
   * The block "+ Add Dimension" / "+ Add Measure" just appended, so the form can scroll
   * to it and ring it briefly. A new block lands at the BOTTOM of the section — with a
   * few dimensions already defined that is below the fold, so the click appeared to do
   * nothing and the user had to go looking for it.
   */
  justAddedBlock: { kind: 'dimension' | 'measure'; index: number } | null = null;
  private justAddedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly injector = inject(Injector);
  private readonly host = inject(ElementRef<HTMLElement>);

  isJustAdded(kind: 'dimension' | 'measure', index: number): boolean {
    return this.justAddedBlock?.kind === kind && this.justAddedBlock.index === index;
  }

  /**
   * Bring a just-added block into view and mark it.
   *
   * The scroll waits for `afterNextRender`: the block does not exist in the DOM until
   * change detection has run, and this app is zoneless, so scrolling straight after the
   * push would query for an element that isn't there yet. The ring clears itself on a
   * timer — it is a "here it is" cue, not a state.
   */
  private revealNewBlock(kind: 'dimension' | 'measure', index: number): void {
    this.justAddedBlock = { kind, index };
    this.cdr.markForCheck();
    afterNextRender(
      () => {
        const el = (this.host.nativeElement as HTMLElement).querySelector(
          `[data-new-block="${kind}-${index}"]`,
        ) as HTMLElement | null;
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      { injector: this.injector },
    );
    if (this.justAddedTimer) clearTimeout(this.justAddedTimer);
    this.justAddedTimer = setTimeout(() => {
      this.justAddedBlock = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  addDimension(): void {
    this.cubeForm.dimensions.push({
      name: '', displayName: '', type: 'data', expanded: true,
      hierarchies: [{ name: 'H1', displayName: '', levels: [this.emptyLevel()] }],
    });
    this.revealNewBlock('dimension', this.cubeForm.dimensions.length - 1);
  }

  removeDimension(di: number): void {
    const label = this.cubeForm.dimensions[di]?.name?.trim() || 'this dimension';
    this.askConfirm('Remove dimension', `Remove “${label}” and its hierarchies/levels?`, () => {
      this.cubeForm.dimensions.splice(di, 1);
      this.markDirty();
    });
  }

  /** Collapse/expand a dimension block. The header IS the only control — a
   *  collapsed block shows its hier/level summary pills instead of the body. */
  toggleDimension(dim: DimForm): void { dim.expanded = !dim.expanded; }

  addHierarchy(di: number): void {
    this.cubeForm.dimensions[di].hierarchies.push({ name: '', displayName: '', levels: [this.emptyLevel()] });
  }

  removeHierarchy(di: number, hi: number): void {
    const label = this.cubeForm.dimensions[di]?.hierarchies[hi]?.name?.trim() || 'this hierarchy';
    this.askConfirm('Remove hierarchy', `Remove “${label}” and its levels?`, () => {
      this.cubeForm.dimensions[di].hierarchies.splice(hi, 1);
      this.markDirty();
    });
  }

  addLevel(di: number, hi: number): void {
    this.cubeForm.dimensions[di].hierarchies[hi].levels.push(this.emptyLevel());
  }

  removeLevel(di: number, hi: number, li: number): void {
    const label = this.cubeForm.dimensions[di]?.hierarchies[hi]?.levels[li]?.name?.trim() || 'this level';
    this.askConfirm('Remove level', `Remove “${label}”?`, () => {
      this.cubeForm.dimensions[di].hierarchies[hi].levels.splice(li, 1);
      this.markDirty();
    });
  }

  private emptyLevel(): LevelForm {
    return { name: '', displayName: '', sourceProperty: '', sourceExpression: '', timeFunction: '', sort: 'asc', hidden: false, srcKind: 'property' };
  }

  // ── Measure helpers ───────────────────────────────────────────

  addMeasure(): void {
    this.cubeForm.measures.push({
      name: '', displayName: '', sourceProperty: '', sourceExpression: '', srcKind: 'property',
      aggregate: 'SUM', type: 'number', expanded: true,
    });
    this.revealNewBlock('measure', this.cubeForm.measures.length - 1);
  }

  removeMeasure(mi: number): void {
    const label = this.cubeForm.measures[mi]?.name?.trim() || 'this measure';
    this.askConfirm('Remove measure', `Remove the measure “${label}”?`, () => {
      this.cubeForm.measures.splice(mi, 1);
      this.markDirty();
    });
  }

  toggleMeasure(m: MeasureForm): void { m.expanded = !m.expanded; }

  trackByIndex(index: number): number { return index; }

  // ── Conversion helpers ────────────────────────────────────────

  private emptyForm(): CubeForm {
    return {
      name: '', displayName: '', description: '', sourceClass: '',
      dimensions: [], measures: [],
    };
  }

  isTimeDimension(dim: DimForm): boolean { return dim.type === 'time'; }

  /**
   * Classify a detail-view dimension (from D2CLIENT) as 'time' or 'data'. The
   * Info API doesn't return the dimension type directly, but time levels carry a
   * `type` like "year"/"month"/"quarter"/"day", so any such level ⇒ time.
   */
  dimKind(dim: { hierarchies: Array<{ levels: Array<{ type?: string }> }> }): 'time' | 'data' {
    const timeTypes = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'date'];
    const isTime = dim.hierarchies.some((h) =>
      h.levels.some((l) => l.type && timeTypes.some((t) => l.type!.toLowerCase().includes(t))),
    );
    return isTime ? 'time' : 'data';
  }

  /**
   * Handle the source-class dropdown. Choosing "Other" switches to a free-text
   * field so a custom class (not in the /objects list) can be entered. Otherwise
   * the value is the fully-qualified class name.
   */
  onSourceClassSelectChange(value: string): void {
    if (value === '__other__') {
      this.sourceClassOther = true;
      this.cubeForm.sourceClass = '';
      this.sourceClassProperties = [];
    } else {
      this.sourceClassOther = false;
      this.cubeForm.sourceClass = value;
      this.onSourceClassChange();
    }
    this.markDirty();
  }

  onSourceClassChange(): void {
    this.sourceClassProperties = [];
    if (!this.cubeForm.sourceClass) {
      this.sourcePropsLoading = null;
      return;
    }
    // The source class can be ANY compiled class — a custom scmodel object OR an
    // SCO built-in (e.g. SC.Data.SalesOrder). Use the backend cube endpoint that
    // resolves any class and lists its real properties, so the dropdown/context
    // is populated for built-ins too (the scmodel /objects API only knew custom
    // objects, which left the assistant guessing for a real SCO source class).
    const targetClass = this.cubeForm.sourceClass;
    // Track the load as a promise so Guided mode can await it before validating a
    // sourceProperty. Resolve on both success and error (never reject) so a
    // waiting setField isn't left hanging.
    this.sourcePropsLoading = new Promise<void>((resolve) => {
      this.cubes.sourceProperties(targetClass).subscribe({
        next: (res) => {
          // Ignore a stale response if the source class changed while in flight.
          if (this.cubeForm.sourceClass === targetClass) {
            this.sourceClassProperties = (res?.properties ?? [])
              .map((p) => p.name)
              .filter(Boolean)
              .sort();
            this.cdr.markForCheck();
          }
          resolve();
        },
        error: () => resolve(),
      });
    });
  }

  openNewForm(): void {
    this.creatingNew = true;
    this.editingCube = false;
    this.selectedCube = null;
    this.cubeForm = this.emptyForm();
    this.formError = '';
    this.buildError = null;
    this.formDirty = false;
    this.editOriginalName = '';
    this.sourceClassProperties = [];
    this.sourcePropsLoading = null;
    this.sourceClassOther = false;
    this.cdr.markForCheck();
  }
}

/** Success-toast wording per action, so each outcome reads specifically. */
const SUCCESS_MESSAGE: Record<'save' | 'compile' | 'build', (name: string) => string> = {
  save: (name) => `Cube “${name}” saved as a draft.`,
  compile: (name) => `Cube “${name}” compiled into SCO.`,
  build: (name) => `Cube “${name}” built successfully.`,
};
