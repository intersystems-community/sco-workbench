import { Component, OnInit, OnDestroy, ElementRef, ViewChild, HostListener, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScModelService } from '../services/sc-model.service';
import { DataBrowserService, type CountResult } from '../services/data-browser.service';
import { forkJoin } from 'rxjs';
import * as dagre from '@dagrejs/dagre';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult } from '../core/workbench-bridge.service';
import { resolveOption } from '../core/option-match';
import { GuideHighlightDirective } from '../core/guide-highlight.directive';
import { ToastService } from '../core/toast.service';

interface ScObject {
  objectName: string;
  className: string;
  description: string;
  isCustom: boolean;
}

interface ScAttribute {
  name: string;
  description: string;
  dataType: string;
  required: boolean;
  isCustom: boolean;
}

interface ScObjectDetail extends ScObject {
  attributes: ScAttribute[];
}

interface ErRelationship {
  from: string;
  to: string;
  fromAttr: string;
}

interface ErNode {
  objectName: string;
  attributes: ScAttribute[];
  totalAttributes: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// The diagram draws each table as a HEADER-ONLY node (no attribute rows) — the
// full attributes live in the detail pane, so repeating them in every box was
// what created the crossing-line mess. The header is deliberately large so the
// table name is easy to read in a big graph.
const NODE_W = 200;
const NODE_H = 56;
// Full (expanded) node metrics — used in the focus / "show related" view, where
// each box lists its attributes (the header-only overview uses NODE_H).
const NODE_H_BASE = 36;
const NODE_ROW_H = 18;
const MAX_ATTR_ROWS = 8;
const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;

@Component({
  selector: 'app-resources',
  standalone: true,
  imports: [CommonModule, FormsModule, GuideHighlightDirective],
  templateUrl: './resources.html',
  styleUrl: './resources.css',
})
export class ResourcesComponent implements OnInit, OnDestroy {
  /** The scroll/viewport element. Created lazily via *ngIf, so we bind the
   *  non-passive wheel listener through a ViewChild setter when it appears. */
  private erScrollEl: HTMLElement | null = null;
  @ViewChild('erScrollRef') set erScrollSetter(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement ?? null;
    if (el === this.erScrollEl) return;
    if (this.erScrollEl && this.wheelListener) {
      this.erScrollEl.removeEventListener('wheel', this.wheelListener);
    }
    this.erScrollEl = el;
    if (el) el.addEventListener('wheel', this.wheelListener, { passive: false });
  }
  @ViewChild('erSvgRef') erSvgRef!: ElementRef<SVGSVGElement>;
  @ViewChild('erPanelRef') erPanelRef!: ElementRef<HTMLElement>;

  objects: ScObject[] = [];
  /** Per-object row counts keyed by className; populated after the list loads. */
  counts: Record<string, CountResult> = {};
  selectedObject: ScObjectDetail | null = null;
  loadingList = true;
  loadingDetail = false;
  loadError = '';

  erNodes: ErNode[] = [];
  erEdges: ErRelationship[] = [];
  erReady = false;

  // ── Viewport (transform-based pan/zoom) ───────────────────────
  // The SVG fills the container (no scrollbars); pan/zoom is a single
  // translate()+scale() on the content group. This decouples panning from
  // content overflow, so dragging works in EVERY direction and zoom is
  // immediate — the old scroll-offset approach only panned where the content
  // happened to overflow, which is why left/right never worked.
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Whether the left object-list panel is collapsed to a slim rail (like cube/kpi). */
  listCollapsed = false;
  /** Related diagram is hidden by default; toggled from the detail header. When
   *  on, the detail pane and the diagram split the panel 50/50. */
  showDiagram = false;
  /** Detail pane's share of the panel height (%) when the diagram is shown; the
   *  diagram takes the rest. Driven by the draggable divider. Default 50/50. */
  splitRatio = 50;
  /** True while the divider is being dragged (drives the no-select overlay). */
  draggingSplitter = false;
  objectDescriptions = new Map<string, string>();
  /** Full detail (incl. attributes) of every object, loaded up front by buildEr —
   *  so the list-view UI context can expose each object's attributes without a click. */
  private detailsByName = new Map<string, ScObjectDetail>();

  // ── Add Custom Attribute modal ────────────────────────────────
  attrModalOpen = false;
  attrForm = { name: '', dataType: 'String', required: false, description: '' };
  attrSaving = false;
  attrSaveError = '';
  readonly dataTypes = ['String', 'Integer', 'Boolean', 'Numeric', 'DateTime', 'Date'];

  /** The exact ui_set_field paths the Add Custom OBJECT form accepts (an object
   *  plus its inline attribute rows). `.N.` means "any attribute index". */
  readonly OBJECT_SET_FIELD_PATHS = [
    'objectName', 'description',
    'attributes.N.name', 'attributes.N.dataType', 'attributes.N.required', 'attributes.N.description',
  ];
  /** The exact ui_set_field paths the Add Custom ATTRIBUTE form accepts. */
  readonly ATTRIBUTE_SET_FIELD_PATHS = ['name', 'dataType', 'required', 'description'];

  // ── Add Custom Object modal ───────────────────────────────────
  objModalOpen = false;
  objForm = { objectName: '', description: '' };
  objAttrs: { name: string; dataType: string; required: boolean; description: string }[] = [];
  objSaving = false;
  objSaveError = '';

  private draggingNode: ErNode | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private wasDragged = false;
  private svgEl: SVGSVGElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /**
   * Viewport wheel handler (bound to the scroll element by the ViewChild setter,
   * non-passive so we can preventDefault). PINCH (ctrl-wheel) zooms; plain
   * two-finger scroll pans — both just update transform state and re-render.
   */
  private wheelListener = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY / 100)));
      this.zoomAtCursor(factor, e);
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.cdr.markForCheck();
    }
  };

  // Pan-the-whole-diagram (drag on empty canvas) state — records the pointer and
  // the pan offset at press, then translates the viewport by the pointer delta.
  panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartPanX = 0;
  private panStartPanY = 0;

  // ── Visibility ────────────────────────────────────────────────

  get relatedNames(): Set<string> {
    if (!this.selectedObject) return new Set();
    const name = this.selectedObject.objectName;
    const s = new Set<string>([name]);
    this.erEdges.forEach(e => {
      if (e.from === name) s.add(e.to);
      if (e.to === name) s.add(e.from);
    });
    return s;
  }

  // The diagram ALWAYS shows just the selected object and its directly-related
  // objects (no full-graph / picker view). Empty until an object is selected.
  get visibleNodes(): ErNode[] {
    if (!this.selectedObject) return [];
    const rel = this.relatedNames;
    return this.erNodes.filter(n => rel.has(n.objectName));
  }

  get visibleEdges(): ErRelationship[] {
    if (!this.selectedObject) return [];
    // Only edges that touch the SELECTED object — we care about the hub↔neighbor
    // relationships, not links among the neighbors themselves.
    const name = this.selectedObject.objectName;
    return this.erEdges.filter(e => e.from === name || e.to === name);
  }

  // ── Display getters ───────────────────────────────────────────

  /** The viewport transform applied to the content group: pan then scale. */
  get erTransform(): string { return `translate(${this.panX} ${this.panY}) scale(${this.zoom})`; }
  get zoomPct(): string { return Math.round(this.zoom * 100) + '%'; }
  get isDragging(): boolean { return this.draggingNode !== null; }
  get edgeStrokeWidth(): number { return +(1.5 / this.zoom).toFixed(2); }
  get nodeStrokeWidth(): number { return +(1.5 / this.zoom).toFixed(2); }
  get selectedStrokeWidth(): number { return +(2.5 / this.zoom).toFixed(2); }

  objectTooltip(obj: ScObject): string {
    // Show the object's underlying IRIS class name on hover (not its description).
    return obj.className || obj.objectName;
  }

  /** Record-count token for the detail header, e.g. "(128)". Empty while loading
   *  or if the count is unavailable, so the header just shows name + class. */
  countLabel(obj: ScObject): string {
    const c = this.counts[obj.className];
    return c?.ok ? `(${c.total})` : '';
  }

  isSelected(node: ErNode): boolean {
    return this.selectedObject?.objectName === node.objectName;
  }

  isRelated(node: ErNode): boolean {
    if (!this.selectedObject) return false;
    return this.relatedNames.has(node.objectName) && !this.isSelected(node);
  }

  /** Field path currently highlighted by Guided mode (bound in the template). */
  highlightPath: string | null = null;

  constructor(
    private scModel: ScModelService,
    private cdr: ChangeDetectorRef,
    private bridge: WorkbenchBridgeService,
    private toasts: ToastService,
    private dataBrowser: DataBrowserService,
  ) {}

  /**
   * Controller the assistant (Guided mode) uses to drive the Data Model forms.
   * `openNewForm` opens the Add Custom Attribute form when an object is selected
   * (so the assistant can add to it), otherwise the Add Custom Object form —
   * matching how the two "+"/pencil buttons behave for the user.
   */
  private readonly guidedController: GuidedFormController = {
    feature: 'data-model',
    openNewForm: (opts) => this.openGuidedForm(opts),
    openEntity: (name, opts) => this.guidedOpenEntity(name, opts),
    setField: (path, value) => this.guidedSetField(path, value),
    highlight: (target) => {
      this.highlightPath = target;
      this.cdr.markForCheck();
    },
    snapshot: () => this.formSnapshot(),
    whenListReady: () => this.listReady,
    // Deep link: which object is on screen, and how to get back to it on reload.
    currentItem: () => this.selectedObject?.objectName ?? null,
    restoreItem: (name) => this.restoreObject(name),
  };

  /**
   * Re-select the object `?item=` names after a page reload, once the object list has
   * arrived. False when no object by that name exists any more (a stale bookmark),
   * which leaves the page on its overview — silently, since the user didn't do
   * anything wrong. Selecting is enough: an object's "detail" IS its selection.
   */
  private async restoreObject(name: string): Promise<boolean> {
    const list = await this.objectsReady();
    const found = list.find(o => o.objectName === name);
    if (!found) return false;
    await this.selectObjectAsync(found);
    this.cdr.markForCheck();
    return true;
  }

  /** Resolves once the object list AND every object's detail (buildEr) have loaded,
   *  so a guided navigate can hand the full list — with attributes — back in the
   *  same turn. */
  private resolveListReady!: () => void;
  private listReady = new Promise<void>((res) => { this.resolveListReady = res; });

  ngOnInit(): void {
    // Expose this feature to the assistant's Guided mode.
    this.bridge.register(this.guidedController);
    this.scModel.getObjects().subscribe({
      next: objs => {
        this.objects = objs;
        this.loadingList = false;
        this.buildEr(objs);
        if (objs.length) {
          this.dataBrowser.getCounts(objs.map(o => o.className)).subscribe(c => {
            this.counts = c;
            this.cdr.markForCheck();
          });
        }
      },
      error: (err) => { this.loadingList = false; this.loadError = err?.message || err?.status || JSON.stringify(err); },
    });
  }

  ngAfterViewInit(): void {
    // Re-fit the diagram whenever its container resizes (e.g. the docked AI
    // Assistant opens/closes and narrows this panel), so it never overflows into
    // the neighboring panel and always shows the whole related subgraph.
    if (typeof ResizeObserver !== 'undefined' && this.erPanelRef?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.erReady && this.selectedObject) this.fitToView();
      });
      this.resizeObserver.observe(this.erPanelRef.nativeElement);
    }
  }


  /**
   * Zoom by `factor`, keeping the diagram point under the cursor fixed on screen.
   * With a transform viewport this is exact: solve for the pan offset that leaves
   * the cursor's content-point stationary after scaling. Used by wheel + buttons.
   */
  private zoomAtCursor(factor: number, e?: { clientX: number; clientY: number }): void {
    const prev = this.zoom;
    const next = parseFloat(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * factor)).toFixed(3));
    if (next === prev) return;

    const host = this.erScrollEl;
    // Anchor point in viewport pixels (cursor for wheel, container center for buttons).
    let ax: number, ay: number;
    if (e && host) {
      const rect = host.getBoundingClientRect();
      ax = e.clientX - rect.left;
      ay = e.clientY - rect.top;
    } else if (host) {
      ax = host.clientWidth / 2;
      ay = host.clientHeight / 2;
    } else {
      ax = 0; ay = 0;
    }
    // Keep the content point under the anchor fixed: p = (a - pan)/zoom must be
    // unchanged, so pan' = a - p*next.
    const px = (ax - this.panX) / prev;
    const py = (ay - this.panY) / prev;
    this.zoom = next;
    this.panX = ax - px * next;
    this.panY = ay - py * next;
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.bridge.unregister(this.guidedController);
    this.erScrollEl?.removeEventListener('wheel', this.wheelListener);
    this.resizeObserver?.disconnect();
  }

  // ── Guided-mode co-pilot (assistant drives the Data Model forms) ──

  /**
   * Open the form Guided mode should co-pilot: the Add Custom Attribute form when
   * an object is selected (so the assistant adds to it), otherwise the Add Custom
   * Object form. Mirrors the two entry points the user has (the list "+" and the
   * detail-header pencil).
   */
  /**
   * Open a create form for Guided mode. `formKind` (from the agent's ui_open_form)
   * chooses which: "attribute" opens the Add Custom Attribute form for the
   * selected object; "object" (the DEFAULT) opens the Add Custom Object form.
   *
   * Defaulting to the OBJECT form matters: "create a new object" while an object
   * is selected must NOT open the attribute form (the old bug — it inferred the
   * form purely from `selectedObject`, so a new-object request popped the
   * attribute modal first, then the object modal over it). The attribute form is
   * opened only on an explicit `formKind: "attribute"`, and only if an object is
   * selected (otherwise there's nothing to add an attribute to → object form).
   */
  private openGuidedForm(opts?: { formKind?: string }): void {
    if (opts?.formKind === 'attribute' && this.selectedObject) this.openAttrModal();
    else this.openObjModal();
    this.cdr.markForCheck();
  }

  /**
   * Guided mode: land on an EXISTING object by name — select it (so the assistant
   * can add attributes to it even if the user is elsewhere), and when
   * `formKind === 'attribute'` open its Add Custom Attribute form. Lets the
   * assistant navigate the user to, say, "Employee" itself rather than telling
   * them to click it. Fails clearly if no object by that name exists.
   */
  private async guidedOpenEntity(name: string, opts?: { formKind?: string; mode?: 'view' | 'edit' }): Promise<SetFieldResult> {
    const target = name.trim();
    // The objects list loads in ngOnInit; wait briefly if it isn't ready yet.
    const list = await this.objectsReady();
    const found = list.find(o => o.objectName === target);
    if (!found) {
      return { applied: false, detail: `No object named "${target}" exists. Existing objects: ${list.map(o => o.objectName).join(', ') || '(none)'}.` };
    }
    await this.selectObjectAsync(found);
    // Open the Add Custom Attribute form only when explicitly asked (formKind), or
    // when the intent is to edit; a plain "view" just selects the object so its
    // detail is shown. (Objects have no separate edit form — attributes are how you
    // extend one.)
    const openAttr = opts?.formKind === 'attribute';
    if (openAttr) this.openAttrModal();
    this.cdr.markForCheck();
    return { applied: true, detail: `Selected "${target}"${openAttr ? ' and opened its Add Custom Attribute form' : ''}.` };
  }

  /** Resolve the loaded objects list, waiting out the ngOnInit fetch if needed. */
  private objectsReady(): Promise<ScObject[]> {
    if (!this.loadingList) return Promise.resolve(this.objects);
    return new Promise((resolve) => {
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += 30;
        if (!this.loadingList || elapsed >= 2000) {
          clearInterval(timer);
          resolve(this.objects);
        }
      }, 30);
    });
  }

  /** selectObject, but resolves once the object's detail has loaded (or fails). */
  private selectObjectAsync(obj: ScObject): Promise<void> {
    this.selectObject(obj);
    return new Promise((resolve) => {
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += 30;
        if (!this.loadingDetail || elapsed >= 2000) {
          clearInterval(timer);
          resolve();
        }
      }, 30);
    });
  }

  /**
   * Set one Data Model form field by dotted path on behalf of Guided mode,
   * opening the right form first and creating attribute rows as needed. Returns
   * whether the value actually LANDED — `dataType` is dropdown-backed, so an
   * off-list value is rejected with a detail message rather than a blind success
   * (the assistant is told the truth).
   *
   * Supported paths:
   *   Object form:    objectName · description ·
   *                   attributes.N.name|dataType|required|description
   *   Attribute form: name · dataType · required · description
   */
  private guidedSetField(path: string, value: unknown): SetFieldResult {
    const parts = path.split('.');
    const head = parts[0]!;
    try {
      // A field can only be set on an OPEN form. If neither create modal is open,
      // FAIL rather than silently (re)opening one (SC-2681). The old behavior
      // implicitly re-opened a fresh form on set_field — so after the user clicked
      // Cancel mid-generation, the next set_field popped a blank form back up,
      // dropping the already-generated fields. The form must be opened explicitly
      // via ui_open_form; a stray set_field with no form open is a real error the
      // agent should see. (This also closes the SC-2680 vector where a set_field
      // before ui_open_form could open the wrong form.)
      if (!this.objModalOpen && !this.attrModalOpen) {
        return { applied: false, detail: 'No Data Model form is open. Call ui_open_form before setting fields.' };
      }
      // `objectName` and `attributes.*` are object-form ONLY.
      const objectOnly = head === 'objectName' || head === 'attributes';
      if (objectOnly) {
        if (!this.objModalOpen) {
          return { applied: false, detail: `Field "${path}" belongs to the Add Custom Object form, which is not open.` };
        }
        return this.setObjField(head, parts, value);
      }
      // `description` exists in BOTH forms; `name`/`dataType`/`required` are
      // attribute fields. Route by whichever form is already open.
      if (this.attrModalOpen) return this.setAttrField(head, value);
      // The Object form is open (guaranteed by the guard above). `description` sets
      // the object description.
      if (head === 'description') return this.setObjScalar(head, value);
      // A BARE `name`/`dataType`/`required` on the OBJECT form is almost always a
      // mis-mapping — most often the object's name sent as `name` instead of
      // `objectName`, which used to land silently in attribute row 0 (so "an object
      // called abc" became an attribute named abc). Reject it with a corrective
      // message so the assistant uses the right path, rather than guessing a home.
      if (head === 'name') {
        return {
          applied: false,
          detail: 'The object form has no bare "name" field. Use "objectName" for the object\'s name, or "attributes.N.name" for the Nth attribute\'s name.',
        };
      }
      return {
        applied: false,
        detail: `The object form has no bare "${head}" field. For an attribute use "attributes.N.${head}" (e.g. "attributes.0.${head}").`,
      };
    } catch {
      return { applied: false, detail: `Unknown or unsupported field path "${path}".` };
    }
  }

  /** Assign a field on the Add Custom Object form (objectName/description/attributes.N.*). */
  private setObjField(head: string, parts: string[], value: unknown): SetFieldResult {
    if (head === 'attributes') {
      const i = Number(parts[1]);
      if (!Number.isInteger(i) || i < 0) return { applied: false, detail: `Invalid attribute index in "${parts.join('.')}".` };
      while (this.objAttrs.length <= i) this.addObjAttrRow();
      return this.setAttrRowField(this.objAttrs[i]!, parts[2]!, value);
    }
    return this.setObjScalar(head, value);
  }

  /** Assign objectName/description on the object form. */
  private setObjScalar(field: string, value: unknown): SetFieldResult {
    if (field === 'objectName' || field === 'description') {
      this.objForm = { ...this.objForm, [field]: String(value) };
      this.cdr.markForCheck();
      return { applied: true };
    }
    return { applied: false, detail: `"${field}" is not a field of the Add Custom Object form.` };
  }

  /** Assign a field on ONE attribute row (shared by both forms), validating dataType. */
  private setAttrRowField(
    row: { name: string; dataType: string; required: boolean; description: string },
    field: string,
    value: unknown,
  ): SetFieldResult {
    switch (field) {
      case 'name':
      case 'description':
        row[field] = String(value);
        break;
      case 'required':
        row.required = value === true || String(value).toLowerCase() === 'true';
        break;
      case 'dataType': {
        const res = this.matchDataType(value);
        if (!res) return { applied: false, detail: `"${value}" is not a valid data type. Choose one of: ${this.dataTypes.join(', ')}.` };
        row.dataType = res;
        break;
      }
      default:
        return { applied: false, detail: `"${field}" is not an attribute field.` };
    }
    this.cdr.markForCheck();
    return { applied: true };
  }

  /** Assign a field on the Add Custom Attribute form, validating dataType. */
  private setAttrField(field: string, value: unknown): SetFieldResult {
    if (field === 'name' || field === 'description') {
      this.attrForm = { ...this.attrForm, [field]: String(value) };
      this.cdr.markForCheck();
      return { applied: true };
    }
    if (field === 'required') {
      this.attrForm = { ...this.attrForm, required: value === true || String(value).toLowerCase() === 'true' };
      this.cdr.markForCheck();
      return { applied: true };
    }
    if (field === 'dataType') {
      const res = this.matchDataType(value);
      if (!res) return { applied: false, detail: `"${value}" is not a valid data type. Choose one of: ${this.dataTypes.join(', ')}.` };
      this.attrForm = { ...this.attrForm, dataType: res };
      this.cdr.markForCheck();
      return { applied: true };
    }
    return { applied: false, detail: `"${field}" is not a field of the Add Custom Attribute form.` };
  }

  /**
   * Match a data type to one of the offered options, tolerating a plain/partial
   * term ("int" → Integer, "datetime" → DateTime) rather than demanding an exact
   * string. An exact case-insensitive hit (e.g. "date" → Date) wins over any
   * fuzzy overlap, so "Date" is never mistaken for "DateTime". Returns null when
   * nothing is close enough or several options are equally plausible (the caller
   * then lists the real options).
   */
  private matchDataType(value: unknown): string | null {
    const res = resolveOption(String(value), this.dataTypes);
    return res.status === 'matched' ? res.value : null;
  }

  /**
   * Field map for the assistant's UI-context block: which form (if any) is open
   * with every field value, else the selected object's definition, else the list
   * state — so the assistant can answer specifically about what's on screen.
   */
  private formSnapshot(): Record<string, unknown> {
    if (this.objModalOpen) {
      return {
        mode: 'creating new custom object',
        formKind: 'object',
        // The exact ui_set_field paths this form accepts — fill ONLY these; the
        // object's own name is "objectName" (NOT a bare "name").
        validFieldPaths: this.OBJECT_SET_FIELD_PATHS,
        objectName: this.objForm.objectName,
        description: this.objForm.description,
        attributes: this.objAttrs.map((a) => ({
          name: a.name, dataType: a.dataType, required: a.required, description: a.description,
        })),
        availableDataTypes: this.dataTypes,
      };
    }
    if (this.attrModalOpen) {
      return {
        mode: 'adding custom attribute',
        formKind: 'attribute',
        // The exact ui_set_field paths this form accepts — fill ONLY these.
        validFieldPaths: this.ATTRIBUTE_SET_FIELD_PATHS,
        onObject: this.selectedObject?.objectName ?? '',
        name: this.attrForm.name,
        dataType: this.attrForm.dataType,
        required: this.attrForm.required,
        description: this.attrForm.description,
        availableDataTypes: this.dataTypes,
      };
    }
    if (this.selectedObject) {
      const o = this.selectedObject;
      return {
        mode: 'viewing object detail',
        selectedObject: o.objectName,
        className: o.className,
        description: o.description,
        isCustom: o.isCustom,
        attributes: (o.attributes || []).map((a) => ({
          name: a.name, dataType: a.dataType, required: a.required, isCustom: a.isCustom, description: a.description,
        })),
        relatedObjects: [...this.relatedNames].filter((n) => n !== o.objectName),
      };
    }
    // List view: no object selected, but the user may ask about ANY listed object
    // — surface the FULL detail of every one, including its attributes. buildEr
    // already fetched every object's detail into detailsByName, so we don't need a
    // per-object click. (Falls back to the list-level fields until details land.)
    const objects = this.objects.map((o) => {
      const d = this.detailsByName.get(o.objectName);
      return {
        objectName: o.objectName,
        className: o.className,
        isCustom: o.isCustom,
        description: d?.description ?? o.description ?? '',
        attributes: (d?.attributes ?? []).map((a) => ({
          name: a.name,
          dataType: a.dataType,
          required: a.required,
          isCustom: a.isCustom,
          description: a.description,
        })),
      };
    });
    return { mode: 'data model list (no object selected)', objectCount: objects.length, objects };
  }

  // ── Zoom ──────────────────────────────────────────────────────

  /**
   * Fit the whole diagram into the viewport: compute the content bounds, pick
   * the zoom that makes it fit (with padding, capped at 100%), and center it.
   * This is what makes the diagram open showing ALL objects without manual
   * zoom-out, and what the reset (↺) button restores.
   */
  fitToView(): void {
    const host = this.erScrollEl;
    if (!host || this.erNodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.visibleNodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + this.nodeHeight(n));
    }
    if (!isFinite(minX)) return;
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const PAD = 40;
    const vw = host.clientWidth, vh = host.clientHeight;
    const fit = Math.min((vw - PAD * 2) / contentW, (vh - PAD * 2) / contentH);
    const z = parseFloat(Math.min(1, Math.max(ZOOM_MIN, fit)).toFixed(3));
    this.zoom = z;
    // Center the content in the viewport.
    this.panX = (vw - contentW * z) / 2 - minX * z;
    this.panY = (vh - contentH * z) / 2 - minY * z;
    this.cdr.markForCheck();
  }

  zoomIn(): void { this.zoomAtCursor(1 + ZOOM_STEP); }
  zoomOut(): void { this.zoomAtCursor(1 - ZOOM_STEP); }
  /** Reset re-fits the whole diagram to the viewport (see fitToView). */
  resetZoom(): void { this.fitToView(); }

  // ── Drag ──────────────────────────────────────────────────────

  onNodeMouseDown(event: MouseEvent, node: ErNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.svgEl = (event.target as Element).closest('svg') as SVGSVGElement;
    const r = this.svgEl.getBoundingClientRect();
    this.draggingNode = node;
    this.wasDragged = false;
    // Content coords = (pointerPx − pan) / zoom  (the group is translated+scaled).
    this.dragOffsetX = (event.clientX - r.left - this.panX) / this.zoom - node.x;
    this.dragOffsetY = (event.clientY - r.top - this.panY) / this.zoom - node.y;
  }

  /**
   * Start panning the whole diagram when the user presses on empty canvas. Node/
   * edge mousedowns call stopPropagation, so anything here is whitespace. We pan
   * by translating the viewport (panX/panY) by the pointer delta — works in every
   * direction regardless of content size.
   */
  onBackgroundMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return; // left button only
    event.preventDefault();
    this.panning = true;
    this.panStartX = event.clientX;
    this.panStartY = event.clientY;
    this.panStartPanX = this.panX;
    this.panStartPanY = this.panY;
  }

  /**
   * Begin dragging the divider between the detail pane and the ER diagram. The
   * subsequent mousemoves recompute `splitRatio` from the pointer's Y within the
   * right panel; mouseup ends the drag (and re-fits the diagram to its new size).
   */
  onSplitterMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return; // left button only
    event.preventDefault();
    event.stopPropagation();
    this.draggingSplitter = true;
  }

  /** Min/max detail-pane share (%) so neither area collapses to nothing. */
  private static readonly SPLIT_MIN = 15;
  private static readonly SPLIT_MAX = 85;

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.draggingSplitter) {
      const panel = this.erPanelRef?.nativeElement;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = ((event.clientY - rect.top) / rect.height) * 100;
      this.splitRatio = Math.min(
        ResourcesComponent.SPLIT_MAX,
        Math.max(ResourcesComponent.SPLIT_MIN, pct),
      );
      this.cdr.markForCheck();
      return;
    }
    if (this.panning) {
      // Translate the viewport by the pointer delta (drag right → content right).
      this.panX = this.panStartPanX + (event.clientX - this.panStartX);
      this.panY = this.panStartPanY + (event.clientY - this.panStartY);
      this.cdr.markForCheck();
      return;
    }
    if (!this.draggingNode || !this.svgEl) return;
    this.wasDragged = true;
    const r = this.svgEl.getBoundingClientRect();
    this.draggingNode.x = (event.clientX - r.left - this.panX) / this.zoom - this.dragOffsetX;
    this.draggingNode.y = (event.clientY - r.top - this.panY) / this.zoom - this.dragOffsetY;
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (this.draggingSplitter) {
      this.draggingSplitter = false;
      // Re-fit the diagram to its new height (deferred so the new layout is applied).
      if (this.erReady && this.selectedObject) setTimeout(() => this.fitToView());
    }
    this.panning = false;
    if (this.draggingNode && !this.wasDragged) {
      this.selectObject({ objectName: this.draggingNode.objectName, className: '', description: '', isCustom: false });
    }
    this.draggingNode = null;
    this.svgEl = null;
  }

  // ── Selection ─────────────────────────────────────────────────

  /**
   * Select an object: load its detail, then show the related diagram focused on
   * it (just this object and its directly-related objects).
   */
  selectObject(obj: ScObject): void {
    if (this.selectedObject?.objectName === obj.objectName) return;
    this.loadingDetail = true;
    this.selectedObject = null;
    this.scModel.getObjectDetail(obj.objectName).subscribe({
      next: detail => {
        this.selectedObject = detail;
        this.loadingDetail = false;
        // Lay out the diagram only if it's currently shown (node sizes depend on
        // the loaded detail); toggling it on later triggers the layout too.
        if (this.showDiagram) setTimeout(() => this.applyFocusLayout(obj.objectName));
      },
      error: () => { this.loadingDetail = false; },
    });
  }

  toggleList(): void { this.listCollapsed = !this.listCollapsed; }

  /** Show/hide the related diagram. When shown, lay it out + fit it once it renders. */
  toggleDiagram(): void {
    this.showDiagram = !this.showDiagram;
    this.cdr.markForCheck();
    if (this.showDiagram && this.selectedObject) {
      setTimeout(() => this.applyFocusLayout(this.selectedObject!.objectName));
    }
  }

  openAttrModal(): void {
    this.objModalOpen = false; // never stack the two create modals
    this.attrForm = { name: '', dataType: 'String', required: false, description: '' };
    this.attrSaveError = '';
    this.attrModalOpen = true;
  }

  closeAttrModal(): void { this.attrModalOpen = false; }

  saveAttr(): void {
    if (!this.selectedObject || !this.attrForm.name.trim()) return;
    this.attrSaving = true;
    this.attrSaveError = '';
    const body = {
      name: this.attrForm.name.trim(),
      dataType: this.attrForm.dataType,
      required: this.attrForm.required ? 1 : 0,
      description: this.attrForm.description.trim(),
    };
    const objectName = this.selectedObject.objectName;
    const attrName = body.name;
    this.scModel.addAttribute(objectName, body).subscribe({
      next: () => {
        this.attrSaving = false;
        this.attrModalOpen = false;
        this.toasts.success(`Attribute “${attrName}” added to ${objectName}.`);
        // Reload detail to pick up the new attribute
        this.scModel.getObjectDetail(objectName).subscribe({
          next: detail => { this.selectedObject = detail; this.cdr.markForCheck(); },
        });
      },
      error: (err) => {
        this.attrSaving = false;
        this.attrSaveError = this.irisErrorMessage(err, 'Save failed');
        this.toasts.error(this.attrSaveError);
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * Extract a human-readable message from an scmodel API error. The SCO APIs
   * return `{"Status":"Error","Message":"..."}` (capital M) with an HTTP 400 on
   * validation failures (duplicate/invalid attribute name, object already
   * exists, …). Angular's HttpErrorResponse parses that JSON into `err.error`,
   * so we must read the capital-M `Message` — the earlier `err.error.message`
   * (lowercase) never matched, which is why the UI showed a bare "400 Bad
   * Request" instead of IRIS's real reason. Fall back through the usual shapes.
   */
  private irisErrorMessage(err: any, fallback: string): string {
    return (
      err?.error?.Message ||
      err?.error?.message ||
      err?.error?.Status ||
      err?.message ||
      fallback
    );
  }

  openObjModal(): void {
    this.attrModalOpen = false; // never stack the two create modals
    this.objForm = { objectName: '', description: '' };
    this.objAttrs = [{ name: '', dataType: 'String', required: false, description: '' }];
    this.objSaveError = '';
    this.objModalOpen = true;
  }

  closeObjModal(): void { this.objModalOpen = false; }

  addObjAttrRow(): void {
    this.objAttrs.push({ name: '', dataType: 'String', required: false, description: '' });
  }

  removeObjAttrRow(index: number): void {
    if (this.objAttrs.length > 1) this.objAttrs.splice(index, 1);
  }

  saveObj(): void {
    if (!this.objForm.objectName.trim() || this.objAttrs.some(a => !a.name.trim())) return;
    this.objSaving = true;
    this.objSaveError = '';
    const body = {
      objectName: this.objForm.objectName.trim(),
      description: this.objForm.description.trim(),
      attributes: this.objAttrs.map(a => ({
        name: a.name.trim(),
        dataType: a.dataType,
        required: a.required ? 1 : 0,
        description: a.description.trim(),
      })),
    };
    const objectName = body.objectName;
    this.scModel.createObject(body).subscribe({
      next: () => {
        this.objSaving = false;
        this.objModalOpen = false;
        this.toasts.success(`Object “${objectName}” created.`);
        // Reload the full object list and ER diagram
        this.scModel.getObjects().subscribe({
          next: objs => {
            this.objects = objs;
            this.buildEr(objs);
            this.cdr.markForCheck();
          },
        });
      },
      error: (err) => {
        this.objSaving = false;
        this.objSaveError = this.irisErrorMessage(err, 'Save failed');
        this.toasts.error(this.objSaveError);
        this.cdr.markForCheck();
      },
    });
  }

  /** Clicking a list row selects the object (same as clicking its node). */
  onListItemClick(obj: ScObject): void {
    this.selectObject(obj);
  }

  /**
   * Lay the focus subgraph out to FILL the viewport: the selected object on the
   * left, its related objects arranged in a GRID to the right whose column count
   * matches the viewport's (wide, short) aspect ratio. A single column made a
   * tall, narrow shape that fit-to-view shrank to ~20%; a grid spreads the
   * neighbors across the available width instead. Then fit it to the viewport.
   */
  private applyFocusLayout(centerName: string): void {
    const relNames = this.relatedNames; // includes center
    const related = [...relNames].filter(n => n !== centerName);
    const centerNode = this.getNodeByName(centerName);
    if (!centerNode) return;

    const COL_GAP = 70;
    const ROW_GAP = 30;
    const relNodes = related.map(n => this.getNodeByName(n)).filter((n): n is ErNode => !!n);

    if (relNodes.length === 0) {
      centerNode.x = 0;
      centerNode.y = 0;
      this.cdr.markForCheck();
      setTimeout(() => this.fitToView());
      return;
    }

    // Choose columns so the neighbor grid roughly matches the viewport aspect,
    // i.e. cols/rows ≈ (W/H)·(nodeH/nodeW). Derived from cols·rows = N.
    const host = this.erScrollEl;
    const aspect = host && host.clientHeight ? host.clientWidth / host.clientHeight : 2.2;
    const avgW = relNodes.reduce((s, n) => s + n.width, 0) / relNodes.length;
    const avgH = relNodes.reduce((s, n) => s + this.nodeHeight(n), 0) / relNodes.length;
    let cols = Math.round(Math.sqrt(relNodes.length * aspect * (avgH / avgW)));
    cols = Math.max(1, Math.min(cols, relNodes.length));
    const rows = Math.ceil(relNodes.length / cols);

    // Nodes vary in size, so size each column by its widest node and each row by
    // its tallest, then compute cumulative offsets.
    const colW = new Array(cols).fill(0);
    const rowH = new Array(rows).fill(0);
    relNodes.forEach((node, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      colW[c] = Math.max(colW[c], node.width);
      rowH[r] = Math.max(rowH[r], this.nodeHeight(node));
    });
    const colX: number[] = [];
    let ax = 0;
    for (let c = 0; c < cols; c++) { colX[c] = ax; ax += colW[c] + COL_GAP; }
    const rowY: number[] = [];
    let ay = 0;
    for (let r = 0; r < rows; r++) { rowY[r] = ay; ay += rowH[r] + ROW_GAP; }
    const gridH = ay - ROW_GAP;

    // Hub on the left, grid on the right; the shorter one centered against the taller.
    const totalH = Math.max(this.nodeHeight(centerNode), gridH);
    centerNode.x = 0;
    centerNode.y = (totalH - this.nodeHeight(centerNode)) / 2;

    const gridX0 = centerNode.width + COL_GAP;
    const gridY0 = (totalH - gridH) / 2;
    relNodes.forEach((node, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      node.x = gridX0 + colX[c];
      node.y = gridY0 + rowY[r];
    });

    // Fit the focused subgraph into the viewport (needs a rendered frame).
    this.cdr.markForCheck();
    setTimeout(() => this.fitToView());
  }

  // ── ER build & layout ─────────────────────────────────────────

  private buildEr(objs: ScObject[]): void {
    // No objects → the list is trivially "ready" (forkJoin of [] wouldn't emit).
    if (!objs.length) { this.detailsByName = new Map(); this.resolveListReady(); return; }
    const allNames = new Set(objs.map(o => o.objectName));
    forkJoin(objs.map(o => this.scModel.getObjectDetail(o.objectName))).subscribe({
      next: details => {
        const edges: ErRelationship[] = [];
        const fkRegex = /foreign key to (\w+)/i;
        details.forEach(d => {
          (d.attributes || []).forEach((a: ScAttribute) => {
            const m = fkRegex.exec(a.description || '');
            if (m && allNames.has(m[1]) && m[1] !== d.objectName) {
              edges.push({ from: d.objectName, to: m[1], fromAttr: a.name });
            }
          });
        });
        this.erEdges = edges;
        details.forEach(d => { if (d.description) this.objectDescriptions.set(d.objectName, d.description); });
        // Retain full details so the list-view snapshot can expose every object's
        // attributes (buildEr already fetched them all for the ER diagram).
        this.detailsByName = new Map(details.map(d => [d.objectName, d]));
        this.resolveListReady(); // list + attributes populated (idempotent after first)
        this.layoutNodes(details);
      },
      // Settle even if a detail fetch fails, so a guided navigate doesn't hang.
      error: () => this.resolveListReady(),
    });
  }

  private layoutNodes(details: ScObjectDetail[]): void {
    const nodes: ErNode[] = details.map((d) => {
      const attributes = (d.attributes || []).slice(0, MAX_ATTR_ROWS);
      return {
        objectName: d.objectName,
        attributes,
        totalAttributes: (d.attributes || []).length,
        x: 0,
        y: 0,
        // Width fits the widest content — the table name AND (for the focus view)
        // the longest "attr : Type" row — so nothing overflows the box.
        width: this.nodeWidthFor(d.objectName, attributes),
        height: NODE_H,
      };
    });
    this.erNodes = nodes;

    // Auto-layout with dagre (layered / crossing-minimizing) to seed positions;
    // the diagram then re-lays-out radially around whichever object is selected.
    this.applyDagreLayout();
    this.erReady = true;
    this.cdr.markForCheck();
  }

  /**
   * Run dagre over the current nodes + FK edges to assign crossing-minimized
   * positions, then write the results (converted from dagre's node CENTERS to
   * our top-left ErNode.x/y) and recompute the SVG bounds. Left→right rank
   * direction suits an ER graph (parents flow into children).
   */
  private applyDagreLayout(): void {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 30, marginy: 30 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of this.erNodes) {
      g.setNode(n.objectName, { width: n.width, height: n.height });
    }
    // Only edges between laid-out nodes; dedupe so parallel FKs don't over-weight.
    const seen = new Set<string>();
    for (const e of this.erEdges) {
      const key = `${e.from}->${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
    }

    dagre.layout(g);

    for (const n of this.erNodes) {
      const pos = g.node(n.objectName) as { x: number; y: number } | undefined;
      if (pos) {
        // dagre gives the node center; our model uses the top-left corner.
        n.x = pos.x - n.width / 2;
        n.y = pos.y - n.height / 2;
      }
    }
  }

  // ── SVG helpers ───────────────────────────────────────────────

  getNodeByName(name: string): ErNode | undefined {
    return this.erNodes.find(n => n.objectName === name);
  }

  /**
   * Node box width sized to fit the widest content so nothing overflows:
   *  - the header label (~8.5px/char at the 15px header font, + padding), and
   *  - the longest "attr : Type" row (~6px/char at the 9.5px mono font, + padding),
   *    which matters in the focus view where attributes are shown.
   * Clamped to a readable min/max.
   */
  private nodeWidthFor(name: string, attributes: ScAttribute[] = []): number {
    const headerW = name.length * 8.5 + 36;
    let attrW = 0;
    for (const a of attributes) {
      attrW = Math.max(attrW, `${a.name} : ${a.dataType}`.length * 6 + 24);
    }
    return Math.round(Math.min(360, Math.max(NODE_W, headerW, attrW)));
  }

  /** Are we in the "show related" focus view (full attributes shown)? */
  /** The diagram is always the related/focus view, so it's expanded (full
   *  attributes) whenever an object is selected. */
  get expandedView(): boolean { return !!this.selectedObject; }

  /** Rendered node height: full attribute box in the focus view, else the
   *  compact header-only box in the whole-graph overview. */
  nodeHeight(node: ErNode): number {
    if (!this.expandedView) return NODE_H;
    const rows = Math.min(node.totalAttributes, MAX_ATTR_ROWS);
    const hasMore = node.totalAttributes > rows;
    return NODE_H_BASE + rows * NODE_ROW_H + (hasMore ? NODE_ROW_H : 0);
  }

  /**
   * A smooth curve between two node boxes. The endpoints attach to the side of
   * each box that faces the other node — bottom↔top when the relationship is
   * mostly vertical, right↔left when mostly horizontal — and the bezier control
   * points extend straight out of that side. This avoids the "hook"/curl the old
   * always-horizontal routing produced when one node sat directly above another.
   */
  edgePath(edge: ErRelationship): string {
    const from = this.getNodeByName(edge.from);
    const to = this.getNodeByName(edge.to);
    if (!from || !to) return '';
    const fromH = this.nodeHeight(from);
    const toH = this.nodeHeight(to);
    const fcx = from.x + from.width / 2;
    const fcy = from.y + fromH / 2;
    const tcx = to.x + to.width / 2;
    const tcy = to.y + toH / 2;

    const dx = tcx - fcx;
    const dy = tcy - fcy;

    if (Math.abs(dx) >= Math.abs(dy)) {
      // Mostly horizontal → exit right/left, curve horizontally.
      const x1 = dx >= 0 ? from.x + from.width : from.x;
      const x2 = dx >= 0 ? to.x : to.x + to.width;
      const c = Math.max(Math.abs(x2 - x1) / 2, 40);
      const s = dx >= 0 ? 1 : -1;
      return `M ${x1} ${fcy} C ${x1 + s * c} ${fcy}, ${x2 - s * c} ${tcy}, ${x2} ${tcy}`;
    }
    // Mostly vertical → exit bottom/top, curve vertically.
    const y1 = dy >= 0 ? from.y + fromH : from.y;
    const y2 = dy >= 0 ? to.y : to.y + toH;
    const c = Math.max(Math.abs(y2 - y1) / 2, 40);
    const s = dy >= 0 ? 1 : -1;
    return `M ${fcx} ${y1} C ${fcx} ${y1 + s * c}, ${tcx} ${y2 - s * c}, ${tcx} ${y2}`;
  }

  typeColor(dataType: string): string {
    switch (dataType) {
      case 'String':   return '#0066cc';
      case 'DateTime': return '#7b2d8b';
      case 'Numeric':  return '#2e7d32';
      case 'Boolean':  return '#b45e00';
      default:         return '#666';
    }
  }

}
