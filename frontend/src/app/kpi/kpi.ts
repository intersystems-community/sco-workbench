import { Component, OnInit, OnDestroy, HostListener, ChangeDetectorRef, ChangeDetectionStrategy, ViewChild, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of, Subscription } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import {
  KpiApiService,
  type KpiDefinition,
  type KpiDraft,
} from '../services/kpi.service';
import { DashboardChartService, type CubeShape } from '../dashboard/services/dashboard-chart.service';
import { memberLabel, NULL_MEMBER_KEY } from '../cube/member-label';
import { composeCondition, parseCondition, type ConditionOperator, type ParsedCondition } from '../cube/condition-mdx';
import { composeComparison, parseComparison, type ComparisonOp } from './comparison-mdx';
import { ADVANCED_MDX_CONDITIONS, parsesToAdvancedForm, usesAdvancedMdx } from './mdx-feature-flags';
import { analyzeConditions, conditionsMergeable, lintFreeTextConditions, type Diagnostic } from './analyze-conditions';
import { makeDragChip } from '../cube/drag-chip';
import { humanizeField } from '../dashboard/humanize';
import { CubeService } from '../services/cube.service';
import { KpiGroupService, UNGROUPED } from '../services/kpi-group.service';
import { getNamespace } from '../core/api';
import { ConfirmDialogComponent } from '../shared/confirm-dialog';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult } from '../core/workbench-bridge.service';
import { resolveOption } from '../core/option-match';
import { GuideHighlightDirective } from '../core/guide-highlight.directive';
import { CloseOnOutsideDirective } from '../core/close-on-outside.directive';
import { ToastService } from '../core/toast.service';
import { KpiHealthService, type KpiHealth } from '../dashboard/services/kpi-health.service';

/** Narrow a widened operator to the comparison lane. */
function isComparisonOp(op: ConditionOperator | ComparisonOp): op is ComparisonOp {
  return op === '>' || op === '>=' || op === '<' || op === '<=';
}

/** The level dropdown's OPTION LABEL: humanized "Dimension › Level" derived from the MDX spec, NOT the
 *  display caption. A level name (e.g. "Product Family", "Status") repeats across dimensions, so a
 *  bare caption is ambiguous in the closed <select> (Karsten 2026-09-18); prefixing the dimension
 *  disambiguates, and deriving from the spec (`[dimension].[hierarchy].[level]`) keeps it lined up with
 *  the raw MDX the user sees on hover / in the MDX view. Takes the FIRST bracket part (dimension) and
 *  LAST bracket part (level), skipping the hierarchy; falls back to the raw spec if it does not parse. */
function levelOptionLabel(spec: string): string {
  const parts = Array.from(spec.matchAll(/\[([^\]]+)\]/g), (m) => m[1]);
  if (parts.length < 2) return spec;
  const dimension = parts[0];
  const level = parts[parts.length - 1];
  return `${humanizeField(dimension)} › ${humanizeField(level)}`;
}

/** A KPI's lifecycle state in the Workbench. */
type KpiState = 'draft' | 'created';

/** A KPI as shown in the list: its definition plus its resolved lifecycle state. */
interface ListedKpi extends KpiDefinition {
  /** 'created' = exists in IRIS; 'draft' = only saved locally / has unsubmitted edits. */
  state: KpiState;
}

/** A list group — one per user-defined group name, plus a trailing "Ungrouped" bucket. */
interface KpiGroup {
  /** Group name (user-defined), or the `UNGROUPED` sentinel. */
  name: string;
  label: string;
  items: ListedKpi[];
  expanded: boolean;
}

/** A dimension row in the create/edit form. */
interface DimensionForm {
  name: string;
  label: string;
  cubeDimension: string;
}

/**
 * The full create/edit form model. Mirrors SC.Core.Analytics.KPI.KpiDefinition +
 * DeepseeKpiSpec so every field IRIS accepts is authorable. Conditional fields
 * (baseConditions, issue settings) are only sent when their gate is on — see
 * `formToDefinition`.
 */
interface KpiForm {
  // Basic
  name: string;
  label: string;
  description: string;
  type: string;
  baseObject: string;
  status: string;
  // Thresholds
  watchingThreshold: number | null;
  warningThreshold: number | null;
  // Issue settings
  issueKpi: boolean;
  defaultIssueSeverity: number | null;
  analysisService: string;
  // DeepSee spec (namespace is sourced from env, not the form)
  cube: string;
  kpiMeasure: string;
  valueType: 'raw' | 'percentage';
  kpiConditions: string[];
  baseConditions: string[];
  dimensions: DimensionForm[];
}

/**
 * The known top-level scalar field paths ui_set_field may target — the single
 * auditable "is this a recognized KPI field?" list, and the seed for a future
 * shared backend<->FE field-id contract (SC-2666/I1). Keep it ONE constant so
 * I1 later edits one place. The free-text members
 * (name/label/description/type/analysisService) are handled by an explicit
 * grouped case in setKpiScalar so they no longer depend on the `default` branch.
 *
 * The switch cases below make the actual known/unknown decision; this list is
 * the named home for those ids and the source of the reject message. A drift-pin
 * in kpi.spec.ts asserts every entry here is recognized by the resolver, so the
 * list and the case-set cannot silently diverge.
 */
export const KNOWN_KPI_SCALAR_PATHS = [
  'name', 'label', 'description', 'type', 'analysisService',
  'baseObject', 'status', 'cube', 'kpiMeasure', 'valueType',
  'watchingThreshold', 'warningThreshold', 'issueKpi', 'defaultIssueSeverity',
] as const;

/**
 * The COMPLETE set of dotted `ui_set_field` paths the KPI form accepts, shown
 * verbatim in the UI-context snapshot so the assistant fills real fields instead
 * of inventing nested backend shapes (the reported bug: it tried "deepseeKpiSpec"
 * and "kpiDimensions", neither of which is a form path). Repeating array paths
 * use `.N.` to signal "any index"; the assistant substitutes 0, 1, 2, …. Keep
 * this list in lockstep with the resolver in guidedSetField / setKpiScalar.
 */
export const KPI_SET_FIELD_PATHS = [
  ...KNOWN_KPI_SCALAR_PATHS,
  'kpiConditions.N',
  'baseConditions.N',
  'dimensions.N.name',
  'dimensions.N.label',
  'dimensions.N.cubeDimension',
] as const;

/** Labels for the Live Value tile's connection light, one per read state. */
const CONN_LABEL: Record<'connecting' | 'live' | 'down', string> = {
  connecting: 'Connecting…',
  live: 'Live',
  down: 'Disconnected',
};

/** How many breakdown rows fit in the tile's 120px grid row without scrolling. */
const BREAKDOWN_ROWS = 3;

/** Plain-language threshold states, matching the dashboard tile's status footer. */
const THRESHOLD_STATUS_LABEL: Record<'ok' | 'watching' | 'warning', string> = {
  ok: 'On track',
  watching: 'Watching',
  warning: 'Warning',
};

/**
 * View model for the Threshold tile's ruler: proportional colour zones, the band edges as
 * positioned tick labels, and the live value's position. Percentages, so the tile only has to
 * place them — nothing is re-derived in the template.
 */
export interface ThresholdRuler {
  zones: { color: string; pct: number }[];
  ticks: { value: number; pct: number }[];
  markerPct: number | null;
  /** Where the scale starts, labelled at the left end. Null when a band edge already sits there. */
  start: number | null;
}

/**
 * Turn the envelope's bands into a ruler. Zone widths are proportional to each band's span so a
 * tick label lines up with the colour change beside it (equal-width zones would lie). The final
 * band is open-ended (`to: null`), so the scale runs 10% past the last finite edge — far enough
 * to give that band a visible slice — and stretches further if the value or target sits beyond it.
 * Returns null when there is nothing to draw: no finite edge, or a zero-width scale.
 */
function deriveThresholdRuler(h: KpiHealth | null): ThresholdRuler | null {
  const t = h?.threshold;
  if (!t?.bands?.length) return null;

  const edges = t.bands.map(b => b.to).filter((to): to is number => to != null);
  if (!edges.length) return null;

  const lastEdge = Math.max(...edges);
  const lo = Math.min(0, ...edges, h?.value ?? 0);
  const hi = Math.max(lastEdge + (lastEdge - lo) * 0.1, h?.value ?? lastEdge, t.target);
  const span = hi - lo;
  if (span <= 0) return null;

  const pctOf = (n: number): number => ((n - lo) / span) * 100;

  let from = lo;
  const zones = t.bands.map(b => {
    const to = b.to ?? hi;
    const pct = Math.max(0, pctOf(to) - pctOf(from));
    from = to;
    return { color: b.color, pct };
  });

  return {
    zones,
    ticks: edges.map(e => ({ value: e, pct: pctOf(e) })),
    markerPct: h?.value != null ? Math.min(100, Math.max(0, pctOf(h.value))) : null,
    start: Math.min(...edges) === lo ? null : lo,
  };
}

/** View model for the Issue Breakdown tile. `rows` is only populated in state 'some'. */
export interface IssueBreakdown {
  state: 'untracked' | 'unavailable' | 'none' | 'some';
  note: string;
  total: number;
  max: number;
  rows: { severity: number; count: number; tone: 'high' | 'med' | 'low' }[];
  /** SC-2721: the value and the issue total disagree, so issue rows are still being written. */
  stale: boolean;
}

const NO_ISSUE_BREAKDOWN: IssueBreakdown = { state: 'untracked', note: 'Issues not tracked', total: 0, max: 0, rows: [], stale: false };

/** Flatten the health envelope's issues union into rows the tile can render. */
function deriveIssueBreakdown(h: KpiHealth | null): IssueBreakdown {
  const iss = h?.issues;
  if (!iss) return NO_ISSUE_BREAKDOWN;
  if ('unavailable' in iss) return { state: 'unavailable', note: 'Issue count unavailable', total: 0, max: 0, rows: [], stale: false };
  // The value and the issue rows are separate reads of the same envelope, so a disagreement means the
  // issue records have not finished landing. No value means there is nothing to disagree with.
  const value = h?.value ?? null;
  const stale = value !== null && value !== iss.total;
  if (iss.total === 0) return { state: 'none', note: 'No issues raised', total: 0, max: 0, rows: [], stale };
  const rows = [...iss.bySeverity]
    .sort((a, b) => a.severity - b.severity)
    .map(s => ({
      severity: s.severity,
      count: s.count,
      tone: (s.severity <= 2 ? 'high' : s.severity === 3 ? 'med' : 'low') as 'high' | 'med' | 'low',
    }));
  return { state: 'some', note: '', total: iss.total, max: Math.max(...rows.map(r => r.count), 1), rows, stale };
}


@Component({
  selector: 'app-kpi',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, GuideHighlightDirective, CloseOnOutsideDirective],
  templateUrl: './kpi.html',
  styleUrl: './kpi.css',
  changeDetection: ChangeDetectionStrategy.Default,
})
export class KpiComponent implements OnInit, OnDestroy {
  loadError = '';
  selectedKpi: ListedKpi | null = null;

  /** Whether the left list panel is collapsed to a slim rail. */
  listCollapsed = false;
  toggleList(): void {
    this.listCollapsed = !this.listCollapsed;
    this.cdr.markForCheck();
  }

  // Form mode: null = viewing, 'new' = creating, 'edit' = editing.
  formMode: 'new' | 'edit' | null = null;
  form: KpiForm = this.emptyForm();
  /** Name the edit started from, so a rename can clean up the old draft/entry. */
  editOriginalName = '';
  savingDraft = false;
  submitting = false;
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
  /** Unsaved edits present — drives the leave prompt (NOT the draft badge). */
  formDirty = false;

  // Delete state
  deleting = false;
  deleteError = '';

  // Confirmation modals (replace native confirm()).
  showDeleteConfirm = false;
  showCancelConfirm = false;
  /** "Save draft / Leave / Keep editing" prompt shown when navigating away with unsaved edits. */
  showLeaveConfirm = false;

  /**
   * Generic confirm dialog for smaller destructive actions inside the form
   * (removing a condition or dimension). Armed with a title/message + a callback
   * that runs only on approve.
   */
  confirmPrompt: { title: string; message: string; confirmLabel: string; onConfirm: () => void } | null = null;

  private askConfirm(title: string, message: string, onConfirm: () => void, confirmLabel = 'Remove'): void {
    this.confirmPrompt = { title, message, confirmLabel, onConfirm };
    this.cdr.markForCheck();
  }
  runConfirmPrompt(): void {
    const action = this.confirmPrompt?.onConfirm;
    this.confirmPrompt = null;
    action?.();
    this.cdr.markForCheck();
  }
  cancelConfirmPrompt(): void {
    this.confirmPrompt = null;
    this.cdr.markForCheck();
  }

  // Value / breakdown / listing panels (unchanged behavior from the detail view)
  healthLoading = false;
  healthError = '';
  kpiHealth: KpiHealth | null = null;
  private kpiHealth$?: Subscription;

  /** Per-severity rows for the Issue Breakdown tile, derived once per health read.
   *  `state` keeps "not tracked", "unavailable" and "none raised" distinct. */
  issueBreakdown: IssueBreakdown = NO_ISSUE_BREAKDOWN;


  /** Ruler for the Threshold tile, derived once per health read. */
  thresholdRuler: ThresholdRuler | null = null;

  selectedDimension = '';
  breakdownLoading = false;
  breakdownError = '';
  breakdown: { label: string | number; value: any }[] = [];
  /** The largest BREAKDOWN_ROWS entries — all the tile can show without scrolling. */
  breakdownTop: { label: string | number; value: any }[] = [];

  listingLoading = false;
  listingError = '';
  listingRows: Record<string, any>[] = [];
  listingColumns: string[] = [];
  listingPage = 1;
  listingPageSize = 10;
  listingHasMore = false;
  listingSortBy = '';
  listingSortDesc = false;
  private listingInitialized = false;

  columnPickerOpen = false;
  columnPickerItems: { name: string; selected: boolean }[] = [];

  jsonModalOpen = false;

  // Dropdown sources
  /** Valid KPI base objects: the {name} from SC.Core.API.Data.{name}ApiImpl. */
  baseObjects: string[] = [];
  /** True when the user picked "Other" for base object (free-text entry). */
  baseObjectOther = false;
  availableCubes: string[] = [];
  /** Name + source class + state per cube, so the assistant can choose one sensibly. */
  cubeChoices: { cube: string; sourceClass: string; state: string }[] = [];
  formCubeDimensions: { caption: string; value: string }[] = [];
  formCubeMeasures: string[] = [];
  /** The full shape of the selected cube, held for the shared model tree (I1). */
  cubeShape: CubeShape | null = null;
  /** Cached level groups for the condition dropdowns (Task 2), populated when cubeShape loads. */
  private cachedLevelGroups: { dimension: string; levels: { spec: string; caption: string; label: string }[] }[] = [];
  /** The condition row that currently holds focus — drives the `.condition-row--target` treatment;
   *  null = nothing focused (I1). */
  readonly focusedCondition = signal<{ list: 'kpi' | 'base'; i: number } | null>(null);
  /**
   * The in-flight cube-metadata load (measures + dimensions), if any. Guided mode
   * awaits this before validating a measure/dimension set right after the cube —
   * otherwise the option lists are still empty and the value is accepted
   * optimistically but the <select> has no matching option, so it silently
   * vanishes (the reported "DeepSee spec / KPI conditions not filled" bug).
   * Resolves once BOTH lists are loaded (or their fetches settle). Null when no
   * cube is set / nothing loading.
   */
  private cubeMetaLoading: Promise<void> | null = null;
  /** Cube name → its source class short-name, for auto-filling baseObject. */
  private cubeSourceShortName = new Map<string, string>();

  // Raw data
  private irisKpis: KpiDefinition[] = [];
  private drafts: KpiDraft[] = [];
  groups: KpiGroup[] = [];

  /** Field path currently highlighted by Guided mode (bound in the template). */
  highlightPath: string | null = null;

  constructor(
    private kpiApi: KpiApiService,
    private dashboardChart: DashboardChartService,
    private cubeSvc: CubeService,
    private cdr: ChangeDetectorRef,
    private bridge: WorkbenchBridgeService,
    private toasts: ToastService,
    private kpiGroups: KpiGroupService,
    private kpiHealthApi: KpiHealthService,
  ) {}

  /** Controller the assistant (Guided mode) uses to drive this form. */
  private readonly guidedController: GuidedFormController = {
    feature: 'kpi',
    openNewForm: () => this.openNewForm(),
    openEntity: (name, opts) => this.guidedOpenEntity(name, opts),
    setField: (path, value) => this.guidedSetField(path, value),
    highlight: (target) => {
      this.highlightPath = target;
      this.cdr.markForCheck();
    },
    snapshot: () => this.formSnapshot(),
    canLeave: (proceed) => this.guardLeave(proceed),
    hasUnsavedEdits: () => !!this.formMode && this.formDirty,
    resolveUnsaved: (disposition) => this.guidedResolveUnsaved(disposition),
    whenListReady: () => this.listReady,
    // Deep link: which KPI is on screen, and how to get back to it on reload.
    currentItem: () => this.selectedKpi?.name ?? null,
    restoreItem: (name) => this.restoreKpi(name),
  };

  /**
   * Re-select the KPI `?item=` names after a page reload, once the list (IRIS KPIs
   * plus local drafts) has been built. Lands on the DETAIL view even for a draft: a
   * refresh is not a request to resume editing, and the detail view is what the user
   * was looking at. False when the KPI is gone, leaving the page on its overview.
   */
  private async restoreKpi(name: string): Promise<boolean> {
    await this.listReady;
    const hit = this.findListed(name);
    if (!hit) return false;
    this.selectKpi(hit);
    this.cdr.markForCheck();
    return true;
  }

  /** Resolves when the KPI list's initial load settles (see reload()); lets a
   *  guided navigate hand the loaded list back in the same turn. */
  private resolveListReady!: () => void;
  private listReady = new Promise<void>((res) => { this.resolveListReady = res; });

  ngOnDestroy(): void {
    this.bridge.unregister(this.guidedController);
    this.kpiHealth$?.unsubscribe();
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
    if (this.formMode && this.formDirty) {
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
    if (!this.form.name.trim()) {
      this.pendingLeave = null;
      this.formError = 'KPI name is required to save a draft.';
      this.cdr.markForCheck();
      return;
    }
    const proceed = this.pendingLeave;
    this.pendingLeave = null;
    this.saveDraft(proceed ?? undefined);
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
   * Resolve the open form's unsaved edits on the user's behalf (Guided mode),
   * so the assistant can save-or-discard-then-navigate itself instead of leaving
   * the user to click the leave dialog. `'save'` persists the draft (rejecting if
   * the form has no name or the save fails); `'discard'` drops the edits. Any open
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
    if (!this.form.name.trim()) {
      return Promise.resolve({
        applied: false,
        detail: 'The KPI has no name yet, so it can\'t be saved as a draft. Ask the user for a name (or to discard the changes) before navigating.',
      });
    }
    // saveDraft is async (an HTTP call); resolve only when it truly settles so the
    // navigation proceeds after the draft is persisted, and reports the real error
    // (never hangs the turn) if the save fails.
    return new Promise<SetFieldResult>((resolve) => {
      this.saveDraft(
        () => resolve({ applied: true }),
        (message) => resolve({ applied: false, detail: `Couldn't save the KPI draft: ${message}. Ask the user how to proceed.` }),
      );
    });
  }

  // ── Guarded entry points (template) ───────────────────────────
  // Any action that LEAVES the open edit form runs the leave-guard first, so
  // unsaved edits always prompt (Save draft / Leave / Keep editing) regardless of
  // path. A clean form (or none open) is allowed through with no prompt.

  /** Select a KPI from the list — guarded so unsaved edits prompt first. */
  attemptSelectKpi(kpi: ListedKpi): void {
    if (this.guardLeave(() => this.selectKpi(kpi))) this.selectKpi(kpi);
  }

  /** Open the new-KPI form — guarded so unsaved edits prompt first. */
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
   * edits (so leaving prompts to save) — it does NOT flip the KPI's list badge to
   * "draft". A KPI becomes 'draft' only when the user explicitly saves a draft
   * (Save draft button, or "Save draft" on the leave prompt); editing a created
   * KPI without saving leaves its badge as-is.
   */
  markDirty(): void {
    this.formDirty = true;
  }

  // ── Guided-mode co-pilot (assistant fills fields for the user) ────

  /**
   * Set one KPI form field by dotted path on behalf of Guided mode, ensuring a
   * form is open first and creating dimension / condition rows as needed.
   *
   * Returns whether the value actually LANDED. Dropdown-backed fields (cube,
   * measure, valueType, status, base object, default severity, a dimension's
   * cubeDimension) only accept a value that matches an option; anything else is
   * rejected with a detail message so the assistant is told the truth rather
   * than a blind success (the earlier bug — free-text inputs worked, selects
   * silently ignored an off-list value while the tool still reported OK).
   *
   * Supported paths (examples):
   *   name · label · description · status · baseObject
   *   cube · kpiMeasure · valueType
   *   watchingThreshold · warningThreshold · issueKpi · defaultIssueSeverity
   *   kpiConditions.0 · baseConditions.0
   *   dimensions.0.name|label|cubeDimension
   */
  private async guidedSetField(path: string, value: unknown): Promise<SetFieldResult> {
    if (!this.formMode) this.openNewForm();
    const parts = path.split('.');
    const head = parts[0]!;
    let result: SetFieldResult;
    try {
      if (head === 'kpiConditions' || head === 'baseConditions') {
        const i = Number(parts[1]);
        const arr = this.form[head];
        while (arr.length <= i) arr.push('');
        arr[i] = String(value);
        this.clearMergeOffer();   // spec §7.4: the co-pilot writing a slot is a row edit — drop a pending offer
        result = { applied: true };
      } else if (head === 'dimensions') {
        result = await this.setKpiDimensionField(Number(parts[1]), parts[2]!, value);
      } else {
        result = await this.setKpiScalar(head, value);
      }
      if (result.applied) this.markDirty();
      this.cdr.markForCheck();
      return result;
    } catch {
      return { applied: false, detail: `Unknown or unsupported field path "${path}".` };
    }
  }

  /** Assign a top-level KPI form scalar, validating dropdown-backed fields. */
  private async setKpiScalar(field: string, value: unknown): Promise<SetFieldResult> {
    switch (field) {
      case 'cube': {
        const res = resolveOption(String(value), this.cubeChoices.map((c) => ({ value: c.cube, labels: [c.sourceClass] })));
        if (res.status === 'ambiguous') {
          return { applied: false, detail: `"${value}" matches more than one cube: ${res.candidates.join(', ')}. Ask the user which one.` };
        }
        if (res.status === 'none') {
          return { applied: false, detail: `"${value}" is not an available cube. Choose one of: ${this.availableCubes.join(', ')}.` };
        }
        this.form.cube = res.value;
        this.onFormCubeChange();
        // Wait for the measure/dimension lists so a follow-up kpiMeasure /
        // dimension set (often the same turn) validates against a loaded list —
        // AND so we can hand those now-unlocked options straight back in this
        // result. The cube's measures/dimensions are a DEPENDENT dropdown (empty
        // until a cube is picked); returning them here means the assistant has
        // them THIS turn instead of guessing before the next turn's UI CONTEXT.
        await this.cubeMetaLoading;
        return {
          applied: true,
          detail:
            `Cube set to ${res.value}. Now pick from THIS cube's options (do not invent others):\n` +
            `- kpiMeasure options: ${this.formCubeMeasures.length ? this.formCubeMeasures.join(', ') : '%COUNT (no named measures)'}\n` +
            `- dimension cubeDimension options (MDX members): ${this.formCubeDimensions.length ? this.formCubeDimensions.map((d) => d.value).join(', ') : '(none)'}`,
        };
      }
      case 'kpiMeasure': {
        // Wait out any in-flight cube-metadata load so we validate against the
        // real measure list rather than accepting a value the dropdown can't show.
        if (this.cubeMetaLoading) await this.cubeMetaLoading;
        if (this.formCubeMeasures.length) {
          const res = resolveOption(String(value), this.formCubeMeasures);
          if (res.status === 'ambiguous') {
            return { applied: false, detail: `"${value}" matches more than one measure of ${this.form.cube}: ${res.candidates.join(', ')}. Ask the user which one.` };
          }
          if (res.status === 'none') {
            return { applied: false, detail: `"${value}" is not a measure of ${this.form.cube || 'the cube'}. Available: ${this.formCubeMeasures.join(', ')}.` };
          }
          this.form.kpiMeasure = res.value;
          return { applied: true };
        }
        // No cube chosen yet → nothing to validate against; reject with a clear
        // reason instead of accepting a value the dropdown can't display.
        if (!this.form.cube) {
          return { applied: false, detail: 'Set the cube first — kpiMeasure is a measure of the chosen cube.' };
        }
        // Cube set but no named measures (e.g. %COUNT-only cube): accept as-is.
        this.form.kpiMeasure = String(value).trim();
        return { applied: true };
      }
      case 'valueType':
        return this.assignEnum('valueType', value, ['raw', 'percentage'], 'value type');
      case 'status':
        return this.assignEnum('status', value, ['Active', 'Inactive'], 'status');
      case 'baseObject': {
        const match = this.baseObjects.find((o) => o.toLowerCase() === String(value).trim().toLowerCase());
        this.form.baseObject = match ?? String(value).trim();
        this.baseObjectOther = !match; // off-list value shows via the free-text field
        return { applied: true };
      }
      case 'issueKpi':
        this.form.issueKpi = value === true || String(value).toLowerCase() === 'true';
        return { applied: true };
      case 'defaultIssueSeverity': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return { applied: false, detail: 'Default severity must be an integer 1–5 (1 = most critical).' };
        }
        this.form.defaultIssueSeverity = n;
        return { applied: true };
      }
      case 'watchingThreshold':
      case 'warningThreshold': {
        const n = Number(value);
        if (Number.isNaN(n)) return { applied: false, detail: `${field} must be a number.` };
        this.form[field] = n;
        return { applied: true };
      }
      // Free-text fields the resolver KNOWS about but that need no validation.
      // Handled explicitly (no longer via `default`), with a typed write to the
      // real KpiForm string slot — String(value) satisfies the string type for a
      // string|number|boolean tool value (the one deliberate coercion, C16-SPEC-06).
      case 'name':
      case 'label':
      case 'description':
      case 'type':
      case 'analysisService':
        this.form[field] = String(value);
        return { applied: true };
      default:
        return {
          applied: false,
          detail: `Unknown field path "${field}" — not a recognized KPI field. Known fields: ${KNOWN_KPI_SCALAR_PATHS.join(', ')}.`,
        };
    }
  }

  /** Assign an enum-backed KPI field, matching options case-insensitively. */
  private assignEnum(
    key: keyof KpiForm,
    value: unknown,
    options: readonly string[],
    label: string,
  ): SetFieldResult {
    const match = options.find((o) => o.toLowerCase() === String(value).trim().toLowerCase());
    if (!match) {
      return { applied: false, detail: `"${value}" is not a valid ${label}. Choose one of: ${options.join(', ')}.` };
    }
    (this.form as unknown as Record<string, unknown>)[key as string] = match;
    return { applied: true };
  }

  /** Set a dimension row field; cubeDimension is a dropdown validated here. */
  private async setKpiDimensionField(i: number, field: string, value: unknown): Promise<SetFieldResult> {
    while (this.form.dimensions.length <= i) this.addDimension();
    if (field === 'cubeDimension') {
      // Wait out any in-flight cube-metadata load so we validate the MDX against
      // the real dimension list instead of dropping it to the race.
      if (this.cubeMetaLoading) await this.cubeMetaLoading;
      if (this.formCubeDimensions.length) {
        // A cube dimension is an MDX member like [customer].[H1].[country] — the
        // user almost never types that; they say "country". Resolve their plain
        // term (or a caption) to the canonical member instead of demanding an
        // exact string, so "country" lands on [customer].[H1].[country].
        const res = resolveOption(
          String(value),
          this.formCubeDimensions.map((d) => ({ value: d.value, labels: [d.caption] })),
        );
        if (res.status === 'ambiguous') {
          return {
            applied: false,
            detail: `"${value}" matches more than one dimension: ${res.candidates.join(', ')}. Ask the user which one they mean.`,
          };
        }
        if (res.status === 'none') {
          return {
            applied: false,
            detail: `"${value}" is not a dimension of the selected cube. Available (MDX members): ${this.formCubeDimensions.map((d) => d.value).join(', ')}.`,
          };
        }
        this.form.dimensions[i]!.cubeDimension = res.value;
        this.onFormDimensionChange(i);
        return { applied: true };
      }
      if (!this.form.cube) {
        return { applied: false, detail: 'Set the cube first — a dimension is chosen from the cube’s dimensions.' };
      }
      this.form.dimensions[i]!.cubeDimension = String(value).trim();
      return { applied: true };
    }
    // Legit free-text dimension-row fields — typed write, no `default` blind-write.
    if (field === 'name' || field === 'label') {
      this.form.dimensions[i]![field] = String(value);
      return { applied: true };
    }
    return {
      applied: false,
      detail: `Unknown dimension field "${field}" — expected name, label, or cubeDimension.`,
    };
  }

  /**
   * Full field map for the assistant's UI-context block. Reflects the create/edit
   * FORM when one is open (EVERY field, so the assistant can answer questions
   * about any of them and know exactly what's filled), otherwise the KPI the user
   * has selected in the detail view (its complete definition + current value), so
   * "what does this field/value mean?" is answered for the concrete KPI on screen
   * rather than generically.
   */
  private formSnapshot(): Record<string, unknown> {
    if (this.formMode) {
      const f = this.form;
      return {
        mode: this.formMode === 'new' ? 'creating new KPI' : 'editing KPI',
        // The exact ui_set_field paths this form accepts — fill ONLY these; do
        // not invent nested backend paths like "deepseeKpiSpec" or "kpiDimensions".
        validFieldPaths: KPI_SET_FIELD_PATHS,
        name: f.name,
        label: f.label,
        description: f.description,
        type: f.type,
        status: f.status,
        baseObject: f.baseObject,
        cube: f.cube,
        kpiMeasure: f.kpiMeasure,
        valueType: f.valueType,
        kpiConditions: f.kpiConditions.filter(Boolean),
        // baseConditions only apply to a percentage KPI (the denominator).
        baseConditions: f.valueType === 'percentage' ? f.baseConditions.filter(Boolean) : [],
        watchingThreshold: f.watchingThreshold,
        warningThreshold: f.warningThreshold,
        issueKpi: f.issueKpi,
        defaultIssueSeverity: f.issueKpi ? f.defaultIssueSeverity : null,
        analysisService: f.issueKpi ? f.analysisService : '',
        dimensions: f.dimensions
          .filter((d) => d.name || d.label || d.cubeDimension)
          .map((d) => ({ name: d.name, label: d.label, cubeDimension: d.cubeDimension })),
        // Cube choices with their source class, so the assistant picks a cube on
        // more than a bare name (e.g. Inventory → SC.Data.Inventory). Only 'built'
        // cubes are queryable by a KPI.
        cubeChoices: this.cubeChoices,
        availableCubes: this.availableCubes,
        // Cube-dependent dropdown options. Made explicit so an empty list never
        // reads as "no constraint" (which invited guessing): if a cube is set but
        // options aren't loaded yet, say so; if no cube, say to pick one first.
        // The assistant MUST pick from these lists or ask — never invent a
        // measure/dimension/MDX member.
        availableMeasures: !f.cube
          ? '(no cube set — choose a cube first)'
          : this.formCubeMeasures.length
            ? this.formCubeMeasures
            : '(loading the cube’s measures — do not guess; wait or ask)',
        availableCubeDimensions: !f.cube
          ? '(no cube set — choose a cube first)'
          : this.formCubeDimensions.length
            ? this.formCubeDimensions.map((d) => d.value)
            : '(loading the cube’s dimensions — do not guess; wait or ask)',
      };
    }
    if (this.selectedKpi) {
      return {
        mode: 'viewing KPI detail',
        selectedKpi: this.selectedKpi.name,
        ...this.kpiDetailSnapshot(this.selectedKpi),
        currentValue: this.kpiHealth?.value ?? null,
      };
    }
    // List view: no KPI is selected, but the user may ask about ANY listed KPI —
    // so surface the FULL definition of every one (the list already holds each
    // KPI's complete definition in memory), so the assistant can answer in detail
    // without needing the user to click into one first.
    const kpis = this.groups.flatMap((g) =>
      g.items.map((k) => ({ group: g.name, ...this.kpiDetailSnapshot(k) })),
    );
    return { mode: 'KPI list (no KPI selected)', kpiCount: kpis.length, kpis };
  }

  /** The full detail of one KPI, shared by the list view (every KPI) and the
   *  selected-detail view (one KPI) so both expose the same complete fields. */
  private kpiDetailSnapshot(k: ListedKpi): Record<string, unknown> {
    const spec = k.deepseeKpiSpec;
    return {
      name: k.name,
      state: k.state,
      label: k.label ?? '',
      description: k.description ?? '',
      baseObject: k.baseObject ?? '',
      status: k.status ?? '',
      watchingThreshold: k.watchingThreshold ?? null,
      warningThreshold: k.warningThreshold ?? null,
      issueKpi: k.issueKpi ?? false,
      defaultIssueSeverity: k.defaultIssueSeverity ?? null,
      analysisService: k.analysisService ?? '',
      cube: spec?.cube ?? '',
      kpiMeasure: spec?.kpiMeasure ?? '',
      valueType: spec?.valueType ?? '',
      kpiConditions: spec?.kpiConditions ?? [],
      baseConditions: spec?.baseConditions ?? [],
      dimensions: (spec?.kpiDimensions ?? []).map((d) => ({
        name: d.name,
        label: d.label,
        cubeDimension: d.cubeDimension,
      })),
    };
  }

  ngOnInit(): void {
    // Expose this form to the assistant's Guided mode.
    this.bridge.register(this.guidedController);
    // Base objects come from the SC.Core.API.Data.{name}ApiImpl classes — those
    // are the only names for which SCO's drill-through record listing resolves.
    this.kpiApi.listKpiBaseObjects().subscribe({
      next: res => {
        this.baseObjects = (res?.baseObjects ?? []).slice().sort();
        this.cdr.markForCheck();
      },
      error: () => {},
    });

    // Cubes: use our cube list (it carries each cube's source class), so we can
    // both populate the dropdown and auto-fill the KPI base object on selection.
    this.cubeSvc.list().subscribe({
      next: res => {
        const cubes = res?.cubes ?? [];
        this.availableCubes = cubes.map(c => c.cubeName).filter(Boolean).sort();
        this.cubeSourceShortName.clear();
        // Keep name + source class per cube so the assistant can CHOOSE a cube
        // sensibly (e.g. "Inventory built on SC.Data.Inventory") rather than
        // guessing from a bare name. Only 'built' cubes are queryable for a KPI.
        this.cubeChoices = cubes
          .filter(c => c.cubeName)
          .map(c => ({ cube: c.cubeName, sourceClass: c.sourceClass ?? '', state: c.state ?? 'built' }))
          .sort((a, b) => a.cube.localeCompare(b.cube));
        for (const c of cubes) {
          if (c.sourceClass) this.cubeSourceShortName.set(c.cubeName, shortClassName(c.sourceClass));
        }
        this.cdr.markForCheck();
      },
      error: () => {},
    });

    this.reload();
  }

  /**
   * Load both IRIS KPIs and local drafts, then rebuild the grouped list.
   * `afterBuild` (if given) runs once the groups are rebuilt — used to reselect
   * a KPI by name after a save/submit without racing on a timer.
   */
  private reload(afterBuild?: () => void): void {
    this.kpiApi.getKpiDefinitions().subscribe({
      next: defs => {
        this.irisKpis = Array.isArray(defs) ? defs : [];
        this.loadDraftsThenBuild(afterBuild);
      },
      error: err => {
        this.loadError = err?.error?.message || err?.message || err?.status || JSON.stringify(err);
        this.resolveListReady(); // settle even on error so a guided navigate doesn't hang
        this.cdr.markForCheck();
      },
    });
  }

  private loadDraftsThenBuild(afterBuild?: () => void): void {
    const finish = (drafts: KpiDraft[]) => {
      this.drafts = drafts;
      this.buildGroups();
      this.resolveListReady(); // the list is now populated (idempotent after first call)
      afterBuild?.();
      this.cdr.markForCheck();
    };
    this.kpiApi.listKpiDrafts().subscribe({
      next: res => finish(res?.drafts ?? []),
      // Drafts are best-effort; still show IRIS KPIs if the draft store is down.
      error: () => finish([]),
    });
  }

  /**
   * Merge IRIS KPIs with local drafts into the grouped list. A KPI in IRIS is
   * 'created'; if a draft with the same name also exists it has unsubmitted
   * edits and is shown as 'draft'. KPIs are organized by the USER-DEFINED group
   * assigned to each (Workbench-local; see KpiGroupService) — a KPI with no
   * assignment collects under the trailing "Ungrouped" bucket.
   */
  private buildGroups(): void {
    const draftByName = new Map(this.drafts.map(d => [d.kpiName, d]));
    const listed: ListedKpi[] = [];

    for (const kpi of this.irisKpis) {
      const draft = draftByName.get(kpi.name);
      // A draft over a created KPI means local edits pending submit → 'draft'.
      listed.push({ ...(draft?.definition ?? kpi), state: draft ? 'draft' : 'created' });
      draftByName.delete(kpi.name);
    }
    // Remaining drafts have no IRIS counterpart yet → pure drafts.
    for (const draft of draftByName.values()) {
      listed.push({ ...draft.definition, state: 'draft' });
    }

    // Bucket each KPI by its user-defined group (or Ungrouped).
    const byGroup = new Map<string, ListedKpi[]>();
    for (const kpi of listed) {
      const g = this.kpiGroups.groupOf(kpi.name);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(kpi);
    }

    const prevExpanded = new Map(this.groups.map(g => [g.name, g.expanded]));

    // Show every user-created group (in creation order) even if currently empty,
    // so a freshly-made group is visible to drop KPIs into; then any ad-hoc groups
    // that exist only via assignment; then the Ungrouped bucket last.
    const created = this.kpiGroups.groupNames();
    const assignedOnly = [...byGroup.keys()].filter((g) => g !== UNGROUPED && !created.includes(g)).sort();
    const orderedNames = [...created, ...assignedOnly];

    const customGroups: KpiGroup[] = orderedNames.map((name) => ({
      name,
      label: name,
      items: (byGroup.get(name) ?? []).sort(sortByName),
      expanded: prevExpanded.get(name) ?? true,
    }));

    // The Ungrouped bucket carries a BLANK label (per design — no "Ungrouped"
    // text); its header still works as a drop target to clear a KPI's group.
    const ungroupedItems = byGroup.get(UNGROUPED);
    const ungrouped: KpiGroup[] = ungroupedItems?.length
      ? [{ name: UNGROUPED, label: '', items: ungroupedItems.sort(sortByName), expanded: prevExpanded.get(UNGROUPED) ?? true }]
      : [];

    this.groups = [...customGroups, ...ungrouped];
  }

  get totalCount(): number {
    return this.groups.reduce((s, g) => s + g.items.length, 0);
  }

  private emptyForm(): KpiForm {
    return {
      name: '', label: '', description: '', type: 'DeepSee', baseObject: '', status: 'Active',
      watchingThreshold: null, warningThreshold: null,
      issueKpi: false, defaultIssueSeverity: null, analysisService: '',
      cube: '', kpiMeasure: '', valueType: 'raw',
      kpiConditions: [''], baseConditions: [''],
      dimensions: [{ name: '', label: '', cubeDimension: '' }],
    };
  }

  // ── Form open / close ─────────────────────────────────────────
  openNewForm(): void {
    this.formMode = 'new';
    this.editOriginalName = '';
    this.selectedKpi = null;
    this.form = this.emptyForm();
    this.pendingOperator.clear();
    this.pendingComparison.clear();
    this.mergeOffer.set(null);   // spec §7.4: an offer's indices are form-scoped; never carry into a new form
    this.formCubeDimensions = [];
    this.formCubeMeasures = [];
    this.cachedLevelGroups = [];
    this.baseObjectOther = false;
    this.formDirty = false;
    this.formError = '';
    // Zoneless: a guided open_form mutates these plain fields off a microtask, so
    // request a CD pass to render the freshly-opened form (Cube's openNewForm does
    // the same). Without it the form's appearance leans on the panel's forced
    // appRef.tick(), which can be swallowed as a re-entrant CD.
    this.cdr.markForCheck();
  }

  openEditForm(): void {
    if (!this.selectedKpi) return;
    this.formMode = 'edit';
    this.editOriginalName = this.selectedKpi.name;
    this.form = this.definitionToForm(this.selectedKpi);
    this.pendingOperator.clear();
    this.pendingComparison.clear();
    this.mergeOffer.set(null);   // spec §7.4: an offer's indices are form-scoped; never carry into a loaded KPI
    this.formError = '';
    this.formDirty = false; // freshly loaded — not dirty until the user edits
    this.formCubeDimensions = [];
    this.formCubeMeasures = [];
    this.cachedLevelGroups = [];
    // A saved base object that isn't one of the known ApiImpl names is shown as
    // free text so the user sees the real value rather than an empty select.
    this.baseObjectOther = !!this.form.baseObject && !this.baseObjects.includes(this.form.baseObject);
    if (this.form.cube) this.loadCubeMetadata(this.form.cube);
  }

  /**
   * Guided mode: land on an existing KPI by name.
   *  - mode "view" (default): select it and show its detail — works for ANY KPI
   *    (created or draft). Use when the user just wants to see it.
   *  - mode "edit": reopen it in the edit form. Only a KPI saved as a DRAFT can be
   *    reopened (returning the user to what they were editing after a page
   *    round-trip); a created-only KPI or a missing name fails clearly, and we stay
   *    on the detail view. Nothing is auto-saved.
   * The component remounts on navigation, so we reload the list first and resolve
   * against fresh data (not a pre-remount snapshot).
   */
  private guidedOpenEntity(name: string, opts?: { mode?: 'view' | 'edit' }): Promise<SetFieldResult> {
    const target = name.trim();
    const edit = opts?.mode === 'edit';
    return new Promise((resolve) => {
      this.reload(() => {
        const hit = this.findListed(target);
        if (!hit) {
          // List the real KPIs (name + backing cube) so the assistant can pick the
          // right one — the user often refers to a KPI by its cube or purpose.
          const available = this.groups
            .flatMap((g) => g.items)
            .map((k) => `${k.name}${k.deepseeKpiSpec?.cube ? ` (cube: ${k.deepseeKpiSpec.cube})` : ''}`)
            .join(', ');
          resolve({
            applied: false,
            detail: `No KPI named "${target}" was found. Available KPIs: ${available || '(none)'}.`,
          });
          return;
        }
        // Always select so the user SEES the KPI (detail view), edit or not.
        this.selectKpi(hit);
        if (!edit) {
          this.cdr.markForCheck();
          resolve({ applied: true, detail: `Opened the detail view for KPI "${target}".` });
          return;
        }
        if (hit.state !== 'draft') {
          this.cdr.markForCheck();
          resolve({
            applied: false,
            detail: `"${target}" has no saved draft to edit — it's showing in detail view. Only a KPI saved as a draft can be reopened for editing; ask the user to save it as a draft first.`,
          });
          return;
        }
        this.openEditForm();
        this.cdr.markForCheck();
        resolve({ applied: true, detail: `Reopened the saved draft "${target}" in edit mode.` });
      });
    });
  }

  cancelForm(): void {
    // Only double-check when there are unsaved edits to lose.
    if (this.formDirty) {
      this.showCancelConfirm = true;
      this.cdr.markForCheck();
      return;
    }
    this.performCancel();
  }

  /** Discard the form and return to the edited KPI's detail view. */
  performCancel(): void {
    const wasEditing = this.formMode === 'edit';
    const name = this.editOriginalName;
    this.showCancelConfirm = false;
    this.formMode = null;
    this.form = this.emptyForm();
    this.pendingOperator.clear();
    this.pendingComparison.clear();
    this.mergeOffer.set(null);   // spec §7.4: discard any pending offer with the cancelled form
    this.formError = '';
    this.formDirty = false; // discard: don't auto-save on the next navigate
    // Reload so an edited-but-cancelled KPI shows its real persisted state again
    // (any optimistic "draft" badge from markDirty is reverted).
    this.reload(() => {
      if (wasEditing && name) {
        const found = this.findListed(name);
        if (found) this.selectKpi(found);
      }
    });
  }

  private definitionToForm(kpi: KpiDefinition): KpiForm {
    const spec = kpi.deepseeKpiSpec;
    return {
      name: kpi.name ?? '',
      label: kpi.label ?? '',
      description: kpi.description ?? '',
      type: kpi.type ?? 'DeepSee',
      baseObject: kpi.baseObject ?? '',
      status: kpi.status ?? 'Active',
      watchingThreshold: kpi.watchingThreshold ?? null,
      warningThreshold: kpi.warningThreshold ?? null,
      issueKpi: kpi.issueKpi ?? false,
      defaultIssueSeverity: kpi.defaultIssueSeverity ?? null,
      analysisService: kpi.analysisService ?? '',
      cube: spec?.cube ?? '',
      kpiMeasure: spec?.kpiMeasure ?? '',
      valueType: spec?.valueType ?? 'raw',
      kpiConditions: spec?.kpiConditions?.length ? [...spec.kpiConditions] : [''],
      baseConditions: spec?.baseConditions?.length ? [...spec.baseConditions] : [''],
      dimensions: spec?.kpiDimensions?.length
        ? spec.kpiDimensions.map(d => ({ name: d.name ?? '', label: d.label ?? '', cubeDimension: d.cubeDimension ?? '' }))
        : [{ name: '', label: '', cubeDimension: '' }],
    };
  }

  /** Whether the percentage denominator (baseConditions) applies. */
  get showBaseConditions(): boolean {
    return this.form.valueType === 'percentage';
  }

  // ── Cube-dependent dropdowns ──────────────────────────────────
  onFormCubeChange(): void {
    this.formCubeDimensions = [];
    this.formCubeMeasures = [];
    this.cachedLevelGroups = [];
    this.form.kpiMeasure = '';
    if (!this.form.cube) {
      this.cubeMetaLoading = null;
      return;
    }
    this.loadCubeMetadata(this.form.cube);
    this.autoFillBaseObject(this.form.cube);
  }

  /**
   * Auto-fill the base object from the selected cube's source class short-name.
   * The base object drives only the drill-through records listing (via
   * SC.Core.API.Data.{name}ApiImpl); it's fine if the derived name isn't one of
   * the known base objects — the user can still adjust it or switch to "Other".
   */
  private autoFillBaseObject(cube: string): void {
    const derived = this.cubeSourceShortName.get(cube);
    if (!derived) return;
    this.form.baseObject = derived;
    // If the derived name isn't a known base object, expose it as free text so
    // the value is visible/editable rather than silently mismatching the select.
    this.baseObjectOther = !this.baseObjects.includes(derived);
  }

  /** Toggle the base-object free-text ("Other") entry. */
  onBaseObjectSelectChange(value: string): void {
    if (value === '__other__') {
      this.baseObjectOther = true;
      this.form.baseObject = '';
    } else {
      this.baseObjectOther = false;
      this.form.baseObject = value;
    }
  }

  private loadCubeMetadata(cube: string): void {
    // I1 (SC-2666): ONE shape fetch off the shared DashboardChartService port feeds BOTH the
    // guided-validation lists AND the model tree — replacing the dead CubeInfoService two-call
    // (/Info/Measures + /Info/Filters) stack. Resolve on success OR error (never reject), so a
    // waiting Guided setField is never left hanging.
    this.cubeMetaLoading = new Promise<void>((done) => {
      this.dashboardChart.getCubeShape(cube).subscribe({
        next: shape => {
          if (this.form.cube === cube) {
            this.formCubeMeasures = shape.measures.map(m => m.name).filter(Boolean);
            // PER-LEVEL cardinality (I1-SPEC-02): one entry per dimension LEVEL, matching today's
            // /Info/Filters list. `value` stays exactly CubeShapeLevel.spec so onFormDimensionChange's
            // `\[name\]$` regex and the case-insensitive setKpiDimensionField match keep working
            // byte-compatibly. Collapsing to levels[0] would drop non-first levels the guided
            // dimension dropdown offers today (a C16 ui_set_field regression).
            this.formCubeDimensions = shape.dimensions.flatMap(d =>
              d.levels.map(l => ({ caption: l.caption ?? l.name, value: l.spec })));
            this.cubeShape = shape;      // held for the tree (Task 8)
            this.cachedLevelGroups = shape.dimensions.map((d) => ({
              dimension: d.name,
              levels: d.levels.map((l) => ({ spec: l.spec, caption: humanizeField(l.caption ?? l.name), label: levelOptionLabel(l.spec) })),
            }));
            this.prefetchConditionMembers();  // populate member dropdowns for any guided `is` rows
            this.cdr.markForCheck();
          }
          done();
        },
        error: () => done(),
      });
    });
  }

  onFormDimensionChange(i: number): void {
    const mdx = this.form.dimensions[i].cubeDimension;
    if (!mdx) return;
    const dim = this.formCubeDimensions.find(d => d.value === mdx);
    if (!dim) return;
    const nameMatch = mdx.match(/\[([^\]]+)\]$/);
    if (nameMatch) this.form.dimensions[i].name = nameMatch[1];
    this.form.dimensions[i].label = dim.caption;
  }

  // ── Repeatable rows ───────────────────────────────────────────
  addKpiCondition(): void { this.form.kpiConditions.push(''); this.clearMergeOffer(); this.markDirty(); }
  removeKpiCondition(i: number): void {
    this.askConfirm('Remove condition', 'Remove this KPI condition?', () => {
      this.removeOrClearCondition('kpi', i);
    });
  }
  addBaseCondition(): void { this.form.baseConditions.push(''); this.clearMergeOffer(); this.markDirty(); }
  removeBaseCondition(i: number): void {
    this.askConfirm('Remove condition', 'Remove this base condition?', () => {
      this.removeOrClearCondition('base', i);
    });
  }

  /** Remove condition row `i`, EXCEPT when it is the only row: a section always keeps at least one row, so
   *  the last one is cleared back to the empty level-select row instead of spliced away. This lets the trash
   *  icon show on a sole row (no hidden control) while never leaving the section rowless — the "always show
   *  trash" decision (2026-09-08). Clearing also drops that row's free-text / pending-operator state. */
  private removeOrClearCondition(list: 'kpi' | 'base', i: number): void {
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    if (arr.length > 1) {
      arr.splice(i, 1);
      this.reindexConditionRowState(list, i);
    } else {
      arr[i] = '';                                     // clear the sole row back to the empty level-select row
      this.freeTextRows.delete(this.rowKey(list, i));
      this.pendingOperator.delete(this.rowKey(list, i));
      this.pendingComparison.delete(this.rowKey(list, i));
    }
    this.clearMergeOffer();   // spec §7.4: removing/clearing a row dismisses a pending merge offer
    this.markDirty();
  }

  /** After the row at `removedAt` is spliced out of `list`, shift each per-row UI map keyed by rowKey
   *  down one to track the new positions. Rebuilds the `list`-prefixed entries in one pass; other-list
   *  entries are untouched. Covers freeTextRows, pendingOperator AND pendingComparison. */
  private reindexConditionRowState(list: 'kpi' | 'base', removedAt: number): void {
    const remap = (n: number): number | null => (n === removedAt ? null : n > removedAt ? n - 1 : n);
    const rebuildSet = (set: Set<string>) => {
      const rows = [...set].filter((k) => k.startsWith(`${list}:`)).map((k) => Number(k.split(':')[1]));
      rows.forEach((n) => set.delete(this.rowKey(list, n)));
      rows.forEach((n) => { const m = remap(n); if (m !== null) set.add(this.rowKey(list, m)); });
    };
    rebuildSet(this.freeTextRows);
    const entries = [...this.pendingOperator].filter(([k]) => k.startsWith(`${list}:`));
    entries.forEach(([k]) => this.pendingOperator.delete(k));
    entries.forEach(([k, op]) => { const m = remap(Number(k.split(':')[1])); if (m !== null) this.pendingOperator.set(this.rowKey(list, m), op); });
    const cmpEntries = [...this.pendingComparison].filter(([k]) => k.startsWith(`${list}:`));
    cmpEntries.forEach(([k]) => this.pendingComparison.delete(k));
    cmpEntries.forEach(([k, v]) => { const m = remap(Number(k.split(':')[1])); if (m !== null) this.pendingComparison.set(this.rowKey(list, m), v); });
  }
  addDimension(): void { this.form.dimensions.push({ name: '', label: '', cubeDimension: '' }); this.markDirty(); }
  removeDimension(i: number): void {
    const label = this.form.dimensions[i]?.name?.trim() || 'this dimension';
    this.askConfirm('Remove dimension', `Remove “${label}”?`, () => {
      if (this.form.dimensions.length > 1) {
        this.form.dimensions.splice(i, 1);
      } else {
        // Mirror removeOrClearCondition: a section always keeps ≥1 row, so the sole row is cleared back to
        // the empty literal (same one emptyForm/addDimension use) rather than spliced away — this lets the
        // trash icon show on a sole row without ever leaving the section rowless. Dimensions carry no
        // per-row UI state, so (unlike conditions) there is nothing to reindex/drop.
        this.form.dimensions[i] = { name: '', label: '', cubeDimension: '' };
      }
      this.markDirty();
    });
  }

  /** Which condition list a tree pick targets when nothing is focused: the base (denominator) list only
   *  when it is both shown and the current focus; the KPI (numerator) list otherwise (I1 rework). */
  // ── Guided condition row (I1 — Task 5): a structured VIEW over the flat MDX slot ──
  // The flat `form.kpiConditions[i]` / `form.baseConditions[i]` string stays the source of truth
  // (Decision 3). Operator + member caption are DERIVED from it via parseCondition on read; the operator
  // toggle recomposes it via composeCondition. A per-row free-text set records explicit "edit as MDX"
  // toggles; a non-canonical slot always reads as free-text so a hand-typed set is never hidden.
  private readonly freeTextRows = new Set<string>();

  /** Transient per-row operator hint (ABC-PLAN-01). A member-bearing operator other than plain `is`
   *  (isNot / isOneOf / isNotOneOf) chosen on a row with too few members to encode it has NO valid MDX
   *  slot form: `[lvl].&[]` parses back as `is`, `{}` is free-text, `EXCEPT(…{&[]})` is a live 422. This
   *  map holds the chosen operator ONLY across that window; `applyConditionOperator` clears it the moment
   *  the slot parses back to the chosen operator. Keyed exactly like `freeTextRows` (`rowKey(list,i)`) and
   *  cleaned up at the same lifecycle points. Never persisted — `formToDefinition` reads only the slot. */
  private readonly pendingOperator = new Map<string, ConditionOperator | ComparisonOp>();
  /** A comparison row's partially-entered measure/value while it is under-filled (no composable slot yet).
   *  Cleared the moment applyComparison composes a real AGGREGATE(...) slot. Keyed by rowKey, cleaned up
   *  at the same lifecycle points as pendingOperator. Never persisted (formToDefinition reads only slots). */
  private readonly pendingComparison = new Map<string, { measure: string; value: number | null }>();
  private rowKey(list: 'kpi' | 'base', i: number): string { return `${list}:${i}`; }
  private slot(list: 'kpi' | 'base', i: number): string {
    return (list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions)[i] ?? '';
  }

  /** The level a row ranges over, whether it parsed as a six-op condition or a comparison. */
  private rowLevelSpec(list: 'kpi' | 'base', i: number): string | undefined {
    const s = this.slot(list, i);
    return parseCondition(s)?.levelSpec ?? parseComparison(s)?.levelSpec ?? undefined;
  }

  /** Members of a level, keyed by the level's MDX spec, for the in-chip member dropdown. Populated
   *  eagerly (never lazily inside a template getter — that would fetch mid-change-detection and throw
   *  NG0100). The getter below reads this cache purely. Shares the exact getCubeMembers port the tree
   *  uses, so captions/keys match a tree-placed member byte-for-byte. */
  private readonly memberOptions = new Map<string, Array<{ name: string; key?: string; caption?: string }>>();
  private membersInFlight = new Set<string>();

  /** Ensure the members for a level spec are fetched into the cache (idempotent; needs a loaded cube). */
  private ensureMembers(levelSpec: string): void {
    if (!levelSpec || this.memberOptions.has(levelSpec) || this.membersInFlight.has(levelSpec)) return;
    const cube = this.form.cube;
    const dim = this.cubeShape?.dimensions.find((d) => d.levels.some((l) => l.spec === levelSpec))?.name;
    if (!cube || !dim) return;
    this.membersInFlight.add(levelSpec);
    this.dashboardChart.getCubeMembers(cube, dim, levelSpec).subscribe({
      next: (r) => {
        this.memberOptions.set(levelSpec, r.members);
        this.membersInFlight.delete(levelSpec);
        this.cdr.markForCheck();
      },
      error: () => { this.membersInFlight.delete(levelSpec); },
    });
  }

  /** Prefetch member lists for every guided `is` row so the dropdowns are populated on render. Called
   *  after a cube-shape load and whenever conditions are (re)seeded. */
  private prefetchConditionMembers(): void {
    for (const list of ['kpi', 'base'] as const) {
      const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
      for (let i = 0; i < arr.length; i++) {
        const p = parseCondition(arr[i] ?? '');
        if (p?.operator === 'is' && p.levelSpec) this.ensureMembers(p.levelSpec);
      }
    }
  }

  /** The member options a guided `is` row's dropdown shows — the placed level's members from the cube.
   *  Pure cache read (the fetch is kicked off eagerly elsewhere); empty until the fetch resolves. */
  conditionMemberOptions(list: 'kpi' | 'base', i: number): Array<{ name: string; key?: string; caption?: string }> {
    const spec = parseCondition(this.slot(list, i))?.levelSpec;
    if (!spec) return [];
    this.ensureMembers(spec);                     // idempotent; safe re-entry, no state change if cached
    return (this.memberOptions.get(spec) ?? [])
      .filter((m) => m.key !== NULL_MEMBER_KEY && m.name !== NULL_MEMBER_KEY);   // Item 2: (no value) not offered
  }

  /** The rows a SET popup renders: the offered live members, PLUS any already-selected key that is not
   *  among them (a value the user TYPED, a stored member the cube no longer lists, or the `<null>` bucket
   *  Item 2 keeps out of the OFFERED list). Without this an already-selected value has no checkbox and
   *  could only be removed by editing the raw MDX. Offered members keep their order; extras are appended
   *  so the selection is always fully de-selectable in place. Note the `<null>` filter belongs on the
   *  OFFERED list only (you cannot newly ADD it) — an already-selected null is not an offer, it is a
   *  standing selection that must stay removable, so it is deliberately NOT filtered out of extras. */
  conditionSetChoices(list: 'kpi' | 'base', i: number): Array<{ name: string; key?: string; caption?: string }> {
    const offered = this.conditionMemberOptions(list, i);
    const offeredKeys = new Set(offered.map((m) => m.key ?? m.name));
    const extras = this.conditionMemberKeys(list, i)
      .filter((k) => !offeredKeys.has(k))
      .map((k) => ({ name: k, key: k }));
    return [...offered, ...extras];
  }

  /** The full member universe per levelSpec, from the already-populated in-chip member cache. Feeds the
   *  analyzer's no-op checks; a level not yet fetched is simply absent (that check is skipped). */
  private levelMembersMap(): ReadonlyMap<string, readonly string[]> {
    const m = new Map<string, readonly string[]>();
    for (const [spec, members] of this.memberOptions) m.set(spec, members.map((x) => x.key ?? x.name));
    return m;
  }

  /** Analyze ONE list's guided rows (KPI and Base are separate universes — design §7), then lint the
   *  same list's RAW strings for the free-text unaggregated-FILTER trap the analyzer cannot see
   *  (SC-2701 Option 1). Disjoint row indices → plain concat. */
  conditionDiagnostics(list: 'kpi' | 'base'): Diagnostic[] {
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    return [
      ...analyzeConditions(arr.map((s) => parseCondition(s ?? '')), this.levelMembersMap()),
      ...lintFreeTextConditions(arr),
    ];
  }

  /** The diagnostics that name row `i` — drives that row's inline ⚠. */
  rowDiagnostics(list: 'kpi' | 'base', i: number): Diagnostic[] {
    return this.conditionDiagnostics(list).filter((d) => d.rows.includes(i));
  }

  /** True when a warning channel is currently firing on the row — drives the always-present quiet ⚠ icon
   *  by the field (hover/focus shows the full text via the global [data-tooltip]). Two channels: 'diag' (a
   *  value diagnostic names the row) and 'v180' (a free-text 1.8.0-only MDX form on a pre-1.8.0 release).
   *  The icon is the permanent resting form; the loud full text appears only as a transient toast when a
   *  direct edit triggers it (toastNewWarnings) — no stored dismissal state (spec §Part 2, toast model). */
  warningActive(list: 'kpi' | 'base', i: number, kind: 'diag' | 'v180'): boolean {
    if (kind === 'diag') return this.rowDiagnostics(list, i).length > 0;
    return !this.advancedMdxEnabled()
      && this.conditionIsFreeText(list, i)
      && this.conditionUsesAdvancedMdx(list, i);
  }

  /** The full caution text for a channel — the ⚠ icon's hover tooltip + aria-label, and the toast body
   *  fired when a direct edit newly triggers the warning. '' when the channel is not active. */
  warningMessage(list: 'kpi' | 'base', i: number, kind: 'diag' | 'v180'): string {
    if (kind === 'diag') return this.rowDiagnostics(list, i)[0]?.message ?? '';
    if (!this.warningActive(list, i, 'v180')) return '';
    return 'This condition uses an MDX form that requires SCO 1.8.0. On the current release the KPI may '
      + 'return no value. Use a single member value or "is null", or add separate condition rows, until '
      + '1.8.0 is available.';
  }

  /** The row's currently-active warning messages across both channels — the before/after snapshot the
   *  toast-on-edit diff compares. */
  private activeWarningMessages(list: 'kpi' | 'base', i: number): string[] {
    const out: string[] = [];
    for (const kind of ['diag', 'v180'] as const) {
      if (this.warningActive(list, i, kind)) out.push(this.warningMessage(list, i, kind));
    }
    return out;
  }

  /** Toast any warning a direct edit just introduced on the row: a message active AFTER the edit that was
   *  not active BEFORE it. No stored state — the quiet ⚠ icon is the permanent resting form; the loud text
   *  is a transient toast only when the user's own action triggers it, so a reload never re-fires it. The
   *  'diag' message embeds the offending value, so changing to a DIFFERENT bad value mints a new message
   *  and re-alerts; an unrelated edit that leaves the same problem in place does not (spec §Part 2). */
  private toastNewWarnings(list: 'kpi' | 'base', i: number, before: string[]): void {
    for (const msg of this.activeWarningMessages(list, i)) {
      if (msg && !before.includes(msg)) this.toasts.warning(msg);
    }
  }

  /** True once a list holds ≥2 rows — gates the one-line OR-vs-AND teaching hint (design §6). */
  conditionShowAndHint(list: 'kpi' | 'base'): boolean {
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    return arr.length >= 2;
  }

  /** True when a guided row's level is a rollup (non-leaf) level — drives the chip grain tooltip. */
  conditionIsRollup(list: 'kpi' | 'base', i: number): boolean {
    const spec = this.rowLevelSpec(list, i);
    if (!spec) return false;
    const dim = this.cubeShape?.dimensions.find((d) => d.levels.some((l) => l.spec === spec));
    if (!dim) return false;
    const idx = dim.levels.findIndex((l) => l.spec === spec);
    return idx >= 0 && idx < dim.levels.length - 1;
  }

  /** The currently-selected member key for a guided `is` row — '' when incomplete ("Select…"). Backs the
   *  member combobox's one-way [value]. */
  conditionMemberKey(list: 'kpi' | 'base', i: number): string {
    const op = this.conditionOperator(list, i);
    if (op !== 'is' && op !== 'isNot') return '';
    return this.conditionMemberKeys(list, i)[0] ?? '';
  }

  /** A stable per-row id tying the combobox <input list> to its own <datalist> (Item 1). Display plumbing. */
  conditionMemberListId(list: 'kpi' | 'base', i: number): string {
    return `cond-members-${list}-${i}`;
  }

  /** Pick the member for a single-member row from the combobox, recomposing under the row's CURRENT
   *  operator (is → [lvl].&[key]; isNot → EXCEPT(…{[lvl].&[key]})), not hard-coded to `is`. A picked
   *  option and a typed value are the same key here — both compose through the one path below. */
  selectConditionMember(list: 'kpi' | 'base', i: number, key: string): void {
    const p = parseCondition(this.slot(list, i));
    if (!p?.levelSpec) return;
    const op = this.conditionOperator(list, i);
    this.applyConditionOperator(list, i, op === 'isNot' ? 'isNot' : 'is', p.levelSpec, key === '' ? [] : [key]);
  }

  /** A guided row that cannot yet reach IRIS: a set operator with zero members, or a member-bearing
   *  operator held by a live pending hint still on the empty-key `[lvl].&[]` sentinel. Blocks save so the
   *  empty-key form (and the 422-inducing EXCEPT(…{&[]})) never reaches IRIS. */
  conditionIsIncomplete(list: 'kpi' | 'base', i: number): boolean {
    if (this.conditionIsComparison(list, i)) return parseComparison(this.slot(list, i)) === null;
    const p = parseCondition(this.slot(list, i));
    if (!p) return false;
    // A 0-member sentinel carrying a live hint is under-filled → incomplete. (A 1-member isNotOneOf also
    // carries a hint but IS complete — one exclusion is a valid query — so gate on the empty-key shape,
    // not merely hint presence.)
    if (p.operator === 'is' && (p.keys[0] ?? '') === '' && this.pendingOperator.has(this.rowKey(list, i))) return true;
    if (p.operator === 'is') return (p.keys[0] ?? '') === '';   // bare [lvl].&[] with no hint
    if (p.operator === 'isOneOf' || p.operator === 'isNotOneOf') return p.keys.length === 0;
    return false;   // isNot (≥1 key by construction) and the null variants are complete
  }

  /** The row's effective operator: the pending hint when the slot is a legitimate UNDER-FILL of the pinned
   *  operator, else the slot-derived one. Two under-fill shapes exist: the 0-member `[lvl].&[]` sentinel
   *  (parses `is`, pins any member-op), and a 1-member `EXCEPT(…{ref})` (parses `isNot`, pins `isNotOneOf`
   *  — its 1-member normalize, spec §5). Trusting the hint ONLY over those shapes bounds staleness: the
   *  instant the slot becomes a real ≥2 set / null / free-text (e.g. via ui_set_field) the slot wins. */
  conditionOperator(list: 'kpi' | 'base', i: number): ConditionOperator | ComparisonOp {
    const s = this.slot(list, i);
    const cmp = parseComparison(s);
    if (cmp) return cmp.op;
    const p = parseCondition(s);
    const pending = this.pendingOperator.get(this.rowKey(list, i));
    if (pending && this.pendingApplies(p, pending)) return pending;
    return p?.operator ?? 'is';
  }

  /** A pinned operator is honored only while the slot is a legitimate under-fill of it (see conditionOperator). */
  private pendingApplies(p: ParsedCondition | null, pending: ConditionOperator | ComparisonOp): boolean {
    if (!p) return false;
    if (p.operator === 'is' && (p.keys[0] ?? '') === '') return true;       // 0-member sentinel — any pinned op (six-op OR comparison)
    if (pending === 'isNotOneOf' && p.operator === 'isNot') return true;    // 1-member isNotOneOf normalize
    return false;
  }

  /** True for the set operators (checkbox multi-select member control). */
  conditionIsSetOperator(list: 'kpi' | 'base', i: number): boolean {
    const op = this.conditionOperator(list, i);
    return op === 'isOneOf' || op === 'isNotOneOf';
  }

  /** True when the operator needs a member control at all (everything but the null variants). */
  conditionWantsMember(list: 'kpi' | 'base', i: number): boolean {
    if (this.conditionIsComparison(list, i)) return false;
    const op = this.conditionOperator(list, i);
    return op !== 'isNull' && op !== 'isNotNull';
  }

  /** The real member keys currently in the slot — the `''` empty-key sentinel is not a member. Backs the
   *  checkbox list (set rows) and the single-member reads (is / isNot). */
  conditionMemberKeys(list: 'kpi' | 'base', i: number): string[] {
    const p = parseCondition(this.slot(list, i));
    return (p?.keys ?? []).filter((k) => k !== '');
  }

  /** The user-facing label for a member option — normalizes the null bucket to one friendly label
   *  regardless of the cube's nullReplacement (the raw `<null>` token never reaches the user). Display
   *  only; the member's KEY still drives the composed MDX. Shared with the model-tree rail. */
  conditionMemberLabel(m: { name?: string; key?: string; caption?: string }): string {
    return memberLabel(m);
  }

  /** The closed multi-select label: the chosen captions ("Battery, CPU") up to 3, else "N selected". */
  conditionSetSummary(list: 'kpi' | 'base', i: number): string {
    const keys = this.conditionMemberKeys(list, i);
    if (keys.length === 0) return 'Select…';
    if (keys.length > 3) return `${keys.length} selected`;
    const opts = this.conditionMemberOptions(list, i);
    return keys.map((k) => {
      const o = opts.find((x) => (x.key ?? x.name) === k);
      // A stored/loaded key no longer in the offered options (e.g. the filtered-out <null> bucket)
      // still resolves through memberLabel, so a saved null keeps reading as (no value).
      return o ? this.conditionMemberLabel(o) : this.conditionMemberLabel({ key: k, name: k });
    }).join(', ');
  }

  conditionHasLevel(list: 'kpi' | 'base', i: number): boolean {
    return this.rowLevelSpec(list, i) !== undefined;
  }
  /** The release gate for advanced (SCO 1.8.0) condition forms. A method, not a bare const read, so the
   *  template binds to it and specs can override it. */
  advancedMdxEnabled(): boolean {
    return ADVANCED_MDX_CONDITIONS;
  }

  /** True when row i's stored slot uses a 1.8.0 form by the LOUD superset (parse OR raw token). Drives
   *  the advisory (.condition-version-warning) ONLY — a false positive there is a dismissible caution. */
  conditionUsesAdvancedMdx(list: 'kpi' | 'base', i: number): boolean {
    return usesAdvancedMdx(this.slot(list, i));
  }

  /** True when the flag is off AND the slot PARSES to a gated form: the row must render as raw MDX
   *  because its guided operator is no longer offered, and it must NOT be silently rewritten. Uses the
   *  PARSE-ONLY detector, not usesAdvancedMdx: forcing on the loud superset would strand a safe member
   *  key whose text merely contains an MDX keyword (e.g. `&[R AND D]`) in free-text (GATE-PLAN-06 / §4.3). */
  conditionFreeTextForced(list: 'kpi' | 'base', i: number): boolean {
    return !this.advancedMdxEnabled() && parsesToAdvancedForm(this.slot(list, i));
  }

  conditionIsFreeText(list: 'kpi' | 'base', i: number): boolean {
    if (this.freeTextRows.has(this.rowKey(list, i))) return true;
    const s = this.slot(list, i);
    if (s.trim() === '') return false;
    if (this.conditionFreeTextForced(list, i)) return true;   // NEW: gated form on 1.7.3 → raw MDX view
    return parseCondition(s) === null && parseComparison(s) === null;   // guided six-op OR comparison → not free-text
  }
  /** Caption for the single-member chip — for `is` OR `isNot`. The tree owns display captions; the slot
   *  stores the key, which is acceptable this cycle. Empty for a level-less, set, or null-variant row. */
  conditionMemberCaption(list: 'kpi' | 'base', i: number): string {
    const op = this.conditionOperator(list, i);
    if (op !== 'is' && op !== 'isNot') return '';
    return this.conditionMemberKeys(list, i)[0] ?? '';
  }

  /** True when the row has no content yet — it renders level-first (chip redesign, spec §7): just the
   *  level <select> prompting the user to pick a dimension level, not a full chip and not a bare input. An
   *  explicitly free-texted empty row is NOT counted empty (the user opened the escape hatch to type). */
  conditionIsEmpty(list: 'kpi' | 'base', i: number): boolean {
    return this.slot(list, i).trim() === '' && !this.freeTextRows.has(this.rowKey(list, i));
  }

  /** The human level caption a guided chip shows FIRST (subject-first, spec §7). Resolved from the loaded
   *  cube shape (levelSpec → CubeShapeLevel.caption/name), humanized like every other picker label; falls
   *  back to the raw level spec when the shape is not loaded or the level is unknown, so the chip is never
   *  blank. Display-only — the flat MDX slot stays the source of truth. */
  conditionLevelCaption(list: 'kpi' | 'base', i: number): string {
    const spec = this.rowLevelSpec(list, i);
    if (!spec) return '';
    const level = this.cubeShape?.dimensions.flatMap((d) => d.levels).find((l) => l.spec === spec);
    return humanizeField(level?.caption ?? level?.name ?? spec);
  }

  /** The level dropdown's option groups: one optgroup per cube dimension, each level humanized and keyed
   *  on its unique MDX spec (a caption can repeat across dimensions — e.g. productId under two — so the
   *  VALUE must be l.spec, never the caption). Cached when the cube shape loads (avoids per-CD-cycle
   *  allocation that triggers infinite change detection). */
  conditionLevelGroups(): { dimension: string; levels: { spec: string; caption: string; label: string }[] }[] {
    return this.cachedLevelGroups;
  }

  /** The row's current level spec (or '' → the "Choose a field…" placeholder). Backs the level <select>. */
  conditionLevelSpec(list: 'kpi' | 'base', i: number): string {
    return this.rowLevelSpec(list, i) ?? '';
  }

  /** Change a row's level (design §5.2). Preserves the row's current operator and RESETS the member — a
   *  prior level's key is invalid on a new level. Routes through the ONE compose path so the member
   *  dropdown, diagnostics, dirty flag, and change-detection reconcile exactly as before. */
  setConditionLevel(list: 'kpi' | 'base', i: number, spec: string): void {
    if (!spec) return;                                    // placeholder re-selected — no-op
    const op = this.conditionOperator(list, i);           // '' / empty row → 'is'
    if (isComparisonOp(op)) {
      // Re-range the comparison on the new level, preserving measure/value.
      this.applyComparison(list, i, op, spec,
        this.conditionComparisonMeasure(list, i), this.conditionComparisonValue(list, i));
      return;
    }
    // Recompose on the new level with an empty member set: a set/single operator (is/isNot/…) becomes
    // under-filled and re-synthesizes the guided `[lvl].&[]` sentinel; an isNull/isNotNull operator
    // needs no member, so it re-synthesizes faithfully on the new level.
    this.applyConditionOperator(list, i, op, spec, []);
  }

  /** Recompose the row's slot under a new operator, keeping the established level (design §7). A thin
   *  wrapper over `applyConditionOperator` that carries any established members forward. One guard: a
   *  level-less row has nothing to compose. */
  setConditionOperator(list: 'kpi' | 'base', i: number, op: ConditionOperator | ComparisonOp): void {
    const s = this.slot(list, i);
    const levelSpec = parseCondition(s)?.levelSpec ?? parseComparison(s)?.levelSpec;
    if (!levelSpec) return;                                   // level-less — nothing to compose
    if (isComparisonOp(op)) {
      // Switching to / between comparison ops: carry measure+value if the row is already a comparison,
      // else start empty (→ under-filled). A six-op row's members are dropped (a comparison has none).
      this.applyComparison(list, i, op, levelSpec,
        this.conditionComparisonMeasure(list, i), this.conditionComparisonValue(list, i));
      return;
    }
    // Switching to a six-op operator (incl. from a comparison): reset to a member row (no members carried
    // from a comparison; carry the six-op members when coming from a six-op row).
    const keys = (parseCondition(s)?.keys ?? []).filter((k) => k !== '');
    // A 1-member row switching to isNotOneOf stays under-filled (needs ≥2) → hint holds it until a 2nd pick.
    this.applyConditionOperator(list, i, op, levelSpec, keys);
  }

  /** Recompose row `i`'s slot for `(op, keys)` and reconcile the pending-operator hint. `keys` is the set
   *  of REAL member keys (no '' sentinel). If the composed slot parses back to `op`, the operator lives in
   *  the slot and the hint is cleared; otherwise the row is under-filled — the slot holds the guided
   *  `[lvl].&[]` sentinel (save-blocked) and the hint carries `op`. Never composes EXCEPT(…{&[]}). */
  private applyConditionOperator(
    list: 'kpi' | 'base', i: number, op: ConditionOperator, levelSpec: string, keys: string[],
  ): void {
    const warnBefore = this.activeWarningMessages(list, i);
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    const key = this.rowKey(list, i);
    const sels = keys.map((k) => ({ dim: '', levelSpec, member: k, key: k }));
    // The null variants need no member; every member-bearing operator is encodable once it has ≥1 member.
    const canEncode = op === 'isNull' || op === 'isNotNull' || keys.length >= 1;
    if (canEncode) {
      arr[i] = composeCondition(sels.length ? sels : { dim: '', levelSpec, member: '', key: '' }, op);
      // A 1-member isNotOneOf composes EXCEPT(…{1 ref}), which parses back as isNot (spec §5 normalize).
      // Keep the hint over that one shape so the operator dropdown still reads "is not one of"; every other
      // encodable case now lives faithfully in the slot, so drop the hint.
      if (op === 'isNotOneOf' && keys.length === 1) this.pendingOperator.set(key, op);
      else this.pendingOperator.delete(key);
    } else {
      // Under-filled (0 members): keep the guided empty-key sentinel (blocks save) and pin the operator.
      arr[i] = composeCondition({ dim: '', levelSpec, member: '', key: '' }, 'is');
      if (op === 'is') this.pendingOperator.delete(key); else this.pendingOperator.set(key, op);
    }
    this.freeTextRows.delete(key);
    // This row is now a six-op row, so any abandoned comparison detail is unconditionally stale — drop it
    // so a later six-op→comparison switch-back starts empty (B-PLAN-10). applyComparison maintains its own.
    this.pendingComparison.delete(key);
    if (op !== 'isNull' && op !== 'isNotNull') this.ensureMembers(levelSpec);
    this.clearMergeOffer();   // spec §7.4: any guided row edit dismisses a pending merge offer
    this.markDirty();
    this.toastNewWarnings(list, i, warnBefore);
    this.cdr.markForCheck();
  }

  // ── Guided aggregate-comparison lane (SC-2701 Option 2) ──
  comparisonMeasureOptions(): string[] { return this.formCubeMeasures; }
  comparisonMeasuresAvailable(): boolean { return this.formCubeMeasures.length > 0; }

  /** True when the row's effective operator is a comparison (composed in the slot OR pending while
   *  under-filled). Drives the measure/value controls and hides the six-op member control. */
  conditionIsComparison(list: 'kpi' | 'base', i: number): boolean {
    return isComparisonOp(this.conditionOperator(list, i));
  }
  /** The row's comparison operator (falls back to '>' for a non-comparison row — callers gate on
   *  conditionIsComparison first). */
  conditionComparisonOp(list: 'kpi' | 'base', i: number): ComparisonOp {
    const op = this.conditionOperator(list, i);
    return isComparisonOp(op) ? op : '>';
  }
  /** The chosen measure name — from a composed slot, else the pending detail while under-filled, else ''. */
  conditionComparisonMeasure(list: 'kpi' | 'base', i: number): string {
    return parseComparison(this.slot(list, i))?.measure
      ?? this.pendingComparison.get(this.rowKey(list, i))?.measure
      ?? '';
  }
  /** The entered value — from a composed slot, else the pending detail while under-filled, else null. */
  conditionComparisonValue(list: 'kpi' | 'base', i: number): number | null {
    const cmp = parseComparison(this.slot(list, i));
    if (cmp) return cmp.value;
    return this.pendingComparison.get(this.rowKey(list, i))?.value ?? null;
  }

  /** Commit the measure of a comparison row (from the measure <select>). */
  setComparisonMeasure(list: 'kpi' | 'base', i: number, measure: string): void {
    const levelSpec = this.rowLevelSpec(list, i);
    if (!levelSpec) return;
    this.applyComparison(list, i, this.conditionComparisonOp(list, i), levelSpec,
      measure, this.conditionComparisonValue(list, i));
  }
  /** Commit the value of a comparison row (from the numeric input's `change`). Empty / non-finite → null,
   *  which keeps the row under-filled (save-blocked) rather than composing a bad string. */
  setComparisonValue(list: 'kpi' | 'base', i: number, raw: string): void {
    const levelSpec = this.rowLevelSpec(list, i);
    if (!levelSpec) return;
    const n = raw.trim() === '' ? null : Number(raw);
    const value = n !== null && Number.isFinite(n) ? n : null;
    this.applyComparison(list, i, this.conditionComparisonOp(list, i), levelSpec,
      this.conditionComparisonMeasure(list, i), value);
  }

  /** Recompose a comparison row's slot. When measure AND a finite value are present it composes the real
   *  AGGREGATE(...) slot and clears the pending op + detail; otherwise it keeps the guided empty-key
   *  sentinel (save-blocked) and stashes the op + partial measure/value in the pending maps. Mirrors
   *  applyConditionOperator's encode/under-fill split. */
  private applyComparison(
    list: 'kpi' | 'base', i: number, op: ComparisonOp, levelSpec: string,
    measure: string, value: number | null,
  ): void {
    const warnBefore = this.activeWarningMessages(list, i);
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    const key = this.rowKey(list, i);
    const composed = measure !== '' && value !== null && Number.isFinite(value)
      ? composeComparison({ levelSpec, measure, op, value })
      : null;
    if (composed) {
      arr[i] = composed;
      this.pendingOperator.delete(key);
      this.pendingComparison.delete(key);
    } else {
      arr[i] = composeCondition({ dim: '', levelSpec, member: '', key: '' }, 'is');   // [lvl].&[] sentinel
      this.pendingOperator.set(key, op);
      this.pendingComparison.set(key, { measure, value });
    }
    this.freeTextRows.delete(key);
    this.clearMergeOffer();
    this.markDirty();
    this.toastNewWarnings(list, i, warnBefore);
    this.cdr.markForCheck();
  }

  /** Check/uncheck a member on a set row, recomposing under the row's pending-aware effective operator. */
  toggleConditionMember(list: 'kpi' | 'base', i: number, key: string, checked: boolean): void {
    const p = parseCondition(this.slot(list, i));
    if (!p?.levelSpec) return;
    const op = this.conditionOperator(list, i);
    if (isComparisonOp(op)) return;   // a comparison row has no member checkboxes — never a set-operator here
    const keys = new Set(this.conditionMemberKeys(list, i));
    if (checked) keys.add(key); else keys.delete(key);
    this.applyConditionOperator(list, i, op, p.levelSpec, [...keys]);
  }

  /** Add a TYPED value to a set row (Item 1) through the SAME compose path a checkbox tick uses. Trimmed —
   *  a surrounding space is never part of a member key — and an all-whitespace entry is a no-op. Keys are
   *  otherwise case- and content-preserving (dimension keys are case-sensitive). */
  addTypedSetMember(list: 'kpi' | 'base', i: number, raw: string): void {
    const key = raw.trim();
    if (!key) return;
    this.toggleConditionMember(list, i, key, true);
  }

  /** Flip the row's free-text mode. Flip-back re-parses; if the current string is not guided-representable
   *  the row STAYS free-text and the typed value is never discarded (design §235). */
  toggleFreeText(list: 'kpi' | 'base', i: number): void {
    const warnBefore = this.activeWarningMessages(list, i);
    const key = this.rowKey(list, i);
    if (this.freeTextRows.has(key)) {
      // flip back to guided only if the current string parses as a six-op condition OR a guided
      // comparison; else stay free-text (non-destructive). A completed comparison slot is AGGREGATE(...),
      // which parseCondition rejects — without the parseComparison arm it would stick in free-text.
      if (parseCondition(this.slot(list, i)) !== null || parseComparison(this.slot(list, i)) !== null) {
        this.freeTextRows.delete(key);
      }
    } else {
      this.freeTextRows.add(key);
    }
    this.clearMergeOffer();   // spec §7.4: opening/closing the escape hatch is a row edit — drop a pending offer
    this.toastNewWarnings(list, i, warnBefore);
    this.cdr.markForCheck();
  }

  /** Write the free-text escape-hatch slot (design §7 (c)). A direct raw-MDX edit is still a row edit, so it
   *  clears any pending merge offer (spec §7.4). Replaces the bare `[(ngModel)]` two-way bind so the write
   *  routes through one place that can honour the offer contract. */
  onFreeTextInput(list: 'kpi' | 'base', i: number, value: string): void {
    const warnBefore = this.activeWarningMessages(list, i);
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    arr[i] = value;
    this.clearMergeOffer();
    this.markDirty();
    this.toastNewWarnings(list, i, warnBefore);
    this.cdr.markForCheck();
  }

  trackByIndex(index: number): number { return index; }

  /** trackBy for the set-member checklist: the member KEY (stable across re-render), NOT object identity.
   *  conditionSetChoices mints a fresh literal for a typed "extra" every call, so without this the typed
   *  <li> is destroyed+recreated on every change-detection pass and its checkbox click is dropped — the
   *  live "cannot de-select Android" bug. Keying on the key keeps each row's node identity stable. */
  trackConditionMember(_index: number, m: { name: string; key?: string }): string { return m.key ?? m.name; }

  /**
   * Build the KPI definition payload from the form, applying the conditional
   * field rules so IRIS only sees fields that make sense together.
   */
  private formToDefinition(): KpiDefinition {
    const f = this.form;
    const def: KpiDefinition = { name: f.name.trim() };
    if (f.label.trim()) def.label = f.label.trim();
    if (f.description.trim()) def.description = f.description.trim();
    if (f.type) def.type = f.type;
    if (f.baseObject) def.baseObject = f.baseObject;
    if (f.status) def.status = f.status;
    if (f.watchingThreshold !== null && f.watchingThreshold !== undefined) def.watchingThreshold = Number(f.watchingThreshold);
    if (f.warningThreshold !== null && f.warningThreshold !== undefined) def.warningThreshold = Number(f.warningThreshold);

    // Issue settings only apply when this is an issue KPI.
    def.issueKpi = f.issueKpi;
    if (f.issueKpi) {
      if (f.defaultIssueSeverity !== null && f.defaultIssueSeverity !== undefined) def.defaultIssueSeverity = Number(f.defaultIssueSeverity);
      if (f.analysisService.trim()) def.analysisService = f.analysisService.trim();
    }

    // DeepSee spec only applies to DeepSee KPIs.
    if (f.type === 'DeepSee') {
      const spec: KpiDefinition['deepseeKpiSpec'] = {
        namespace: getNamespace(), // sourced from env, not the form
        cube: f.cube,
        kpiMeasure: f.kpiMeasure || undefined,
        valueType: f.valueType,
        kpiConditions: f.kpiConditions.map(c => c.trim()).filter(Boolean),
        kpiDimensions: f.dimensions
          .filter(d => d.name.trim() || d.cubeDimension.trim())
          .map(d => ({
            name: d.name.trim(),
            label: d.label.trim() || undefined,
            cubeDimension: d.cubeDimension.trim() || undefined,
          })),
      };
      // baseConditions is the denominator — only meaningful for percentage KPIs.
      if (f.valueType === 'percentage') {
        spec.baseConditions = f.baseConditions.map(c => c.trim()).filter(Boolean);
      }
      def.deepseeKpiSpec = spec;
    }
    return def;
  }

  /** Client-side validation for Submit (IRIS requires cube + valueType). */
  private validateForSubmit(def: KpiDefinition): string | null {
    if (!def.name) return 'Name is required.';
    if (def.type === 'DeepSee') {
      if (!def.deepseeKpiSpec?.cube) return 'Cube is required for a DeepSee KPI.';
      if (!def.deepseeKpiSpec?.valueType) return 'Value type is required.';
      // KPI/base conditions are NOT required (SC-2704 / I4): a member-less DeepSee KPI is a valid
      // whole-population measure, and a percentage with no base condition means "denominator = whole
      // population". We still block INCOMPLETE rows: an `is` row whose level is set but no member
      // chosen (the [level].&[] sentinel) would ship a member-less filter to IRIS.
      if (this.hasIncompleteCondition('kpi')) return 'A KPI condition has no member selected — choose a member or remove the condition.';
      if (def.deepseeKpiSpec.valueType === 'percentage') {
        if (this.hasIncompleteCondition('base')) return 'A base condition has no member selected — choose a member or remove the condition.';
      }
    }
    return null;
  }

  /** True when any row in the list is a guided `is` with the level set but no member chosen yet. */
  private hasIncompleteCondition(list: 'kpi' | 'base'): boolean {
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    return arr.some((_, i) => this.conditionIsIncomplete(list, i));
  }

  // ── Save draft (local only, no IRIS) ──────────────────────────
  /**
   * `onDone` runs after a SUCCESSFUL save — used by the leave prompt's "Save
   * draft" so the deferred navigation happens once the draft is persisted. When
   * provided we do NOT re-select the saved KPI (we're leaving the page anyway).
   */
  saveDraft(onDone?: () => void, onError?: (message: string) => void): void {
    const def = this.formToDefinition();
    if (!def.name) {
      this.formError = 'Name is required to save a draft.';
      onError?.(this.formError);
      return;
    }
    this.savingDraft = true;
    this.formError = '';
    const original = this.formMode === 'edit' ? this.editOriginalName : undefined;
    this.kpiApi.saveKpiDraft(def, original).subscribe({
      next: () => {
        this.savingDraft = false;
        this.formDirty = false; // persisted
        this.editOriginalName = def.name;
        this.toasts.success(`KPI “${def.name}” saved as a draft.`);
        this.formMode = null;
        if (onDone) {
          // Leaving the page — refresh the list in the background, then navigate.
          this.reload();
          onDone();
          return;
        }
        // Return to the detail view for the saved draft once the list rebuilds.
        this.reload(() => {
          const found = this.findListed(def.name);
          if (found) this.selectKpi(found);
        });
      },
      error: err => {
        this.savingDraft = false;
        this.formError = err?.error?.message || err?.message || 'Failed to save draft';
        this.toasts.error(this.formError);
        this.cdr.markForCheck();
        onError?.(this.formError);
      },
    });
  }

  /**
   * Submit the SELECTED KPI straight from its detail view, without the user having to
   * open the form first — the common case being a KPI saved as a draft that they now
   * want pushed to SCO.
   *
   * Deliberately routed through the form: loading the saved definition in and calling
   * the very same `submit()` means there is no second, subtly different submit path
   * (same validation, same create-vs-update decision, same draft cleanup). Both steps
   * are synchronous, so the definition is in the form before submit reads it.
   *
   * On success `submit()` returns to the detail view by itself. If validation fails the
   * user is left in the form with the error, which is where the problem can be fixed.
   */
  submitSelected(): void {
    if (!this.selectedKpi || this.submitting) return;
    this.openEditForm();
    this.submit();
  }

  /**
   * The detail-view Submit button's hint. Offered for EVERY selected KPI, not only a
   * draft: a KPI already in SCO is re-submitted as an update, which is a legitimate thing
   * to want (push it again after an out-of-band change, or confirm what is live matches
   * the definition). The wording just has to say which of the two is about to happen.
   */
  get submitSelectedHint(): string {
    return this.selectedKpi?.state === 'draft'
      ? 'Submit this draft to SCO'
      : 'Re-submit this KPI to SCO (updates the live definition)';
  }

  // ── Submit (create or update in SCO) ─────────────────────────
  submit(): void {
    const def = this.formToDefinition();
    const problem = this.validateForSubmit(def);
    if (problem) { this.formError = problem; return; }
    this.submitting = true;
    this.formError = '';

    const isEdit = this.formMode === 'edit';
    // A reopened draft may never have reached IRIS (openEditForm always sets
    // 'edit'), so a PUT would 404. The IRIS list decides the verb. On a rename the
    // existence key is the ORIGINAL name, which is also what the SCO API keys by.
    const isUpdate = isEdit && this.irisKpis.some(k => k.name === this.editOriginalName);
    const call = isUpdate
      ? this.kpiApi.updateKpiDefinition(this.editOriginalName, def)
      : this.kpiApi.createKpiDefinition(def);

    call.subscribe({
      next: () => {
        // Success — drop any local draft(s) for this KPI (and the old name if renamed).
        this.kpiApi.deleteKpiDraft(def.name).subscribe({ next: () => {}, error: () => {} });
        if (isEdit && this.editOriginalName && this.editOriginalName !== def.name) {
          this.kpiApi.deleteKpiDraft(this.editOriginalName).subscribe({ next: () => {}, error: () => {} });
          // Carry the KPI's group assignment across the rename.
          this.kpiGroups.renameKpi(this.editOriginalName, def.name);
        }
        this.submitting = false;
        this.formDirty = false; // submitted — nothing to auto-save
        this.toasts.success(isUpdate ? `KPI “${def.name}” updated in SCO.` : `KPI “${def.name}” created in SCO.`);
        this.formMode = null;
        this.reload(() => {
          const found = this.findListed(def.name);
          if (found) this.selectKpi(found);
        });
      },
      error: err => {
        this.submitting = false;
        this.formError = err?.error?.message || err?.message || 'Failed to submit KPI to SCO';
        this.toasts.error(this.formError);
        this.cdr.markForCheck();
      },
    });
  }

  private findListed(name: string): ListedKpi | null {
    for (const g of this.groups) {
      const hit = g.items.find(k => k.name === name);
      if (hit) return hit;
    }
    return null;
  }

  // ── Delete ────────────────────────────────────────────────────
  /** Ask for confirmation before deleting/discarding the selected KPI. */
  deleteKpi(): void {
    if (!this.selectedKpi || this.deleting) return;
    this.showDeleteConfirm = true;
    this.cdr.markForCheck();
  }

  /** Message shown in the delete-confirm modal (draft vs created wording). */
  get deleteConfirmMessage(): string {
    const kpi = this.selectedKpi;
    if (!kpi) return '';
    const label = kpi.label || kpi.name;
    return this.isDraftOnly
      ? `Discard draft “${label}”? It was never submitted to SCO.`
      : `Delete KPI “${label}”? This permanently removes its definition from SCO.`;
  }

  /** Perform the delete/discard once the user confirms. */
  confirmDelete(): void {
    const kpi = this.selectedKpi;
    this.showDeleteConfirm = false;
    if (!kpi || this.deleting) return;
    const name = kpi.name;
    const isDraftOnly = kpi.state === 'draft' && !this.irisKpis.some(k => k.name === name);
    this.deleting = true;
    this.deleteError = '';
    this.cdr.markForCheck();

    const afterDelete = () => {
      // Always drop the local draft too, then refresh.
      this.kpiApi.deleteKpiDraft(name).subscribe({ next: () => {}, error: () => {} });
      this.kpiGroups.forget(name);
      this.deleting = false;
      if (this.selectedKpi?.name === name) this.selectedKpi = null;
      this.toasts.success(`KPI “${name}” deleted.`);
      this.reload();
    };

    if (isDraftOnly) {
      // Draft never reached SCO — just delete the draft.
      this.kpiApi.deleteKpiDraft(name).subscribe({
        next: () => { this.kpiGroups.forget(name); this.deleting = false; if (this.selectedKpi?.name === name) this.selectedKpi = null; this.toasts.success(`Draft “${name}” discarded.`); this.reload(); },
        error: err => { this.deleting = false; this.deleteError = err?.error?.message || err?.message || 'Failed to discard draft'; this.toasts.error(this.deleteError); this.cdr.markForCheck(); },
      });
      return;
    }

    this.kpiApi.deleteKpiDefinition(name).subscribe({
      next: afterDelete,
      error: err => {
        this.deleting = false;
        this.deleteError = err?.error?.message || err?.message || 'Failed to delete KPI';
        this.toasts.error(this.deleteError);
        this.cdr.markForCheck();
      },
    });
  }

  // ── Detail view data (value / breakdown / listing) ────────────
  selectKpi(kpi: ListedKpi): void {
    this.selectedKpi = kpi;
    this.formMode = null;
    this.jsonModalOpen = false;
    this.columnPickerOpen = false;
    this.deleteError = '';
    this.selectedDimension = '';
    this.kpiHealth = null;
    this.healthError = '';
    this.issueBreakdown = NO_ISSUE_BREAKDOWN;
    this.thresholdRuler = null;
    this.breakdown = [];
    this.breakdownTop = [];
    this.breakdownError = '';
    this.listingRows = [];
    this.listingColumns = [];
    this.listingError = '';
    this.listingPage = 1;
    this.listingHasMore = false;
    this.listingSortBy = '';
    this.listingSortDesc = false;
    this.listingInitialized = false;
    this.columnPickerItems = [];

    // Draft-only KPIs have no data in SCO yet — skip the live panels.
    if (kpi.state === 'draft' && !this.irisKpis.some(k => k.name === kpi.name)) {
      this.cdr.markForCheck();
      return;
    }

    // The column picker is seeded from the listing response itself (see
    // fetchListing), so no separate object-detail lookup is needed.
    this.fetchHealth(kpi.name);
    this.fetchListing(kpi.name);
  }

  /** Is the currently selected KPI a local draft that was never submitted? */
  get isDraftOnly(): boolean {
    return !!this.selectedKpi && this.selectedKpi.state === 'draft' && !this.irisKpis.some(k => k.name === this.selectedKpi!.name);
  }

  onDimensionChange(): void {
    if (!this.selectedKpi || !this.selectedDimension) { this.breakdown = []; this.breakdownTop = []; return; }
    this.fetchBreakdown(this.selectedKpi.name, this.selectedDimension);
  }

  fetchHealth(name: string): void {
    this.healthLoading = true;
    this.healthError = '';
    this.kpiHealth = null;
    this.issueBreakdown = NO_ISSUE_BREAKDOWN;
    this.thresholdRuler = null;
    this.kpiHealth$?.unsubscribe();
    this.kpiHealth$ = this.kpiHealthApi.getKpiHealth(name).subscribe({
      next: (h) => {
        this.healthLoading = false;
        this.kpiHealth = h;
        this.issueBreakdown = deriveIssueBreakdown(h);
        this.thresholdRuler = deriveThresholdRuler(h);
        this.cdr.markForCheck();
      },
      error: () => { this.healthLoading = false; this.healthError = 'Unable to load live value'; this.cdr.markForCheck(); },
    });
  }

  /** Connection light on the Live Value tile: the state of the last live read. */
  get connState(): 'connecting' | 'live' | 'down' {
    if (this.healthLoading) return 'connecting';
    return this.healthError ? 'down' : 'live';
  }

  get connLabel(): string {
    return CONN_LABEL[this.connState];
  }

  /** Plain-language threshold status for the Threshold tile (same wording as the dashboard footer). */
  thresholdStatusLabel(status: 'ok' | 'watching' | 'warning' | null | undefined): string {
    return status ? THRESHOLD_STATUS_LABEL[status] : 'Unknown';
  }

  private fetchBreakdown(name: string, dimension: string): void {
    this.breakdownLoading = true;
    this.breakdown = [];
    this.breakdownTop = [];
    this.breakdownError = '';
    this.kpiApi.getKpiData(name, dimension).subscribe({
      next: res => {
        this.breakdownLoading = false;
        // Members with no contribution add a row and a bar stub but no information —
        // drop them so the tile lists only dimension members with a value.
        const values: { label: string | number; value: any }[] = res?.values ?? [];
        this.breakdown = values.filter(v => (Number(v.value) || 0) !== 0);
        // The tile is one fixed-height row of the grid and does not scroll: rank by
        // value and render only the rows that fit; the header notes the rest.
        this.breakdownTop = [...this.breakdown]
          .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))
          .slice(0, BREAKDOWN_ROWS);
        this.cdr.markForCheck();
      },
      error: () => { this.breakdownLoading = false; this.breakdownError = 'Unable to load breakdown'; this.cdr.markForCheck(); },
    });
  }

  private fetchListing(name: string): void {
    this.listingLoading = true;
    const sortParam = this.listingSortBy ? (this.listingSortDesc ? `-${this.listingSortBy}` : this.listingSortBy) : undefined;
    this.kpiApi.getKpiListing(name, null, this.listingPageSize, this.listingPage - 1, sortParam).subscribe({
      next: rows => {
        this.listingLoading = false;
        const data = Array.isArray(rows) ? rows : [];
        this.listingHasMore = data.length === this.listingPageSize;
        if (data.length > 0) {
          if (!this.listingInitialized) {
            // Seed the column picker from the listing response's own columns
            // (skip nested array/object fields, which aren't scalar columns).
            const apiCols = Object.keys(data[0]).filter(k => !Array.isArray(data[0][k]) && typeof data[0][k] !== 'object');
            this.columnPickerItems = apiCols.map(n => ({ name: n, selected: true }));
            this.listingColumns = [...apiCols];
            this.listingInitialized = true;
          }
          this.listingRows = data;
        } else if (this.listingPage === 1) {
          this.listingRows = [];
        }
        this.cdr.markForCheck();
      },
      error: () => { this.listingLoading = false; this.listingError = 'Unable to load listing'; this.cdr.markForCheck(); },
    });
  }


  listingPageTo(page: number): void {
    if (!this.selectedKpi || this.listingLoading) return;
    this.listingPage = page;
    this.fetchListing(this.selectedKpi.name);
  }

  listingSortOn(col: string): void {
    if (!this.selectedKpi) return;
    if (this.listingSortBy === col) this.listingSortDesc = !this.listingSortDesc;
    else { this.listingSortBy = col; this.listingSortDesc = false; }
    this.listingPage = 1;
    this.fetchListing(this.selectedKpi.name);
  }

  toggleColumnPicker(): void { this.columnPickerOpen = !this.columnPickerOpen; }

  applyColumnPicker(): void {
    this.listingColumns = this.columnPickerItems.filter(p => p.selected).map(p => p.name);
    this.columnPickerOpen = false;
    this.cdr.markForCheck();
  }

  movePickerItem(index: number, dir: -1 | 1): void {
    const target = index + dir;
    if (target < 0 || target >= this.columnPickerItems.length) return;
    const items = this.columnPickerItems;
    [items[index], items[target]] = [items[target], items[index]];
    this.columnPickerItems = [...items];
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (this.columnPickerOpen && !target.closest('.listing-col-picker-wrap')) {
      this.columnPickerOpen = false;
    }
    // Close the "+" add menu / group popover on any outside click.
    if (this.addMenuOpen && !target.closest('.kpi-add-wrap')) {
      this.addMenuOpen = false;
    }
    if (this.addingGroup && !target.closest('.kpi-add-wrap')) {
      this.addingGroup = false;
    }
  }

  toggleGroup(group: KpiGroup): void { group.expanded = !group.expanded; }
  openJsonModal(): void { this.jsonModalOpen = true; }
  closeJsonModal(): void { this.jsonModalOpen = false; }

  // ── User-defined groups ───────────────────────────────────────
  /** Sentinel bucket name (blank label in the UI), exposed for the template. */
  readonly UNGROUPED = UNGROUPED;

  /** The single "+" add menu (choose: new KPI or new group). */
  addMenuOpen = false;
  /** Floating "new group" input state (popover, no layout gap). */
  addingGroup = false;
  newGroupName = '';

  /** Drag-and-drop: the KPI name currently being dragged, and the drop-target group. */
  draggingKpi: string | null = null;
  dragOverGroup: string | null = null;

  // ── The combined "+" add menu ─────────────────────────────────
  toggleAddMenu(): void {
    this.addMenuOpen = !this.addMenuOpen;
    this.cdr.markForCheck();
  }
  closeAddMenu(): void {
    if (this.addMenuOpen) { this.addMenuOpen = false; this.cdr.markForCheck(); }
  }
  /** Menu → "New KPI": close the menu and open the create form (guarded). */
  addMenuNewKpi(): void {
    this.addMenuOpen = false;
    this.attemptNewForm();
  }
  /** Menu → "New group": close the menu and reveal the group-name popover. */
  addMenuNewGroup(): void {
    this.addMenuOpen = false;
    this.startAddGroup();
  }

  /** Reveal the floating "new group" input. */
  startAddGroup(): void {
    this.addingGroup = true;
    this.newGroupName = '';
    this.cdr.markForCheck();
  }
  cancelAddGroup(): void {
    this.addingGroup = false;
    this.newGroupName = '';
    this.cdr.markForCheck();
  }
  /** Create the typed group (empty groups render so the user can drop KPIs in). */
  confirmAddGroup(): void {
    const created = this.kpiGroups.createGroup(this.newGroupName);
    this.addingGroup = false;
    this.newGroupName = '';
    if (created) this.buildGroups();
    this.cdr.markForCheck();
  }

  // ── Drag-and-drop: drag a KPI onto a group header to assign it ──
  /** Off-screen node used as the custom drag image (removed on drag end). */
  private dragImageEl: HTMLElement | null = null;

  onKpiDragStart(kpi: ListedKpi, event: DragEvent): void {
    this.draggingKpi = kpi.name;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Some browsers require data to be set for the drag to start.
      event.dataTransfer.setData('text/plain', kpi.name);
      // Use a CUSTOM drag image — a clean chip with just the KPI name. The native
      // snapshot of the row would also capture its [data-tooltip] bubble (the
      // black label) and can bleed into the row below; a purpose-built element
      // avoids both. It must be in the DOM (off-screen) at snapshot time.
      if (typeof event.dataTransfer.setDragImage === 'function') {
        const chip = makeDragChip(this.displayName(kpi));   // shared off-screen chip (same as the tree's member drag)
        document.body.appendChild(chip);
        this.dragImageEl = chip;
        event.dataTransfer.setDragImage(chip, 12, 16);
      }
    }
  }
  onKpiDragEnd(): void {
    this.draggingKpi = null;
    this.dragOverGroup = null;
    if (this.dragImageEl) { this.dragImageEl.remove(); this.dragImageEl = null; }
    this.cdr.markForCheck();
  }
  /** Allow dropping on a group; highlight it as the active target. */
  onGroupDragOver(group: KpiGroup, event: DragEvent): void {
    if (!this.draggingKpi) return;
    event.preventDefault(); // enables the drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (this.dragOverGroup !== group.name) {
      this.dragOverGroup = group.name;
      this.cdr.markForCheck();
    }
  }
  onGroupDragLeave(group: KpiGroup): void {
    if (this.dragOverGroup === group.name) {
      this.dragOverGroup = null;
      this.cdr.markForCheck();
    }
  }
  /** Drop the dragged KPI into the target group (or blank/Ungrouped to clear). */
  onGroupDrop(group: KpiGroup, event: DragEvent): void {
    event.preventDefault();
    const name = this.draggingKpi;
    this.draggingKpi = null;
    this.dragOverGroup = null;
    if (!name) return;
    this.kpiGroups.assign(name, group.name); // group.name === UNGROUPED clears it
    this.buildGroups();
    this.cdr.markForCheck();
  }

  // ── Drag-and-drop: drag a condition ROW to reorder; drop onto a same-level row to OFFER a merge ──
  /** Drop-target affordance for a condition row/area (reuses the .condition-row--target treatment). */
  readonly dragOverCondition = signal<{ list: 'kpi' | 'base'; i: number | null } | null>(null);
  /** The active drag's source row, set on dragstart, cleared on dragend/drop. */
  private draggingRow: { list: 'kpi' | 'base'; i: number } | null = null;
  /** A pending post-drop merge offer (design §7.4). Lives on the parent (never in an @if child). */
  readonly mergeOffer = signal<{ list: 'kpi' | 'base'; keepIndex: number; dropIndex: number } | null>(null);

  private hasRowPayload(dt: DataTransfer | null): boolean {
    return !!dt && Array.from(dt.types ?? []).includes('application/x-condition-row');
  }

  onRowDragStart(list: 'kpi' | 'base', i: number, event: DragEvent): void {
    this.draggingRow = { list, i };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-condition-row', JSON.stringify({ list, i }));
      if (typeof event.dataTransfer.setDragImage === 'function') {
        const chip = makeDragChip(this.conditionLevelCaption(list, i) || 'condition');
        document.body.appendChild(chip);
        this.dragImageEl = chip;                       // reuses the existing off-screen drag-image field
        event.dataTransfer.setDragImage(chip, 12, 16);
      }
    }
  }

  onRowDragEnd(): void {
    this.draggingRow = null;
    this.dragOverCondition.set(null);
    if (this.dragImageEl) { this.dragImageEl.remove(); this.dragImageEl = null; }
    this.cdr.markForCheck();
  }

  onConditionDragOver(list: 'kpi' | 'base', i: number | null, event: DragEvent): void {
    if (!this.hasRowPayload(event.dataTransfer)) return;   // not our payload — let others handle
    event.preventDefault();                                // enables the drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const cur = this.dragOverCondition();
    if (!cur || cur.list !== list || cur.i !== i) { this.dragOverCondition.set({ list, i }); this.cdr.markForCheck(); }
  }

  onConditionDragLeave(list: 'kpi' | 'base', i: number | null): void {
    const cur = this.dragOverCondition();
    if (cur && cur.list === list && cur.i === i) { this.dragOverCondition.set(null); this.cdr.markForCheck(); }
  }

  onConditionDrop(list: 'kpi' | 'base', i: number | null, event: DragEvent): void {
    event.preventDefault();
    this.dragOverCondition.set(null);
    const raw = event.dataTransfer?.getData('application/x-condition-row');
    const src = this.draggingRow;
    this.draggingRow = null;
    let payload: { list: 'kpi' | 'base'; i: number } | null = null;
    if (raw) { try { payload = JSON.parse(raw); } catch { payload = null; } }
    const source = payload ?? src;                         // payload wins; fall back to the field (jsdom)
    if (!source || source.list !== list) { this.cdr.markForCheck(); return; }  // no cross-list move
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    const from = source.i;
    const to = i === null ? arr.length - 1 : i;            // area drop → end
    if (from < 0 || from >= arr.length || from === to) { this.mergeOffer.set(null); this.cdr.markForCheck(); return; }

    // Capture BEFORE the move so mergeability is decided on the original pair.
    const mergeable = i === null ? null
      : conditionsMergeable(parseCondition(arr[from] ?? ''), parseCondition(arr[to] ?? ''));

    this.moveConditionRow(list, from, to);
    this.moveConditionRowState(list, from, to);

    if (mergeable) {
      // After the move the dragged row sits AT `to`; the target it landed on shifted by one.
      const dropIndex = to;
      const keepIndex = from < to ? to - 1 : to + 1;
      this.mergeOffer.set({ list, keepIndex, dropIndex });
    } else {
      this.mergeOffer.set(null);
    }
    this.markDirty();
    this.cdr.markForCheck();
  }

  /** Splice the row out of `from` and insert it at `to` (standard reorder-to-position). */
  private moveConditionRow(list: 'kpi' | 'base', from: number, to: number): void {
    const arr = list === 'kpi' ? this.form.kpiConditions : this.form.baseConditions;
    const [row] = arr.splice(from, 1);
    arr.splice(to, 0, row);
  }

  /** Shift the per-row UI maps (freeTextRows, pendingOperator, pendingComparison) to follow a move from→to.
   *  A move is a remove-at-`from` then insert-at-`to`; this generalizes the single-index
   *  reindexConditionRowState. */
  private moveConditionRowState(list: 'kpi' | 'base', from: number, to: number): void {
    const remap = (n: number): number => {
      if (n === from) return to;
      // Row removed at `from`, reinserted at `to`: indices between shift by one.
      let m = n > from ? n - 1 : n;          // account for the removal
      if (m >= to) m += 1;                   // account for the insertion
      return m;
    };
    const rebuildSet = (set: Set<string>) => {
      const rows = [...set].filter((k) => k.startsWith(`${list}:`)).map((k) => Number(k.split(':')[1]));
      rows.forEach((n) => set.delete(this.rowKey(list, n)));
      rows.forEach((n) => set.add(this.rowKey(list, remap(n))));
    };
    rebuildSet(this.freeTextRows);
    const entries = [...this.pendingOperator].filter(([k]) => k.startsWith(`${list}:`));
    entries.forEach(([k]) => this.pendingOperator.delete(k));
    entries.forEach(([k, op]) => this.pendingOperator.set(this.rowKey(list, remap(Number(k.split(':')[1]))), op));
    const cmpEntries = [...this.pendingComparison].filter(([k]) => k.startsWith(`${list}:`));
    cmpEntries.forEach(([k]) => this.pendingComparison.delete(k));
    cmpEntries.forEach(([k, v]) => this.pendingComparison.set(this.rowKey(list, remap(Number(k.split(':')[1]))), v));
  }

  /** Fold the dropped row into the kept row as a union set, then remove the dropped row. Reuses the ONE
   *  compose path (`applyConditionOperator`) and announces the result via an info toast. */
  mergeConditionRows(list: 'kpi' | 'base', keepIndex: number, dropIndex: number): void {
    const keep = parseCondition(this.slot(list, keepIndex));
    const drop = parseCondition(this.slot(list, dropIndex));
    const m = conditionsMergeable(drop, keep);
    if (!m || !keep) { this.mergeOffer.set(null); this.cdr.markForCheck(); return; }
    const union = [...new Set([...(keep.keys ?? []), ...(drop?.keys ?? [])])].filter((k) => k !== '');
    const op = union.length > 1 ? m.op : (m.op === 'isOneOf' ? 'is' : 'isNot');
    this.applyConditionOperator(list, keepIndex, op, keep.levelSpec, union);
    this.removeOrClearCondition(list, dropIndex);
    this.mergeOffer.set(null);
    const verb = op === 'isOneOf' ? 'is one of' : op === 'isNotOneOf' ? 'is not one of' : op === 'isNot' ? 'is not' : 'is';
    // dropIndex was after keepIndex? removing it does not move keepIndex; if before, keepIndex shifts down 1.
    const keptAfter = dropIndex < keepIndex ? keepIndex - 1 : keepIndex;
    this.toasts.info(`Combined into "${this.conditionLevelCaption(list, keptAfter)} ${verb} ${this.conditionSetSummary(list, keptAfter)}"`);
    this.cdr.markForCheck();
  }

  isMergeOffer(list: 'kpi' | 'base', i: number): boolean {
    const o = this.mergeOffer();
    return !!o && o.list === list && o.dropIndex === i;
  }
  acceptMergeOffer(): void {
    const o = this.mergeOffer();
    if (o) this.mergeConditionRows(o.list, o.keepIndex, o.dropIndex);
  }
  dismissMergeOffer(): void { this.mergeOffer.set(null); this.cdr.markForCheck(); }
  /** Drop a pending merge offer (spec §7.4). Called from every guided row edit (`applyConditionOperator`)
   *  and every add/remove so the offer's captured indices can never outlive the pair they described.
   *  No-op when nothing is pending, so the common non-drag edit path pays only a null check. */
  private clearMergeOffer(): void { if (this.mergeOffer() !== null) { this.mergeOffer.set(null); this.cdr.markForCheck(); } }
  /** The relation the merge would produce, for the offer/label copy. */
  mergeOfferVerb(): string {
    const o = this.mergeOffer();
    if (!o) return '';
    const m = conditionsMergeable(parseCondition(this.slot(o.list, o.dropIndex)), parseCondition(this.slot(o.list, o.keepIndex)));
    return m?.op === 'isNotOneOf' ? 'is not one of' : 'is one of';
  }
  /** The kept row's label, for "Combine with "…"?" */
  mergeOfferOtherLabel(): string {
    const o = this.mergeOffer();
    return o ? this.conditionLevelCaption(o.list, o.keepIndex) : '';
  }

  /** For the keyboard path (design §7.5): if row `i` is in a positive same-level contradiction/orNudge
   *  pair, return the pair to combine (keep the earlier row). Positive family only — the analyzer never
   *  flags isNot pairs, so those stay drag-only. */
  conditionCombineTarget(list: 'kpi' | 'base', i: number): { keepIndex: number; dropIndex: number } | null {
    const diag = this.rowDiagnostics(list, i).find((d) => (d.kind === 'contradiction' || d.kind === 'orNudge') && d.rows.length === 2);
    if (!diag) return null;
    const [a, b] = diag.rows;
    const other = a === i ? b : a;
    if (!conditionsMergeable(parseCondition(this.slot(list, i)), parseCondition(this.slot(list, other)))) return null;
    const keepIndex = Math.min(i, other), dropIndex = Math.max(i, other);
    return { keepIndex, dropIndex };
  }

  // ── Delete a group (and every KPI under it) ───────────────────
  /** The group awaiting the delete confirmation (drives the confirm dialog). */
  groupPendingDelete: KpiGroup | null = null;

  /** Ask to confirm deleting a group and everything in it. */
  requestDeleteGroup(group: KpiGroup): void {
    if (group.name === UNGROUPED) return;
    this.groupPendingDelete = group;
    this.cdr.markForCheck();
  }
  cancelDeleteGroup(): void {
    this.groupPendingDelete = null;
    this.cdr.markForCheck();
  }

  /** Confirm text for the group-delete dialog. */
  get deleteGroupMessage(): string {
    const g = this.groupPendingDelete;
    if (!g) return '';
    const n = g.items.length;
    return n === 0
      ? `Delete the group “${g.name}”?`
      : `Delete the group “${g.name}” and its ${n} KPI${n === 1 ? '' : 's'}? ` +
        `The KPIs are permanently removed from SCO (drafts are discarded). This cannot be undone.`;
  }

  /**
   * Delete a group AND every KPI under it: delete each KPI from SCO (or discard
   * its draft), then drop the group. Runs the deletes in parallel and refreshes once.
   */
  confirmDeleteGroup(): void {
    const group = this.groupPendingDelete;
    this.groupPendingDelete = null;
    if (!group || group.name === UNGROUPED) return;

    const items = [...group.items];
    this.deleting = true;
    this.deleteError = '';
    this.cdr.markForCheck();

    const deleteOne = (kpi: ListedKpi) => {
      const draftOnly = kpi.state === 'draft' && !this.irisKpis.some((k) => k.name === kpi.name);
      const req$ = draftOnly ? this.kpiApi.deleteKpiDraft(kpi.name) : this.kpiApi.deleteKpiDefinition(kpi.name);
      return req$.pipe(
        // Always also drop any local draft for a created KPI; swallow per-item
        // errors so one failure doesn't abort the whole group cleanup.
        switchMap(() => (draftOnly ? of(null) : this.kpiApi.deleteKpiDraft(kpi.name))),
        catchError(() => of(null)),
      );
    };

    const finish = () => {
      // Clear the group + all its assignments locally, then refresh from SCO.
      this.kpiGroups.deleteGroup(group.name);
      if (this.selectedKpi && items.some((k) => k.name === this.selectedKpi!.name)) {
        this.selectedKpi = null;
      }
      this.deleting = false;
      this.toasts.success(
        items.length
          ? `Group “${group.name}” and its ${items.length} KPI${items.length === 1 ? '' : 's'} deleted.`
          : `Group “${group.name}” deleted.`,
      );
      this.reload();
    };

    if (!items.length) { finish(); return; }
    forkJoin(items.map(deleteOne)).subscribe({ next: finish, error: finish });
  }

  displayName(kpi: KpiDefinition): string { return kpi.label || kpi.name; }

  get rawJson(): string { return JSON.stringify(this.selectedKpi, null, 2); }

  get breakdownMax(): number {
    if (!this.breakdown.length) return 1;
    return Math.max(...this.breakdown.map(v => Number(v.value) || 0), 1);
  }

  formatCellValue(val: any): string {
    if (val === null || val === undefined) return '—';
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'number') return val.toLocaleString();
    const s = String(val);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
    return s;
  }

  formatColumnHeader(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
  }

  /** Human label for issue severity (1 = most critical … 5 = least critical). */
  severityLabel(sev: number | null | undefined): string {
    switch (sev) {
      case 1: return '1 — Most critical';
      case 2: return '2 — High';
      case 3: return '3 — Medium';
      case 4: return '4 — Low';
      case 5: return '5 — Least critical';
      default: return sev != null ? String(sev) : '—';
    }
  }
}

function sortByName(a: KpiDefinition, b: KpiDefinition): number {
  return (a.label || a.name).localeCompare(b.label || b.name);
}

/** The last dot-segment of a class name (e.g. "SC.Data.SalesOrder" → "SalesOrder"). */
function shortClassName(className: string): string {
  const seg = className.split('.').pop();
  return seg && seg.length ? seg : className;
}
