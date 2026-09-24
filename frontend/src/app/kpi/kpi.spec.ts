import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { KpiComponent, KNOWN_KPI_SCALAR_PATHS } from './kpi';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult } from '../core/workbench-bridge.service';
import { KpiApiService } from '../services/kpi.service';
import { CubeService } from '../services/cube.service';
import { KpiGroupService, UNGROUPED } from '../services/kpi-group.service';
import { ToastService } from '../core/toast.service';
import { KpiHealthService } from '../dashboard/services/kpi-health.service';
import { DashboardChartService, type CubeShape } from '../dashboard/services/dashboard-chart.service';
import { styleScopeFree } from '../shared/test-markup';

/**
 * I1 (SC-2666): KPI cube metadata now comes from the ONE shared `DashboardChartService.getCubeShape`
 * port, not the dead `CubeInfoService`. This multi-level fixture (product has TWO levels) is the one
 * that catches a per-level→per-dimension collapse (I1-SPEC-02): a single-level `[status]` shape would
 * mask it. The C16 tripwire pins (kpiMeasure/cubeDimension off-list rejection) validate against these
 * shape-sourced lists byte-compatibly — `AvailableQuantity`/the three level specs replace the old
 * `AvgQuantity`/`[status]` seeds, and `NotAMeasure`/`NotADim` stay off-list either way.
 */
const CUBE_SHAPE: CubeShape = {
  cube: 'ProductInventoryCube',
  measures: [{ name: 'AvailableQuantity', caption: 'Available Quantity' }],
  dimensions: [
    { name: 'status', kind: 'categorical', levels: [{ name: 'status', spec: '[status].[H1].[status]' }] },
    { name: 'product', kind: 'categorical', levels: [
      { name: 'productCategory', caption: 'Product Category', spec: '[product].[H1].[productCategory]' },
      { name: 'productFamily', caption: 'Product Family', spec: '[product].[H1].[productFamily]' },
    ] },
    // `vendor` deliberately repeats product's 'Product Family' CAPTION under a different spec. Captions
    // collide across dimensions; the level dropdown's <option> value must therefore key on l.spec (unique),
    // never the caption. This dimension is the fixture that pins that disambiguation (see the optgroup
    // caption-collision test asserting both distinct '[product]…'/'[vendor]…' specs survive).
    { name: 'vendor', kind: 'categorical', levels: [
      { name: 'productFamily', caption: 'Product Family', spec: '[vendor].[H1].[productFamily]' },
    ] },
  ],
};

/**
 * SC-2662 (C16) test-half — the ui_set_field field-path tripwire.
 *
 * ui_set_field fills the KPI form by an UNCONSTRAINED dotted string path
 * (ui-tools.ts:151) with no shared contract to the frontend field ids. This spec
 * pins the currently-known contract by driving each path through the REAL bridge
 * seam (applyDirective → the KPI component's guided controller) and asserting the
 * value lands. Scalar pins use inputs the real `case` transforms/rejects but the
 * `default` blind-write (kpi.ts:428-430) would NOT — so renaming a case genuinely
 * flips the assertion (a guard that CAN fire), not a green-no-matter-what pin.
 */

/**
 * Fakes for every service KpiComponent.ngOnInit touches, seeded so the pins resolve.
 * `seed` overrides individual kpiApi methods BEFORE ngOnInit runs — needed because
 * the component's IRIS-KPI and draft lists are private and only loaded by reload().
 */
function setup(seed: Partial<Record<string, any>> = {}) {
  TestBed.resetTestingModule();
  const kpiApi = {
    getKpiDefinitions: vi.fn(() => of([])),
    listKpiDrafts: vi.fn(() => of({ drafts: [] })),
    listKpiBaseObjects: vi.fn(() => of({ baseObjects: ['SalesOrder', 'Inventory'] })),
    // Present but unused by the tripwire (component wiring only).
    saveKpiDraft: vi.fn(() => of({})),
    createKpiDefinition: vi.fn(() => of({})),
    updateKpiDefinition: vi.fn(() => of({})),
    deleteKpiDefinition: vi.fn(() => of({})),
    deleteKpiDraft: vi.fn(() => of({})),
    getKpiData: vi.fn(() => of({ values: [] })),
    getKpiListing: vi.fn(() => of([])),
    ...seed,
  };
  const dashboardChart = {
    getCubeShape: vi.fn(() => of(CUBE_SHAPE)),
    getCubeMembers: vi.fn(() => of({ members: [] as Array<{ name: string; key?: string; caption?: string }> })),
  };
  const cubeSvc = {
    list: vi.fn(() => of({ cubes: [{ cubeName: 'ProductInventoryCube', sourceClass: 'SC.Data.Inventory', state: 'built' }] })),
  };
  const kpiGroups = {
    groupOf: vi.fn(() => UNGROUPED),
    groupNames: vi.fn(() => [] as string[]),
    assign: vi.fn(), createGroup: vi.fn(() => true), deleteGroup: vi.fn(),
    forget: vi.fn(), renameKpi: vi.fn(),
  };
  const kpiHealthApi = { getKpiHealth: vi.fn(() => of(null)) };
  const toasts = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };

  TestBed.configureTestingModule({
    imports: [KpiComponent],
    providers: [
      { provide: KpiApiService, useValue: kpiApi },
      { provide: DashboardChartService, useValue: dashboardChart },
      { provide: CubeService, useValue: cubeSvc },
      { provide: KpiGroupService, useValue: kpiGroups },
      { provide: ToastService, useValue: toasts },
      { provide: KpiHealthService, useValue: kpiHealthApi },
    ],
  });
  const fixture: ComponentFixture<KpiComponent> = TestBed.createComponent(KpiComponent);
  const bridge = TestBed.inject(WorkbenchBridgeService);
  fixture.detectChanges(); // ngOnInit → registers the guided controller, loads cubes + base objects
  return { fixture, bridge, component: fixture.componentInstance, kpiApi, kpiGroups, dashboardChart, toasts };
}

/** Drive a set_field directive the way a ui_set_field tool call would at runtime. */
async function setField(bridge: WorkbenchBridgeService, path: string, value: string | number | boolean): Promise<SetFieldResult> {
  return bridge.applyDirective({ action: 'set_field', target: path, value });
}

describe('ui_set_field field-path tripwire (SC-2662 / C16 test-half)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('mounts KpiComponent, registers the guided controller, and resolves a field through the real bridge seam', async () => {
    const { bridge, component } = setup();
    // With a controller registered, an unknown-form set is not "no form open".
    const res = await setField(bridge, 'name', 'Late Orders');
    expect(res.applied).toBe(true);
    expect(component.form.name).toBe('Late Orders');
  });

  /**
   * A single pinned list of the KNOWN ui_set_field paths at 722c40f. A rename/removal
   * of a field id reddens exactly its row. SCALAR pins choose an input the real `case`
   * transforms or rejects but the `default` fallback would not, so removing the case
   * flips the assertion. FREE-TEXT pins (name/label/description/dimensions.0.name) have
   * no case-vs-default distinction — they guard the path's PRESENCE in the contract
   * only (both branches write the raw value); this is stated so the guarantee is never
   * overclaimed.
   */
  interface Pin {
    path: string;
    value: string | number | boolean;
    fires: 'scalar' | 'free-text'; // documents whether a rename flips this pin
    pre?: (bridge: WorkbenchBridgeService) => Promise<void>;
    check: (res: SetFieldResult, form: any) => void;
  }

  // Some pins need a cube chosen first (measures/dimensions validate against its lists).
  const setCube = async (bridge: WorkbenchBridgeService) => {
    const r = await setField(bridge, 'cube', 'ProductInventoryCube');
    expect(r.applied).toBe(true);
  };

  const MDX = '[status].[H1].[status].&[Active]';

  const PINS: Pin[] = [
    { path: 'name', value: 'Late Orders', fires: 'free-text',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.name).toBe('Late Orders'); } },
    { path: 'label', value: 'Late', fires: 'free-text',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.label).toBe('Late'); } },
    { path: 'description', value: 'desc', fires: 'free-text',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.description).toBe('desc'); } },
    // type / analysisService: default-served before the hardening, now explicit free-text cases.
    { path: 'type', value: 'Snapshot', fires: 'free-text',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.type).toBe('Snapshot'); } },
    { path: 'analysisService', value: 'MyService', fires: 'free-text',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.analysisService).toBe('MyService'); } },
    // cube: wrong-case input must be CANONICALISED (default would write it raw).
    { path: 'cube', value: 'productinventorycube', fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.cube).toBe('ProductInventoryCube'); } },
    // kpiMeasure: an off-list measure must be REJECTED (default returns applied:true).
    { path: 'kpiMeasure', value: 'NotAMeasure', fires: 'scalar', pre: setCube,
      check: (r) => { expect(r.applied).toBe(false); } },
    { path: 'valueType', value: 'PERCENTAGE', fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.valueType).toBe('percentage'); } },
    { path: 'status', value: 'inactive', fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.status).toBe('Inactive'); } },
    // baseObject: fire-strength is the canonical match (default writes raw wrong-case).
    // We deliberately do NOT assert baseObjectOther here — it is false in BOTH the real
    // case and the default branch, so it cannot discriminate a rename (spec C16-SPEC-02).
    { path: 'baseObject', value: 'salesorder', fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.baseObject).toBe('SalesOrder'); } },
    // issueKpi: string 'true' must become a strict boolean (default writes the string).
    { path: 'issueKpi', value: 'true', fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.issueKpi).toBe(true); } },
    // defaultIssueSeverity: out-of-range must be REJECTED (default accepts).
    { path: 'defaultIssueSeverity', value: 7, fires: 'scalar',
      check: (r) => { expect(r.applied).toBe(false); } },
    // thresholds: non-numeric must be REJECTED (default accepts).
    { path: 'watchingThreshold', value: 'abc', fires: 'scalar',
      check: (r) => { expect(r.applied).toBe(false); } },
    { path: 'warningThreshold', value: 'abc', fires: 'scalar',
      check: (r) => { expect(r.applied).toBe(false); } },
    // condition arrays: routed by index into a string[] (default would overwrite the array with a scalar).
    { path: 'kpiConditions.0', value: MDX, fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.kpiConditions[0]).toBe(MDX); } },
    { path: 'baseConditions.0', value: '[x]', fires: 'scalar',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.baseConditions[0]).toBe('[x]'); } },
    // dimension cubeDimension: off-list MDX must be REJECTED against the loaded list.
    { path: 'dimensions.0.cubeDimension', value: 'NotADim', fires: 'scalar', pre: setCube,
      check: (r) => { expect(r.applied).toBe(false); } },
    { path: 'dimensions.0.name', value: 'q', fires: 'free-text',
      check: (r, f) => { expect(r.applied).toBe(true); expect(f.dimensions[0].name).toBe('q'); } },
  ];

  it.each(PINS)('pins ui_set_field path "$path" ($fires)', async (pin) => {
    const { bridge, component } = setup();
    if (pin.pre) await pin.pre(bridge);
    const res = await setField(bridge, pin.path, pin.value);
    pin.check(res, component.form as any);
  });

  /**
   * KNOWN_KPI_SCALAR_PATHS is the "single auditable known-field list" (the I1 seed) and
   * the source of the reject message, but the switch cases make the actual known/unknown
   * decision — so the list could silently drift from the case-set. This pins them in sync:
   * EVERY listed path must be RECOGNIZED by the resolver (a known-but-invalid input yields a
   * validation reject; only a genuinely UNKNOWN path reaches "not a recognized KPI field").
   * Drop a case (or add a stale entry to the list) and this reddens for that path.
   */
  it.each(KNOWN_KPI_SCALAR_PATHS)('KNOWN_KPI_SCALAR_PATHS entry "%s" is recognized by the resolver (no drift)', async (path) => {
    const { bridge } = setup();
    const res = await setField(bridge, path, 'x');
    expect(res.detail ?? '', path).not.toContain('not a recognized KPI field');
  });

  // SC-2662 C16 regression-guard (round-8): the reshaped guided condition builder must not have moved
  // the condition slot off the recognized ui_set_field paths, and the reject-unknown branch (kpi.ts:478)
  // must still fire. If a future edit renamed a field id, this reddens.
  it('C16 regression-guard: a guided condition fill routes through the recognized ui_set_field paths', async () => {
    const { bridge, component } = setup();
    const res = await setField(bridge, 'kpiConditions.0', '[status].[H1].[status].&[Active]');
    expect(res.applied).toBe(true);
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[Active]');
    // and the unknown-path rejection still fires (the C16 contract is intact). A genuinely UNKNOWN
    // head reaches setKpiScalar's reject-unknown default (kpi.ts:478); note 'kpiConditions.<x>' would
    // NOT — the recognized 'kpiConditions' head takes the array branch (arr[NaN]=value, applied:true).
    const bad = await setField(bridge, 'bogusField', 'y');
    expect(bad.applied).toBe(false);
  });
});

/**
 * SC-2662 (C16) hardening — unknown field paths are now rejected, not blind-written.
 *
 * setKpiScalar's `default` (formerly kpi.ts:428-430) used to BLIND-WRITE the raw
 * value onto the form model and return `{ applied: true }`, so an unknown/renamed
 * scalar id — exactly what a broken field-id contract produces — was reported to
 * the agent as SUCCESS while writing a property the form never reads (defect 2).
 * setKpiDimensionField had the same hole for dimension-row fields (defect 3).
 * Both `default` branches now REJECT (applied:false, no write). These tests pin
 * the fixed behaviour; reverting either blind-write reddens them (guard fires).
 */
describe('setKpiScalar unknown-path rejection (SC-2662 defect 2, fixed)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('rejects an unknown scalar path (applied:false) and does NOT blind-write it', async () => {
    const { bridge, component } = setup();
    const res = await setField(bridge, 'bogusField', 'whatever');
    // Fixed behaviour: an unrecognized field id is a visible failure, not a silent success.
    expect(res.applied).toBe(false);
    expect(res.detail).toContain('bogusField');
    // ...and nothing is written onto a property the form model never reads.
    expect('bogusField' in (component.form as any)).toBe(false);
  });

  it('rejects an unknown DIMENSION field (applied:false) and does NOT blind-write it', async () => {
    const { bridge, component } = setup();
    const res = await setField(bridge, 'dimensions.0.bogus', 'whatever');
    // Fixed behaviour: setKpiDimensionField's default rejects too (defect 3, closed this round).
    expect(res.applied).toBe(false);
    expect('bogus' in ((component.form as any).dimensions[0])).toBe(false);
  });
});

/**
 * Guided-mode unsaved-edits resolution: the assistant, after asking the user,
 * saves-or-discards the open form ITSELF (via resolveUnsaved) so a navigation can
 * proceed — rather than telling the user to click the leave dialog and then doing
 * nothing (the reported dead-end). These pins drive resolveUnsaved through the
 * real controller.
 */
describe('KPI guided resolveUnsaved (save/discard on the user\'s behalf)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** Reach the controller's resolveUnsaved the way the bridge does. */
  function resolveUnsaved(component: KpiComponent, d: 'save' | 'discard'): Promise<SetFieldResult> {
    const controller = (component as unknown as { guidedController: { resolveUnsaved: (x: 'save' | 'discard') => Promise<SetFieldResult> } }).guidedController;
    return controller.resolveUnsaved(d);
  }

  it('discard clears the dirty flag so the leave-guard passes', async () => {
    const { component } = setup();
    component.openNewForm();
    component.form.name = 'Draft1';
    component.markDirty();
    expect(component.formDirty).toBe(true);

    const res = await resolveUnsaved(component, 'discard');
    expect(res.applied).toBe(true);
    expect(component.formDirty).toBe(false);
  });

  it('save persists the draft (calls saveKpiDraft) and resolves applied:true', async () => {
    const { component, kpiApi } = setup();
    component.openNewForm();
    component.form.name = 'Draft1';
    component.form.cube = 'ProductInventoryCube';
    component.markDirty();

    const res = await resolveUnsaved(component, 'save');
    expect(kpiApi.saveKpiDraft).toHaveBeenCalledTimes(1);
    expect(res.applied).toBe(true);
    expect(component.formDirty).toBe(false);
  });

  it('save with no name fails (does NOT save) and reports why', async () => {
    const { component, kpiApi } = setup();
    component.openNewForm();
    component.markDirty(); // dirty but nameless

    const res = await resolveUnsaved(component, 'save');
    expect(kpiApi.saveKpiDraft).not.toHaveBeenCalled();
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/name/i);
  });
});

/**
 * SC-2687 — submitting a reopened draft must POST when the KPI is not in IRIS.
 *
 * submit() used to pick the verb from `formMode` alone, and openEditForm() always
 * sets 'edit' — so a draft that was never submitted was sent as
 * PUT /kpi/definitions/{name} and SCO answered 404. The verb now comes from the
 * IRIS-KPI list. Reverting the gate to `formMode === 'edit'` reddens the first and
 * third cases (createKpiDefinition would go uncalled); dropping the IRIS check
 * entirely and always POSTing reddens the second.
 */
describe('KPI draft submit verb (SC-2687)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** A definition that passes validateForSubmit: name + cube + valueType + one condition. */
  const draftDef = (name: string) => ({
    name,
    label: 'Late Orders',
    type: 'DeepSee',
    baseObject: 'SalesOrder',
    status: 'Active',
    deepseeKpiSpec: {
      cube: 'ProductInventoryCube',
      kpiMeasure: 'AvgQuantity',
      valueType: 'raw',
      kpiConditions: ['[status].[H1].[status].&[Late]'],
    },
  });

  /** Mount with one saved draft, `inIris` controlling whether IRIS also has the KPI. */
  function withDraft(name: string, inIris: boolean) {
    const def = draftDef(name);
    const ctx = setup({
      getKpiDefinitions: vi.fn(() => of(inIris ? [def] : [])),
      listKpiDrafts: vi.fn(() => of({ drafts: [{ kpiName: name, definition: def, state: 'draft' }] })),
    });
    // Reopen the draft exactly as the detail view's Edit button does.
    const listed = ctx.component.groups.flatMap(g => g.items).find(k => k.name === name);
    expect(listed).toBeDefined();
    ctx.component.selectKpi(listed!);
    ctx.component.openEditForm();
    return ctx;
  }

  it('POSTs a draft that was never submitted to IRIS (the 404 case)', () => {
    const { component, kpiApi } = withDraft('LateOrders', false);
    expect(component.isDraftOnly).toBe(true);

    component.submit();

    expect(component.formError).toBe('');
    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1);
    expect(kpiApi.updateKpiDefinition).not.toHaveBeenCalled();
  });

  it('still PUTs a draft that holds unsubmitted edits to an EXISTING IRIS KPI', () => {
    const { component, kpiApi } = withDraft('LateOrders', true);

    component.submit();

    expect(component.formError).toBe('');
    expect(kpiApi.updateKpiDefinition).toHaveBeenCalledTimes(1);
    // The fakes are typed as zero-arg, so read the recorded args untyped.
    expect((kpiApi.updateKpiDefinition.mock.calls as any[])[0][0]).toBe('LateOrders');
    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();
  });

  it('POSTs a renamed draft-only KPI and still cleans up the old draft + group assignment', () => {
    const { component, kpiApi, kpiGroups } = withDraft('LateOrders', false);
    component.form.name = 'VeryLateOrders';

    component.submit();

    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1);
    expect(kpiApi.updateKpiDefinition).not.toHaveBeenCalled();
    // The rename cleanup is keyed on "was editing", not on "was an update".
    expect(kpiApi.deleteKpiDraft).toHaveBeenCalledWith('LateOrders');
    expect(kpiGroups.renameKpi).toHaveBeenCalledWith('LateOrders', 'VeryLateOrders');
  });
});

/**
 * I1 (SC-2666): KPI cube metadata is sourced from the shared `DashboardChartService.getCubeShape`
 * port. These pin that the guided-validation lists are rebuilt from the CubeShape with per-LEVEL
 * cardinality (one entry per dimension level, not per dimension) so the C16 ui_set_field dimension
 * surface is unchanged — collapsing to levels[0] would drop the non-first levels the dropdown offers.
 */
describe('KPI cube metadata from the shared getCubeShape port (SC-2666 / I1)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('rebuilds formCubeMeasures from the cube shape', async () => {
    const { component } = setup();
    component.form.cube = 'ProductInventoryCube';
    component.onFormCubeChange();
    await component['cubeMetaLoading'];
    expect(component.formCubeMeasures).toEqual(['AvailableQuantity']);
  });

  it('keeps EVERY level of a multi-level dimension selectable (per-level cardinality, not per-dimension)', async () => {
    const { component } = setup();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    expect(component.formCubeDimensions.map((d) => d.value)).toEqual([
      '[status].[H1].[status]',
      '[product].[H1].[productCategory]',
      '[product].[H1].[productFamily]',
      '[vendor].[H1].[productFamily]',
    ]);
  });
});

/**
 * I1 (SC-2666): the persistent shared model tree in the KPI form. Double-clicking a member places
 * a CANONICAL member reference into the focused condition row — the guided default that makes a
 * malformed condition unreachable. KPI conditions use the KEY form `[level].&[key]` (vs the dashboard
 * filter's NAME form), degrading to name form when the member carries no key (never `&[undefined]`).
 * The free-text input stays as the power-user / recovery escape hatch.
 */

/**
 * Task 4 (SC-2666 / I1): drag-and-drop REORDERS condition rows and, when a row is dropped onto a
 * same-level mergeable sibling, raises the merge offer (banner + keyboard Combine). Order is
 * semantically inert (conditions are ANDed), so reorder is a pure permutation; merge folds the pair
 * into one isOneOf union. jsdom has no real DataTransfer, so drag glue is exercised with a stub store
 * (mirrors table-builder.spec.ts:54-70 + the setDragImage no-op the row drag needs).
 */
function stubDataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: 'none' as string,
    dropEffect: 'none' as string,
    setData: (type: string, val: string) => { store[type] = val; },
    getData: (type: string) => store[type] ?? '',
    setDragImage: (_el: Element, _x: number, _y: number) => {},
  };
}
function dragEvent(type: string, dataTransfer: ReturnType<typeof stubDataTransfer>): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
  return ev;
}
function rowPayload(list: 'kpi' | 'base', i: number) {
  return JSON.stringify({ list, i });
}

describe('KPI condition drag-to-reorder + merge (Change 3 — Task 4)', () => {
  afterEach(() => TestBed.resetTestingModule());

  // ── reorder (both directions) ──
  it('drops row 0 onto row 2 → the moved row lands at index 2 (rows after shift up)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['A', 'B', 'C'];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 2, dragEvent('drop', dt) as any);
    expect(component.form.kpiConditions).toEqual(['B', 'C', 'A']);
  });

  it('drops row 2 onto row 0 → the moved row lands at index 0 (rows after shift down)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['A', 'B', 'C'];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 2, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 0, dragEvent('drop', dt) as any);
    expect(component.form.kpiConditions).toEqual(['C', 'A', 'B']);
  });

  it('reorder carries the per-row free-text state to the new index (both directions)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[A]', 'raw mdx here', 'C'];
    component.toggleFreeText('kpi', 1);                    // row 1 is free-text
    expect(component.conditionIsFreeText('kpi', 1)).toBe(true);
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 1, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 0, dragEvent('drop', dt) as any); // free-text row moves to index 0
    expect(component.form.kpiConditions[0]).toBe('raw mdx here');
    expect(component.conditionIsFreeText('kpi', 0)).toBe(true);        // state rode along
    expect(component.conditionIsFreeText('kpi', 1)).toBe(false);
  });

  // ── merge offer ──
  it('a same-level positive drop reorders AND offers a merge; accept → is one of {union}, drop row removed', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]',
      '[product].[H1].[productFamily].&[Y]',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);  // 0 onto 1
    expect(component.mergeOffer()).not.toBeNull();
    component.acceptMergeOffer();
    expect(component.form.kpiConditions.length).toBe(1);
    expect(component.form.kpiConditions[0])
      .toBe('{[product].[H1].[productFamily].&[Y],[product].[H1].[productFamily].&[X]}');
    expect(component.conditionOperator('kpi', 0)).toBe('isOneOf');
    expect(component.mergeOffer()).toBeNull();
  });

  it('dismissMergeOffer leaves both rows and clears the offer', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]', '[product].[H1].[productFamily].&[Y]',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    component.dismissMergeOffer();
    expect(component.form.kpiConditions.length).toBe(2);
    expect(component.mergeOffer()).toBeNull();
  });

  it('a same-level NEGATIVE drop offers a merge → is not one of {union} (drag-only isNot pair)', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      'EXCEPT([product].[H1].[productFamily].MEMBERS,{[product].[H1].[productFamily].&[X]})',
      'EXCEPT([product].[H1].[productFamily].MEMBERS,{[product].[H1].[productFamily].&[Y]})',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    expect(component.mergeOffer()).not.toBeNull();
    component.acceptMergeOffer();
    expect(component.form.kpiConditions.length).toBe(1);
    expect(component.conditionOperator('kpi', 0)).toBe('isNotOneOf');
    expect(component.conditionMemberKeys('kpi', 0).sort()).toEqual(['X', 'Y']);
  });

  it('identical positive rows merge to a single is X (union size 1 → single form)', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]', '[product].[H1].[productFamily].&[X]',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    component.acceptMergeOffer();
    expect(component.form.kpiConditions).toEqual(['[product].[H1].[productFamily].&[X]']);
    expect(component.conditionOperator('kpi', 0)).toBe('is');
  });

  // ── plain reorder, no offer ──
  it('a DIFFERENT-level drop is a plain reorder, no offer', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      '[status].[H1].[status].&[Active]', '[product].[H1].[productFamily].&[Y]',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    expect(component.mergeOffer()).toBeNull();
    expect(component.form.kpiConditions).toEqual([
      '[product].[H1].[productFamily].&[Y]', '[status].[H1].[status].&[Active]',
    ]);
  });

  it('is X onto is-not X (same level) is a plain reorder, no offer', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]',
      'EXCEPT([product].[H1].[productFamily].MEMBERS,{[product].[H1].[productFamily].&[X]})',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    expect(component.mergeOffer()).toBeNull();
    expect(component.form.kpiConditions.length).toBe(2);
  });

  // ── guards ──
  it('a cross-list drag (base payload dropped on kpi) is ignored', () => {
    const { component } = setup();
    component.form.kpiConditions = ['A', 'B'];
    const dt = stubDataTransfer();
    component.onRowDragStart('base', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    expect(component.form.kpiConditions).toEqual(['A', 'B']); // untouched
  });

  it('a self-drop (drop on the source row) is a no-op', () => {
    const { component } = setup();
    component.form.kpiConditions = ['A', 'B'];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 1, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    expect(component.form.kpiConditions).toEqual(['A', 'B']);
    expect(component.mergeOffer()).toBeNull();
  });

  it('dragover accepts the condition-row payload type and lights the reused --target treatment', () => {
    const { component } = setup();
    const dt = stubDataTransfer();
    const ev = dragEvent('dragover', dt) as any;
    Object.defineProperty(ev, 'dataTransfer', { value: { ...dt, types: ['application/x-condition-row'] }, configurable: true });
    component.onConditionDragOver('kpi', 0, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(component.dragOverCondition()).toEqual({ list: 'kpi', i: 0 });
  });

  // ── keyboard combine via the analyzer warning ──
  it('conditionCombineTarget returns the pair for a positive same-level contradiction/orNudge, null for isNot', () => {
    const { component } = setup();
    // two positive same-level rows overlapping → orNudge flags rows [0,1]
    component.form.kpiConditions = [
      '{[product].[H1].[productFamily].&[X],[product].[H1].[productFamily].&[Y]}',
      '{[product].[H1].[productFamily].&[Y],[product].[H1].[productFamily].&[Z]}',
    ];
    const t = component.conditionCombineTarget('kpi', 0);
    expect(t).toEqual({ keepIndex: 0, dropIndex: 1 });    // keep the earlier row
    // isNot pair: analyzer does NOT flag it → no combine target
    component.form.kpiConditions = [
      'EXCEPT([product].[H1].[productFamily].MEMBERS,{[product].[H1].[productFamily].&[X]})',
      'EXCEPT([product].[H1].[productFamily].MEMBERS,{[product].[H1].[productFamily].&[Y]})',
    ];
    expect(component.conditionCombineTarget('kpi', 0)).toBeNull();
  });

  it('clicking Combine merges via the same mergeConditionRows path', () => {
    const { component } = setup();
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]', '[product].[H1].[productFamily].&[Y]',
    ];
    const t = component.conditionCombineTarget('kpi', 0)!;
    component.mergeConditionRows('kpi', t.keepIndex, t.dropIndex);
    expect(component.form.kpiConditions.length).toBe(1);
    expect(component.conditionOperator('kpi', 0)).toBe('isOneOf');
  });

  // ── the offer is transient: any other row edit dismisses it (spec §7.4) ──
  // A live offer holds indices captured at drop time. If the user edits or adds/removes a row while the
  // offer is still showing, those indices go stale — the prompt would render on the wrong row and Merge
  // could fold an unintended pair. So every guided edit and every add/remove clears the offer first.
  const armMergeOffer = (component: KpiComponent) => {
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]', '[product].[H1].[productFamily].&[Y]',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    expect(component.mergeOffer()).not.toBeNull();          // precondition: an offer is live
  };

  it('an operator change clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.setConditionOperator('kpi', 0, 'isNot');
    expect(component.mergeOffer()).toBeNull();
  });

  it('a level change clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.setConditionLevel('kpi', 0, '[status].[H1].[status]');
    expect(component.mergeOffer()).toBeNull();
  });

  it('a member pick clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.selectConditionMember('kpi', 0, 'Z');
    expect(component.mergeOffer()).toBeNull();
  });

  it('adding a row clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.addKpiCondition();
    expect(component.mergeOffer()).toBeNull();
  });

  it('removing/clearing a row clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    (component as any).removeOrClearCondition('kpi', 0);
    expect(component.mergeOffer()).toBeNull();
  });

  it('a free-text raw rewrite clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.onFreeTextInput('kpi', 0, '[status].[H1].[status].&[Active]');
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[Active]'); // the write still lands
    expect(component.mergeOffer()).toBeNull();
  });

  it('flipping a row into free-text mode clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.toggleFreeText('kpi', 0);
    expect(component.mergeOffer()).toBeNull();
  });

  it('the co-pilot writing a condition slot clears a live merge offer', async () => {
    const { component } = setup();
    armMergeOffer(component);
    await (component as any).guidedSetField('kpiConditions.0', '[status].[H1].[status].&[Active]');
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[Active]');
    expect(component.mergeOffer()).toBeNull();
  });

  // The offer's captured indices are meaningful only within the form they were armed in. Opening a new
  // form, loading another KPI to edit, or cancelling must not carry a stale offer into the next form —
  // else the banner renders unprompted and Merge could fold an unintended pair on a DIFFERENT KPI.
  it('opening a new form clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.openNewForm();
    expect(component.mergeOffer()).toBeNull();
  });

  it('cancelling the form clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.performCancel();
    expect(component.mergeOffer()).toBeNull();
  });

  it('loading another KPI to edit clears a live merge offer', () => {
    const { component } = setup();
    armMergeOffer(component);
    component.selectKpi({ name: 'Other', type: 'DeepSee' } as any);
    component.openEditForm();
    expect(component.mergeOffer()).toBeNull();
  });
});

/**
 * Task 5 (SC-2666 / I1): the guided condition row — an operator toggle (`is` / `is null`) + a member
 * caption is a VIEW over the flat MDX slot (still the source of truth); a free-text escape hatch stays
 * for power users. Plus the round-8 amendment: Base Conditions is present-but-disabled for a raw KPI,
 * never *ngIf'd away. The flat slot and the C16 ui_set_field contract are unchanged — only a read/compose
 * view is layered on top.
 */
describe('KPI guided condition row (SC-2666 / I1 — Task 5)', () => {
  afterEach(() => TestBed.resetTestingModule());

  // openNewForm() writes plain fields (formMode/valueType) that don't self-mark the view in zoneless
  // mode; mark dirty before detectChanges (what every production openNewForm() caller does with
  // cdr.markForCheck()) so the render commits without a spurious NG0100 on the formMode binding.
  // Then await whenStable(): NgModel applies [disabled] through a deferred resolved-promise microtask
  // (setDisabledState on the value accessor), so a synchronous detectChanges() leaves the native
  // .disabled property stale until that microtask flushes.
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  // SC-2665 / E4 Item-4 dedup guard: the .form-* chrome moved from kpi.css into the ONE
  // global styles.css block. That edit touches zero templates, so this form-region markup
  // must be byte-identical after the move — the snapshot pins it. If a future edit changes
  // the form's class list/structure, this reddens and forces a re-baseline decision.
  it('form region markup snapshot (Item 4 dedup guard)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    await render(fixture);
    const region = (fixture.nativeElement as HTMLElement).querySelector('.form-section, .form-grid');
    expect(region).toBeTruthy();
    expect(styleScopeFree(region?.outerHTML)).toMatchSnapshot();
  });

  it('migrated readers resolve a single-member is row through keys[] (regression: key? → keys[])', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    expect(component.conditionOperator('kpi', 0)).toBe('is');
    expect(component.conditionMemberKey('kpi', 0)).toBe('Active');   // reads keys[0]
    expect(component.conditionMemberCaption('kpi', 0)).toBe('Active');
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(false);
  });

  it('the operator toggle recomposes is→isNull keeping the level; is with no member yields the re-pickable empty-key sentinel', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]']; // is form, level established
    component.setConditionOperator('kpi', 0, 'isNull');
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[<null>]'); // keeps the level, drops the member
    // Back to 'is': the isNull toggle dropped the specific member. Rather than the old dead no-op that
    // stranded the row on isNull (a member could only be PLACED from the tree), `is` now composes the
    // [level].&[] EMPTY-KEY sentinel — a guided, re-pickable, INCOMPLETE row. The member dropdown fills it
    // in place (see the member-dropdown suite); conditionIsIncomplete blocks save until a member lands.
    component.setConditionOperator('kpi', 0, 'is');
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[]'); // empty-key sentinel
    expect(component.conditionOperator('kpi', 0)).toBe('is');                   // re-derives 'is', ready to re-pick
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);                // still guided, not stranded
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);              // incomplete → blocks save
  });

  it('parseCondition seeds the row operator on read; an unrecognized slot reads as free-text', () => {
    const { component } = setup();
    // simulate loading a KPI whose conditions include one canonical and one hand-typed set
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]', '{ [status].&[A], [status].&[B] }'];
    expect(component.conditionOperator('kpi', 0)).toBe('is');
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);
    expect(component.conditionIsFreeText('kpi', 1)).toBe(true); // non-canonical → free-text
  });

  it('free-text flip-back is non-destructive on a non-guided-representable string (§235)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    component.toggleFreeText('kpi', 0);                       // → free-text
    component.form.kpiConditions[0] = '{ [status].&[A], [status].&[B] }'; // type a set
    component.toggleFreeText('kpi', 0);                       // flip back
    expect(component.conditionIsFreeText('kpi', 0)).toBe(true);          // stays free-text
    expect(component.form.kpiConditions[0]).toBe('{ [status].&[A], [status].&[B] }'); // NOT discarded
  });

  it('operator control is a guarded no-op on a level-less row (§230)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['']; // no level yet
    expect(component.conditionHasLevel('kpi', 0)).toBe(false);
    // setConditionOperator on a level-less row is a guarded no-op (nothing to compose)
    component.setConditionOperator('kpi', 0, 'isNull');
    expect(component.form.kpiConditions[0]).toBe('');
  });

  it('the operator dropdown renders the explicit 6 in positive/negative-paired order', async () => {
    const { component, fixture } = setup();
    // Four of the six operators are 1.8.0-only and gated off by default; enable the lane to assert the
    // full paired order the guided builder offers on 1.8.0 (see mdx-feature-flags).
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    await render(fixture);
    // Direct-child options only: the six-op set. The SC-2701 comparison operators live in a nested
    // <optgroup> (covered by the guided-comparison describe), so scope to > option to pin the six's order.
    const opts = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="kpi-conditions-section"] .condition-operator > option'),
    ).map((o: any) => o.getAttribute('value'));
    expect(opts).toEqual(['is', 'isOneOf', 'isNot', 'isNotOneOf', 'isNull', 'isNotNull']);
  });

  it('isOneOf is reachable from a fresh (memberless) row: the operator sticks and the checkbox multi-select renders BEFORE any member is checked', async () => {
    const { component, fixture, dashboardChart } = setup();
    dashboardChart.getCubeMembers.mockReturnValue(of({ members: [
      { name: 'Battery', key: 'Battery' }, { name: 'CPU', key: 'CPU' }] }));
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[]'];  // level known, NO member (the natural start state)
    await new Promise((r) => setTimeout(r));
    component.setConditionOperator('kpi', 0, 'isOneOf');
    await render(fixture);
    // The operator STICKS on the empty row (pending hint), does not spring back to 'is'.
    expect(component.conditionOperator('kpi', 0)).toBe('isOneOf');
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-row');
    expect(row.querySelector('.condition-member-checkboxes')).toBeTruthy();   // multi-select popup renders with zero members
    expect(row.querySelector('input.condition-member-combobox')).toBeNull();  // single combobox hidden
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);             // zero-member set blocks save
    // Back to is restores the single combobox and clears the hint.
    component.setConditionOperator('kpi', 0, 'is');
    await render(fixture);
    expect(component.conditionOperator('kpi', 0)).toBe('is');
    expect(row.querySelector('input.condition-member-combobox')).toBeTruthy();
  });

  it('the set-operator popup carries axCloseOnOutside so it collapses on a click away (not just on the row)', async () => {
    const { component, fixture, dashboardChart } = setup();
    dashboardChart.getCubeMembers.mockReturnValue(of({ members: [
      { name: 'Battery', key: 'Battery' }, { name: 'CPU', key: 'CPU' }] }));
    component.openNewForm();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[]'];
    component.setConditionOperator('kpi', 0, 'isOneOf');
    await render(fixture);
    const details = fixture.nativeElement.querySelector(
      '[data-testid="kpi-conditions-section"] .condition-member-checkboxes',
    ) as HTMLDetailsElement;
    expect(details).toBeTruthy();
    // The directive lives on the <details>; opening it and clicking outside must close it. (Directive
    // behavior itself is proven in close-on-outside.directive.spec; here we prove it is WIRED here.)
    document.body.appendChild(fixture.nativeElement);
    details.open = true;
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(details.open).toBe(false);
    fixture.nativeElement.remove();
  });

  it('renders the quiet ⚠ icon on the controls line as a sibling of the chip (never inside it) so it cannot overlap the member text', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]', '[c].[H1].[cat].&[CPU]'];
    await render(fixture);
    const row = fixture.nativeElement.querySelector(
      '[data-testid="kpi-conditions-section"] .condition-row',
    ) as HTMLElement;
    // The quiet ⚠ icon sits on the .condition-controls line alongside the pencil/remove icon-buttons, as a
    // SIBLING of .condition-face — never inside .condition-chip, so it can never overlap the member text.
    const controls = row.querySelector('.condition-controls') as HTMLElement;
    expect(controls).toBeTruthy();
    expect(controls.querySelector('.condition-face')).toBeTruthy();      // chip anchor is inside the controls line
    const icon = row.querySelector('.condition-warning-icon') as HTMLElement;
    expect(icon).toBeTruthy();
    expect(controls.contains(icon)).toBe(true);                          // icon lives on the controls line
    const chip = row.querySelector('.condition-chip') as HTMLElement;
    expect(chip.contains(icon)).toBe(false);                             // but NOT inside the chip
  });

  it('(layout) the value control is inside .condition-chip and the row icon-buttons are siblings of the chip on the controls line (never inside it)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]']; // a guided single-member row
    await render(fixture);
    const row = fixture.nativeElement.querySelector(
      '[data-testid="kpi-conditions-section"] .condition-rows .condition-row',
    ) as HTMLElement;
    const controls = row.querySelector('.condition-controls') as HTMLElement;
    const chip = controls.querySelector('.condition-chip') as HTMLElement;
    expect(chip).toBeTruthy();
    // the value control lives INSIDE the chip …
    expect(chip.querySelector('input.condition-member-combobox')).toBeTruthy();
    // … while the pencil + trash icon-buttons are siblings of the chip on the controls line, NOT descendants of it
    const pencil = controls.querySelector('.condition-mdx-toggle') as HTMLElement;
    const trash = controls.querySelector('.form-remove-row-btn') as HTMLElement;
    expect(pencil).toBeTruthy();
    expect(trash).toBeTruthy();
    expect(chip.contains(pencil)).toBe(false);
    expect(chip.contains(trash)).toBe(false);
  });

  it('checking two members on a fresh isOneOf row composes {a,b} and reconciles the pending hint into the slot; unchecking to zero re-blocks save', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[]'];  // level known, empty
    component.setConditionOperator('kpi', 0, 'isOneOf');                       // pending hint set; slot still the sentinel
    expect(component.form.kpiConditions[0]).toBe('[product].[H1].[productCategory].&[]');
    component.toggleConditionMember('kpi', 0, 'Battery', true);
    component.toggleConditionMember('kpi', 0, 'CPU', true);
    expect(component.form.kpiConditions[0])
      .toBe('{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[CPU]}');
    expect(component.conditionOperator('kpi', 0)).toBe('isOneOf');            // now slot-derived (hint reconciled away)
    expect(component['pendingOperator'].has('kpi:0')).toBe(false);
    expect(component.conditionMemberKeys('kpi', 0)).toEqual(['Battery', 'CPU']);
    component.toggleConditionMember('kpi', 0, 'Battery', false);
    component.toggleConditionMember('kpi', 0, 'CPU', false);
    expect(component.conditionOperator('kpi', 0)).toBe('isOneOf');            // still isOneOf (hint re-pinned on the emptied row)
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);            // zero-member set blocks save
  });

  it('setConditionOperator to isNot on an established member composes EXCEPT and keeps the member', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[r].[H1].[reg].&[North]'];
    component.setConditionOperator('kpi', 0, 'isNot');
    expect(component.form.kpiConditions[0]).toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})');
    expect(component.conditionOperator('kpi', 0)).toBe('isNot');
    expect(component['pendingOperator'].has('kpi:0')).toBe(false);           // slot encodes it — no hint needed
  });

  it('isNot on a memberless row holds the operator via the hint and never composes the invalid EXCEPT(...{&[]}) (would 422)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[r].[H1].[reg].&[]'];                    // level known, no member
    component.setConditionOperator('kpi', 0, 'isNot');
    expect(component.conditionOperator('kpi', 0)).toBe('isNot');             // sticks (pending hint)
    expect(component.form.kpiConditions[0]).toBe('[r].[H1].[reg].&[]');      // slot stays the sentinel, NOT EXCEPT(...{&[]})
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);            // blocks save so no 422 reaches IRIS
    // Picking the member through the single <select> completes it into the real EXCEPT.
    component.selectConditionMember('kpi', 0, 'North');
    expect(component.form.kpiConditions[0]).toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})');
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(false);
  });

  it('the single-member <select> serves isNot too: its member key/caption read and re-pick work under isNot', () => {
    const { component } = setup();
    component.form.kpiConditions = ['EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})'];
    expect(component.conditionOperator('kpi', 0)).toBe('isNot');
    expect(component.conditionWantsMember('kpi', 0)).toBe(true);
    expect(component.conditionIsSetOperator('kpi', 0)).toBe(false);          // single <select>, not the checkbox list
    expect(component.conditionMemberKey('kpi', 0)).toBe('North');            // reads the EXCEPT'd member
    expect(component.conditionMemberCaption('kpi', 0)).toBe('North');
    component.selectConditionMember('kpi', 0, 'South');                       // re-pick stays isNot
    expect(component.form.kpiConditions[0]).toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[South]})');
    expect(component.conditionOperator('kpi', 0)).toBe('isNot');
  });

  it('a 1-member isNotOneOf keeps its operator via the hint even though the slot normalizes to EXCEPT(…{1 ref})', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[r].[H1].[reg].&[]'];
    component.setConditionOperator('kpi', 0, 'isNotOneOf');
    component.toggleConditionMember('kpi', 0, 'North', true);                 // one member so far
    expect(component.form.kpiConditions[0]).toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North]})');
    expect(component.conditionOperator('kpi', 0)).toBe('isNotOneOf');         // hint holds it over the isNot-normalized slot
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(false);            // one exclusion is a valid query
    component.toggleConditionMember('kpi', 0, 'South', true);                 // now 2 → slot encodes isNotOneOf itself
    expect(component.form.kpiConditions[0])
      .toBe('EXCEPT([r].[H1].[reg].MEMBERS,{[r].[H1].[reg].&[North],[r].[H1].[reg].&[South]})');
    expect(component.conditionOperator('kpi', 0)).toBe('isNotOneOf');
    expect(component['pendingOperator'].has('kpi:0')).toBe(false);            // slot now faithful — hint dropped
  });

  it('removing a row re-indexes the pending-operator hint so it does not spring onto the wrong row', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[r].[H1].[reg].&[North]', '[p].[H1].[cat].&[]'];
    component.setConditionOperator('kpi', 1, 'isOneOf');                      // hint pinned on row 1
    expect(component.conditionOperator('kpi', 1)).toBe('isOneOf');
    component.removeKpiCondition(0);                                          // queues the confirm prompt
    component.runConfirmPrompt();                                            // user confirms → splice, row 1 → row 0
    expect(component.conditionOperator('kpi', 0)).toBe('isOneOf');           // hint followed the row down
  });

  // ── Chip redesign (post-audit, spec §7): three row states. Karsten rejected the shipped guided row
  // (operator dropdown + floating caption + readonly raw-MDX readout box + text "MDX" button) as "big,
  // clunky, incoherent." The rebuild: (a) an EMPTY row is a dashed drop-zone, (b) a GUIDED row is a
  // subject-first CHIP (level caption · is▾ · member) with a muted pencil icon-button to raw text and the raw
  // MDX on hover via [data-tooltip], (c) a FREE-TEXT row is the editable raw-MDX input + a "Use guided"
  // control. The flat MDX slot stays the source of truth; the view methods are unchanged. ──

  it('(a) an EMPTY condition row renders a level-select dropdown only, not operator or member controls', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [''];      // empty → level-select only state
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const chip = row.querySelector('.condition-chip') as HTMLElement;
    expect(chip).toBeTruthy();                                   // chip renders (no longer gated on !conditionIsEmpty)
    expect(chip.querySelector('select.condition-level-select')).toBeTruthy(); // level dropdown shown
    // The empty state shows no operator or member controls (gated on conditionHasLevel).
    expect(row.querySelector('.condition-operator')).toBeNull();
    expect(row.querySelector('.condition-member-combobox')).toBeNull();
  });

  it('(b) a GUIDED row renders a subject-first chip: level caption, is▾ operator, member combobox, raw-source icon-button', async () => {
    const { component, fixture, dashboardChart } = setup();
    dashboardChart.getCubeMembers.mockReturnValue(of({ members: [{ name: 'Battery', key: 'Battery', caption: 'Battery' }] }));
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');     // seed cubeShape for the level-caption lookup
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]']; // is, level known
    await new Promise((r) => setTimeout(r));                    // let the eager member fetch resolve
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row') as HTMLElement;
    const chip = row.querySelector('.condition-chip') as HTMLElement;
    expect(chip).toBeTruthy();                                                  // the guided chip
    // Subject-first: the level caption reads first (humanized from the cube shape, not the raw MDX spec).
    const level = chip.querySelector('select.condition-level-select') as HTMLSelectElement;
    expect(level.selectedOptions[0]?.textContent).toContain('Product Category');                   // caption, NOT '[product].[H1]...'
    // The operator control and the member control are inside the chip; the member is now a combobox.
    expect(chip.querySelector('.condition-operator')).toBeTruthy();
    const memberInput = chip.querySelector('input.condition-member-combobox') as HTMLInputElement;
    expect(memberInput).toBeTruthy();
    expect(component.conditionMemberKey('kpi', 0)).toBe('Battery');            // the placed member is selected
    // The escape-hatch affordance is a MUTED pencil icon-button (the page's own Edit glyph) with a
    // tooltip — NOT a text "MDX" button.
    const toggle = row.querySelector('.condition-mdx-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('data-tooltip')).toBe('Edit as raw text');
    expect(toggle.querySelector('svg')).toBeTruthy();                          // an SVG icon, not a text glyph
    expect(toggle.textContent?.trim()).not.toBe('MDX');                        // not the rejected text button
  });

  it('(Item 3) the raw-text toggle reuses the page Edit (pencil) icon; its aria-label tracks state (not the static "raw MDX")', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];       // a guided row
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-row');
    const toggle = row.querySelector('.condition-mdx-toggle') as HTMLButtonElement;
    expect(toggle.querySelector('svg')).toBeTruthy();                         // the pencil SVG icon, reused from the detail-header Edit button
    expect(toggle.getAttribute('aria-label')).toBe('Edit as raw text');       // guided: offers the hatch
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    component.toggleFreeText('kpi', 0);                                        // → free-text
    await render(fixture);
    expect(toggle.getAttribute('aria-label')).toBe('Switch to guided editing'); // pressed: label tracks action
    expect(toggle.getAttribute('data-tooltip')).toBe('Use guided');           // tooltip unchanged from before
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('(Item 3) the condition remove-row button reuses the page trash icon (not the ✕ text glyph)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]', '[status].[H1].[status].&[Closed]'];
    await render(fixture);
    const remove = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-row .form-remove-row-btn') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    expect(remove.querySelector('svg')).toBeTruthy();                         // trash SVG, reused from the detail header
    expect(remove.textContent?.trim()).not.toBe('✕');                         // not the old text glyph
  });

  it('(Item 3) the trash button shows on a SOLE condition row (no hidden control — "always show trash")', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];       // exactly one row
    await render(fixture);
    const removes = fixture.nativeElement.querySelectorAll('[data-testid="kpi-conditions-section"] .condition-row .form-remove-row-btn');
    expect(removes.length).toBe(1);                                           // visible even though it is the only row
    expect((removes[0] as HTMLElement).querySelector('svg')).toBeTruthy();     // the trash SVG
  });

  it('removing the SOLE condition row clears it back to the drop-zone instead of leaving the section rowless', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    component['freeTextRows'].add(component['rowKey']('kpi', 0));               // seed per-row state to prove it is dropped
    component.removeKpiCondition(0);                                          // queues confirm
    component.runConfirmPrompt();                                            // user confirms
    expect(component.form.kpiConditions.length).toBe(1);                      // still one row (never rowless)
    expect(component.form.kpiConditions[0]).toBe('');                         // …cleared to the empty drop-zone
    expect(component['freeTextRows'].has(component['rowKey']('kpi', 0))).toBe(false); // its free-text state dropped
  });

  it('removing one of MANY condition rows still splices it out (not merely cleared)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[s].[H1].[s].&[Active]', '[s].[H1].[s].&[Closed]'];
    component.removeKpiCondition(0);
    component.runConfirmPrompt();
    expect(component.form.kpiConditions).toEqual(['[s].[H1].[s].&[Closed]']);  // row spliced, survivor shifted up
  });

  it('(Item 3) the trash button shows on a SOLE dimension row (parity with conditions)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();                                   // emptyForm seeds exactly one dimension row
    await render(fixture);
    const removes = fixture.nativeElement.querySelectorAll('.dim-row .form-remove-row-btn');
    expect(removes.length).toBe(1);                            // visible even though it is the only row
    expect((removes[0] as HTMLElement).querySelector('svg')).toBeTruthy();   // the trash SVG
  });

  it('(Item 3) removing the SOLE dimension row clears it instead of leaving the section rowless', () => {
    const { component } = setup();
    component.openNewForm();
    component.form.dimensions = [{ name: 'carrier', label: 'Carrier', cubeDimension: '[carrier].[H1].[carrier]' }];
    component.removeDimension(0);                              // queues confirm
    component.runConfirmPrompt();                              // user confirms
    expect(component.form.dimensions.length).toBe(1);          // still one row (never rowless)
    expect(component.form.dimensions[0]).toEqual({ name: '', label: '', cubeDimension: '' }); // cleared to empty
  });

  it('(Item 3) removing one of MANY dimension rows still splices it out', () => {
    const { component } = setup();
    component.openNewForm();
    component.form.dimensions = [
      { name: 'carrier', label: 'Carrier', cubeDimension: '[carrier].[H1].[carrier]' },
      { name: 'region', label: 'Region', cubeDimension: '[region].[H1].[region]' },
    ];
    component.removeDimension(0);
    component.runConfirmPrompt();
    expect(component.form.dimensions).toEqual([
      { name: 'region', label: 'Region', cubeDimension: '[region].[H1].[region]' },
    ]);                                                        // row spliced, survivor shifted up
  });

  it('(Item 1) a DeepSee KPI with NO conditions now submits (conditions not required)', () => {
    const { component, kpiApi } = setup();
    component.openNewForm();
    component.form.name = 'Universe count';
    component.form.cube = 'ProductInventoryCube';   // cube + valueType guards remain
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'raw';
    component.form.kpiConditions = [''];            // the empty seed row — no member
    component.submit();
    expect(component.formError).toBe('');                        // validateForSubmit no longer bails on empty conditions
    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1); // shipped to the API
    const def = (kpiApi.createKpiDefinition.mock.calls[0] as any[])[0];
    expect(def.deepseeKpiSpec?.kpiConditions ?? []).toEqual([]); // empty section serialized to []
  });

  it('(Item 1) a percentage KPI with no base condition submits (empty denominator allowed — Karsten scope)', () => {
    const { component, kpiApi } = setup();
    component.openNewForm();
    component.form.name = 'Pct no denom';
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'percentage';
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]']; // numerator present, complete
    component.form.baseConditions = [''];                                // NO denominator
    component.submit();
    expect(component.formError).toBe('');                        // the base-required guard is gone
    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1);
  });

  it('(Item 1) the KPI and Base condition titles carry NO required (*) marker', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    await render(fixture);
    const kpiTitle = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .form-section-title');
    expect(kpiTitle.querySelector('.required')).toBeNull();      // KPI Conditions: no '*'
    component.form.valueType = 'percentage';       // Base is only present for percentage (item 2)
    await render(fixture);
    const baseTitle = fixture.nativeElement.querySelector('[data-testid="base-conditions-section"] .form-section-title');
    expect(baseTitle.querySelector('.required')).toBeNull();     // Base Conditions: no '*'
  });

  it('(b) the guided chip surfaces the raw MDX on hover via [data-tooltip] on the .condition-face anchor', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    await render(fixture);
    const face = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row .condition-face') as HTMLElement;
    expect(face).toBeTruthy();                                                  // the shared axGuide/focus anchor
    expect(face.getAttribute('data-tooltip')).toBe('[status].[H1].[status].&[Active]'); // raw MDX on hover
  });

  it('(c) a FREE-TEXT row renders the editable raw-MDX input plus a "Use guided" control', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    component.toggleFreeText('kpi', 0);                          // → free-text escape hatch
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const input = row.querySelector('.condition-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.readOnly).toBe(false);                          // editable (the safety net)
    // The way back to guided is a labelled control, pressed-state on the same pencil toggle.
    const toggle = row.querySelector('.condition-mdx-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');    // pressed = currently in free-text
    expect(toggle.getAttribute('data-tooltip')).toBe('Use guided');
    // In free-text mode the guided chip subject is not shown (the input takes the row).
    expect(row.querySelector('.condition-chip')).toBeNull();
  });

  it('(c) typing in the free-text input writes back to the slot (ngModelChange → onFreeTextInput)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [''];
    component.toggleFreeText('kpi', 0);                          // → free-text escape hatch
    await render(fixture);
    const input = fixture.nativeElement.querySelector(
      '[data-testid="kpi-conditions-section"] .condition-rows .condition-row .condition-input',
    ) as HTMLInputElement;
    input.value = '[status].[H1].[status].&[Active]';
    input.dispatchEvent(new Event('input'));                     // drives ngModelChange → onFreeTextInput
    await fixture.whenStable();
    // Write-back preserved by the [ngModel]+(ngModelChange) split; the offer-clear on this path is pinned
    // directly by "a free-text raw rewrite clears a live merge offer" (onFreeTextInput unit test above).
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[Active]');
  });

  // Section order (Karsten call, 2026-09-03): Base Conditions renders ABOVE KPI Conditions. Rationale —
  // Base is the denominator (the whole population) and KPI narrows it (the numerator), so "whole, then
  // part" reads correctly. Both sections carry stable data-testid markers, so every other test is
  // order-independent; this is the one test that pins the order itself. Base is only present for a
  // percentage KPI (SC-2704 hides it for raw), so set valueType=percentage before asserting the order.
  it('renders the Base Conditions section ABOVE the KPI Conditions section (denominator-then-numerator)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.valueType = 'percentage';      // Base is only present for percentage (SC-2704, item 2)
    await render(fixture);
    const sections = Array.from(
      fixture.nativeElement.querySelectorAll('.kpi-conditions-main [data-testid$="-conditions-section"]'),
    ) as HTMLElement[];
    const order = sections.map((s) => s.getAttribute('data-testid'));
    expect(order).toEqual(['base-conditions-section', 'kpi-conditions-section']);
  });

  // SC-2704 (item 2): Base Conditions is HIDDEN for a raw KPI, not present-but-disabled (reverses the
  // round-8 amendment). Rationale: raw is the uncommon Value Type, so the Base/denominator section is
  // shown only for percentage to declutter the common (default raw) case.
  it('with valueType=raw the Base Conditions section is ABSENT from the DOM (hidden, not disabled)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.baseConditions = ['[status].[H1].[status].&[Active]']; // even with content, raw hides it
    component.form.valueType = 'raw';            // showBaseConditions === false
    await render(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="base-conditions-section"]')).toBeNull(); // removed
    expect(fixture.nativeElement.querySelector('.form-section-disabled-note')).toBeNull();             // no note either
  });

  it('toggling valueType to percentage makes the Base Conditions section APPEAR (absent for raw)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.baseConditions = ['[status].[H1].[status].&[Active]']; // filled → a chip with an operator
    component.form.valueType = 'raw';
    await render(fixture);
    const section = () => fixture.nativeElement.querySelector('[data-testid="base-conditions-section"]');
    expect(section()).toBeNull();                              // absent while raw
    component.form.valueType = 'percentage';     // showBaseConditions === true
    await render(fixture);
    expect(section()).toBeTruthy();                            // the field comes back
    const op = section().querySelector('.condition-operator') as HTMLSelectElement;
    expect(op.disabled).toBe(false);                           // present AND editable (no disabled scaffolding)
  });

  it('the payload guard holds: a raw KPI with stale baseConditions still emits none (presentational only)', () => {
    const { component } = setup();
    component.openNewForm();
    component.form.valueType = 'raw';
    component.form.baseConditions = ['[status].[H1].[status].&[Stale]']; // left over from a prior percentage edit
    const def = (component as any)['formToDefinition']();
    expect(def.deepseeKpiSpec?.baseConditions ?? []).toEqual([]);        // never sent for a raw KPI
  });

  // Chip redesign (§7 amendment): a LEVEL-LESS row has no operator to disable — it is the drop-zone,
  // whose prompt IS the "place a member first" guidance. Once a member is placed the row becomes a
  // guided chip with an ENABLED operator. (The programmatic setConditionOperator level-less guard is
  // still covered by the method test '(§230)' above; this is the DOM transition.)
  it('a level-less row shows the level-select (not an operator); placing a member yields an enabled chip operator', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [''];         // level-less → level-select only, no operator control
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    expect(row.querySelector('.condition-operator')).toBeNull();               // no operator control yet
    expect(row.querySelector('select.condition-level-select')).toBeTruthy();   // level dropdown shown
    // place a member → level established → the row becomes a guided chip with an enabled operator
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    await render(fixture);
    const kpiRow = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const op = kpiRow.querySelector('.condition-operator') as HTMLSelectElement;
    expect(op).toBeTruthy();
    expect(op.disabled).toBe(false);
  });

  // The [axGuide]+(focus) anchor moved from .condition-input to the always-present .condition-face
  // (the chip redesign — a guided row no longer has a text input). The free-text escape hatch still
  // exposes the editable raw-MDX .condition-input.
  it('the .condition-face anchor is always present in guided mode; toggleFreeText reveals the editable input', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]']; // canonical → guided chip
    await render(fixture);
    const row = () => fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    expect(row().querySelector('.condition-face')).toBeTruthy();               // guided anchor present
    expect(row().querySelector('.condition-input')).toBeNull();                // no text input in guided mode
    component.toggleFreeText('kpi', 0);            // → free-text escape hatch
    await render(fixture);
    const input = row().querySelector('.condition-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.readOnly).toBe(false);            // editable raw MDX
  });

  // B-PLAN-01: the assistant "what changed" cue must fire on a GUIDED (non-free-text) condition — not
  // only on free-text rows. The [axGuide] anchor moved to the always-present .condition-face (the chip
  // redesign — a guided row has no text input); an assistant ui_set_field write of a CANONICAL string
  // parses (so the row is a guided chip, NOT free-text), and the GuideHighlightDirective must still
  // toggle .guided-changed on that live element.
  it('an assistant ui_set_field write to a canonical (guided, non-free-text) condition flashes guided-changed', async () => {
    const { component, fixture, bridge } = setup();
    component.openNewForm();
    await render(fixture);
    // Assistant fills the flat slot with a canonical string via the real bridge seam.
    await bridge.applyDirective({ action: 'set_field', target: 'kpiConditions.0', value: '[status].[H1].[status].&[Active]' });
    fixture.detectChanges();
    // The row is guided (canonical parses → NOT free-text), yet the axGuide anchor is present and lit.
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);
    const face = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row .condition-face');
    expect(face).toBeTruthy();                                    // anchor is the always-present chip face
    expect(bridge.changedFields().has('kpiConditions.0')).toBe(true);
    fixture.detectChanges();                                      // flushes the directive's effect() (B-IMPL-03: the prior TestBed.tick() here was redundant)
    expect(face.classList.contains('guided-changed')).toBe(true); // cue fires on a guided condition
  });

  // SC-2662 AC#2 (Guided mode): a full guided fill must serialize a saveable, NON-BLANK DeepSee KPI.
  // Asserted on the PUBLIC submit() surface (TDD check 3): submit() builds the def, validates, and —
  // when valid — calls kpiApi.createKpiDefinition(def). The payload that fake receives IS the public
  // evidence the guided fill serialized non-blank; if the reshaped form ever failed to serialize the
  // guided condition, validateForSubmit would set formError and short-circuit submit() before the call.
  it('AC#2 (Guided): a full guided fill submits a saveable, non-blank DeepSee KPI (public surface)', async () => {
    const { component, bridge, kpiApi } = setup();
    component.openNewForm();
    await setField(bridge, 'name', 'Late Orders');
    await setField(bridge, 'cube', 'ProductInventoryCube');
    await setField(bridge, 'kpiMeasure', 'AvailableQuantity');
    await setField(bridge, 'valueType', 'raw');
    await setField(bridge, 'kpiConditions.0', '[status].[H1].[status].&[Active]'); // a composeCondition('is') string
    await setField(bridge, 'dimensions.0.cubeDimension', '[status].[H1].[status]');

    component.submit();   // PUBLIC entry: builds the def, validates, and (since valid) calls createKpiDefinition

    // The guided fill produced a valid, non-blank DeepSee KPI: submit did NOT bail on validation
    // (no formError) and shipped a populated spec to the API.
    expect(component.formError).toBe('');                       // validateForSubmit passed (else submit() sets this + returns)
    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1);
    // The fake is vi.fn(() => of({})) with no declared params, so .mock.calls is typed as [][];
    // cast to read the def argument submit() shipped.
    const def = (kpiApi.createKpiDefinition.mock.calls[0] as any[])[0];
    expect(def.type).toBe('DeepSee');
    expect(def.deepseeKpiSpec?.cube).toBe('ProductInventoryCube');
    expect(def.deepseeKpiSpec?.kpiConditions).toEqual(['[status].[H1].[status].&[Active]']); // non-blank conditions
  });
});

/**
 * Member dropdown (Karsten call, 2026-09-03): the `is` chip's member is a DROPDOWN of that level's
 * members (fetched from the cube via the same getCubeMembers the tree uses), not a static caption. This
 * makes the value selectable IN PLACE — the reported `is → null → is` dead-end (the member key was
 * physically dropped from the flat slot and the only way back was the tree) is gone. An `is` row with no
 * member chosen is represented by the `[level].&[]` empty-key shape (parses as guided, key=''), an
 * unambiguous "incomplete" sentinel that BLOCKS save so it never reaches IRIS.
 */
describe('KPI guided condition member dropdown (SC-2666 / I1 — Karsten 2026-09-03)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  // Seed a cube whose product level has real members, so the dropdown has options to show.
  const withMembers = () => {
    const s = setup();
    s.dashboardChart.getCubeMembers.mockReturnValue(of({ members: [
      { name: 'Battery', key: 'Battery', caption: 'Battery' },
      { name: 'Cable', key: 'Cable', caption: 'Cable' },
    ] }));
    return s;
  };

  it('conditionMemberOptions returns the placed level’s members (fetched from the cube)', async () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    // an `is` row on the productCategory level
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]'];
    await new Promise((r) => setTimeout(r));       // let the eager member fetch resolve
    const opts = component.conditionMemberOptions('kpi', 0).map((m) => m.name);
    expect(opts).toEqual(['Battery', 'Cable']);
  });

  it('conditionMemberOptions excludes the <null> bucket (Item 2: (no value) is not offered)', async () => {
    const s = setup();
    s.dashboardChart.getCubeMembers.mockReturnValue(of({ members: [
      { name: 'Battery', key: 'Battery', caption: 'Battery' },
      { name: '<null>', key: '<null>' },
    ] }));
    s.component.openNewForm();
    s.component.form.cube = 'ProductInventoryCube';
    s.component['loadCubeMetadata']('ProductInventoryCube');
    await s.component['cubeMetaLoading'];
    s.component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]'];
    await new Promise((r) => setTimeout(r));
    const keys = s.component.conditionMemberOptions('kpi', 0).map((m) => m.key ?? m.name);
    expect(keys).toContain('Battery');
    expect(keys).not.toContain('<null>');
  });

  it('conditionSetSummary still reads a STORED <null> as (no value) though it is no longer offered', async () => {
    const s = withMembers();
    s.component.openNewForm();
    s.component.form.kpiConditions =
      ['{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[<null>]}'];
    await new Promise((r) => setTimeout(r));
    expect(s.component.conditionSetSummary('kpi', 0)).toContain('(no value)');   // Battery, (no value)
  });

  it('selectConditionMember recomposes the slot to the chosen member’s canonical key ref', () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]'];
    component.selectConditionMember('kpi', 0, 'Cable');
    expect(component.form.kpiConditions[0]).toBe('[product].[H1].[productCategory].&[Cable]');
  });

  it('conditionMemberListId is a stable per-row id distinct across list and index', () => {
    const { component } = withMembers();
    component.openNewForm();
    expect(component.conditionMemberListId('kpi', 0)).toBe('cond-members-kpi-0');
    expect(component.conditionMemberListId('base', 0)).not.toBe(component.conditionMemberListId('kpi', 0));
    expect(component.conditionMemberListId('kpi', 1)).not.toBe(component.conditionMemberListId('kpi', 0));
  });

  it('a TYPED single-member value composes the canonical [lvl].&[key] via the shared path (selectConditionMember)', () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[]'];   // is, level set, no member
    component.selectConditionMember('kpi', 0, 'Nowhere');                       // a value NOT in the member list
    expect(component.form.kpiConditions[0]).toBe('[product].[H1].[productCategory].&[Nowhere]');
  });

  it('addTypedSetMember adds a typed value to a set row via toggleConditionMember (trimmed; empty is a no-op)', () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.kpiConditions = ['{[product].[H1].[productCategory].&[Battery]}'];  // isOneOf {Battery}
    component.addTypedSetMember('kpi', 0, '  Widget  ');                               // typed, surrounded by spaces
    expect(component.form.kpiConditions[0])
      .toBe('{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[Widget]}');
    const before = component.form.kpiConditions[0];
    component.addTypedSetMember('kpi', 0, '   ');                                      // whitespace only
    expect(component.form.kpiConditions[0]).toBe(before);                             // no-op
  });

  // THE reported bug: is → null → is must let the user re-pick, not strand the row.
  it('is → null → is leaves an incomplete-but-guided row whose member dropdown can re-select a value', () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]']; // is Battery
    component.setConditionOperator('kpi', 0, 'isNull');
    expect(component.form.kpiConditions[0]).toBe('[product].[H1].[productCategory].&[<null>]');
    component.setConditionOperator('kpi', 0, 'is');
    // Back to `is`: the row stays GUIDED (not free-text), keeps its level, and is INCOMPLETE (no member yet) —
    // represented by the empty-key sentinel, NOT the old dead no-op that left it stuck on isNull.
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);
    expect(component.conditionOperator('kpi', 0)).toBe('is');
    expect(component.conditionHasLevel('kpi', 0)).toBe(true);
    expect(component.conditionMemberKey('kpi', 0)).toBe('');        // "Select…" state
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);
    // the dropdown can now fill it in place — no trip back to the tree
    component.selectConditionMember('kpi', 0, 'Cable');
    expect(component.form.kpiConditions[0]).toBe('[product].[H1].[productCategory].&[Cable]');
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(false);
  });

  it('an incomplete `is` row (no member chosen) blocks submit with a clear message', () => {
    const { component, kpiApi } = withMembers();
    component.openNewForm();
    component.form.name = 'Incomplete KPI';
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'raw';
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[]']; // is, level set, NO member
    component.submit();
    expect(component.formError).toMatch(/member|select|incomplete/i);       // told what's wrong
    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();               // never shipped to IRIS
  });

  it('(DOM) the guided `is` chip renders a member combobox bound to its datalist, one option per member', async () => {
    const { component, fixture } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]'];
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const combobox = row.querySelector('input.condition-member-combobox') as HTMLInputElement;
    expect(combobox).toBeTruthy();                                            // a combobox, not a static caption
    const listId = combobox.getAttribute('list');
    const datalist = row.querySelector(`datalist#${listId}`) as HTMLDataListElement;
    expect(datalist).toBeTruthy();                                            // wired to its own datalist
    const optionTexts = Array.from(datalist.querySelectorAll('option')).map((o) => o.textContent?.trim());
    expect(optionTexts).toContain('Battery');
    expect(optionTexts).toContain('Cable');
    expect(row.querySelector('.condition-member')).toBeNull();                // no static caption span
  });

  it('the member combobox is not shown for an isNull row (only `is` takes a member)', async () => {
    const { component, fixture } = withMembers();
    component.openNewForm();
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[<null>]']; // isNull
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    expect(row.querySelector('input.condition-member-combobox')).toBeNull();
  });

  it('(DOM) the member combobox does NOT offer the null bucket as a selectable option', async () => {
    // A level whose members include IRIS's null bucket (name/key = "<null>", no nullReplacement).
    const s = setup();
    s.dashboardChart.getCubeMembers.mockReturnValue(of({ members: [
      { name: 'Battery', key: 'Battery', caption: 'Battery' },
      { name: '<null>', key: '<null>' },
    ] }));
    s.component.openNewForm();
    s.component.form.cube = 'ProductInventoryCube';
    s.component['loadCubeMetadata']('ProductInventoryCube');
    await s.component['cubeMetaLoading'];
    s.component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]'];
    await new Promise((r) => setTimeout(r));
    await render(s.fixture);
    const row = s.fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const combobox = row.querySelector('input.condition-member-combobox') as HTMLInputElement;
    const datalist = row.querySelector(`datalist#${combobox.getAttribute('list')}`) as HTMLDataListElement;
    const optionTexts = Array.from(datalist.querySelectorAll('option')).map((o) => o.textContent?.trim());
    expect(optionTexts).not.toContain('(no value)');   // Item 2: the null bucket is not offered
    expect(optionTexts).not.toContain('<null>');        // and never the raw token (unchanged from before)
  });

  it('conditionSetChoices unions offered members with selected typed values (so a typed value is de-selectable)', async () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    // isOneOf {Battery (a live member), Android (a value the user TYPED — not in the live list)}
    component.form.kpiConditions =
      ['{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[Android]}'];
    await new Promise((r) => setTimeout(r));
    const keys = component.conditionSetChoices('kpi', 0).map((m) => m.key ?? m.name);
    expect(keys).toContain('Battery');   // an offered live member
    expect(keys).toContain('Cable');     // the other offered live member
    expect(keys).toContain('Android');   // the typed value, now present as a de-selectable row
  });

  it('conditionSetChoices offers a STORED <null>-in-set as a de-selectable row without re-OFFERING it (Item 2 filters only NEW adds)', async () => {
    // A set typed by hand or a loaded KPI can legitimately contain the null bucket (design §6.2). Item 2
    // stops it being newly OFFERED (no combobox add), but an ALREADY-selected null must still show a
    // checkbox so the guided builder can remove it — otherwise the only exit is raw MDX, which Item 1
    // exists to avoid. It must NOT reappear among the offered live members (still filtered there).
    const { component } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    // isOneOf {Battery (a live member), <null> (the stored null bucket)}
    component.form.kpiConditions =
      ['{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[<null>]}'];
    await new Promise((r) => setTimeout(r));
    const choices = component.conditionSetChoices('kpi', 0);
    const keys = choices.map((m) => m.key ?? m.name);
    expect(keys).toContain('<null>');    // the stored null now has a de-selectable row
    expect(component.conditionMemberLabel(choices.find((m) => (m.key ?? m.name) === '<null>')!))
      .toBe('(no value)');               // and it reads friendly, never the raw token
    // still NOT re-offered as a newly-addable live member (Item 2 unchanged)
    expect(component.conditionMemberOptions('kpi', 0).map((m) => m.key ?? m.name)).not.toContain('<null>');
  });

  it('(DOM) a STORED <null> in a set renders a checked (no value) row that unticks to remove it', async () => {
    const { component, fixture } = withMembers();
    // A member set `{…}` (isOneOf) is 1.8.0-only, gated off by default. This test asserts the guided
    // checklist that the gate suppresses, so enable the lane (see mdx-feature-flags).
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions =
      ['{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[<null>]}'];
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const labels = Array.from(row.querySelectorAll('.condition-member-checklist li label')) as HTMLElement[];
    const noValue = labels.find((l) => l.textContent?.includes('(no value)'));
    expect(noValue).toBeTruthy();                                           // the null bucket has its OWN row
    const cb = noValue!.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));               // untick the null
    expect(component.form.kpiConditions[0]).toBe('{[product].[H1].[productCategory].&[Battery]}');
  });

  it('(DOM) a TYPED set value renders as a checked, de-selectable row (not strandable in the MDX)', async () => {
    const { component, fixture } = withMembers();
    // A member set `{…}` (isOneOf) is 1.8.0-only, gated off by default; enable the lane to assert its checklist.
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['{[product].[H1].[productCategory].&[Battery]}']; // isOneOf {Battery}
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const addInput = row.querySelector('input.condition-member-add-input') as HTMLInputElement;
    addInput.value = 'Android';                                             // type a value NOT in the live list
    addInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await render(fixture);
    // the typed value now has its OWN checked checkbox row — no raw-MDX detour needed to remove it
    const labels = Array.from(row.querySelectorAll('.condition-member-checklist li label')) as HTMLElement[];
    const android = labels.find((l) => l.textContent?.includes('Android'));
    expect(android).toBeTruthy();
    const cb = android!.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));               // untick it
    expect(component.form.kpiConditions[0]).toBe('{[product].[H1].[productCategory].&[Battery]}');
  });

  it('(DOM) a typed set value keeps a STABLE node identity across re-render (trackBy) so its checkbox stays clickable', async () => {
    // Live-repro: the user could not de-select a TYPED value ("Android") though offered live members
    // worked. Cause: conditionSetChoices mints a FRESH {name,key} literal for typed extras every call,
    // while offered members keep their cached identity. With no trackBy on the checklist *ngFor, each CD
    // pass destroys+recreates ONLY the typed <li>, so the checkbox the user clicks is swapped out from
    // under the pointer and the click is dropped. This pins the <li> identity so it survives an
    // intervening CD (which zoneless fires on any interaction), and confirms the untick still commits.
    const { component, fixture } = withMembers();
    // A member set `{…}` (isOneOf) is 1.8.0-only, gated off by default; enable the lane to assert its checklist.
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    // isOneOf {Battery (offered), Android (typed — not a live member)}
    component.form.kpiConditions =
      ['{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[Android]}'];
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const liOf = (name: string) => (Array.from(row.querySelectorAll('.condition-member-checklist li label')) as HTMLElement[])
      .find((l) => l.textContent?.includes(name))?.closest('li') as HTMLElement | undefined;
    const androidLi1 = liOf('Android');
    expect(androidLi1).toBeTruthy();
    await render(fixture);                                   // an intervening CD cycle — nothing changed
    const androidLi2 = liOf('Android');
    expect(androidLi2).toBe(androidLi1);                     // SAME node — not churned (fails without trackBy)
    // and the untick, dispatched on the node that survived, still removes exactly the typed member
    const cb = androidLi2!.querySelector('input[type=checkbox]') as HTMLInputElement;
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(component.form.kpiConditions[0]).toBe('{[product].[H1].[productCategory].&[Battery]}');
  });

  it('(DOM) a set popup accepts a TYPED value via its add-row Enter key (adds it to the set)', async () => {
    const { component, fixture } = withMembers();
    // A member set `{…}` (isOneOf) is 1.8.0-only, gated off by default; enable the lane to assert its checklist.
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['{[product].[H1].[productCategory].&[Battery]}']; // isOneOf {Battery}
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const addInput = row.querySelector('input.condition-member-add-input') as HTMLInputElement;
    expect(addInput).toBeTruthy();                                            // the type-to-add row exists
    addInput.value = 'Widget';                                               // a value NOT in the live member list
    addInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(component.form.kpiConditions[0])
      .toBe('{[product].[H1].[productCategory].&[Battery],[product].[H1].[productCategory].&[Widget]}');
    expect(addInput.value).toBe('');                                         // input clears after adding
  });

  it('(DOM) a typed non-member surfaces the ⚠ advisory but never blocks submit', async () => {
    const { component, fixture, kpiApi } = withMembers();
    component.openNewForm();
    component.form.name = 'Typed KPI';
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'raw';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Nowhere]']; // typed, not a live member
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const warn = row.querySelector('.condition-warning-icon') as HTMLElement;
    expect(warn).toBeTruthy();                                                // advisory shows (quiet icon)
    expect(warn.getAttribute('aria-label')).toContain('not a current value'); // full text on the icon
    component.submit();
    expect(kpiApi.createKpiDefinition).toHaveBeenCalled();                    // advisory did NOT block submit
  });
});

describe('KPI condition analyzer wiring (SC-2666 A+B+C)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('surfaces a contradiction diagnostic on both offending rows and never blocks submit', async () => {
    const { component } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]', '[c].[H1].[cat].&[CPU]'];
    expect(component.rowDiagnostics('kpi', 0).some((d) => d.kind === 'contradiction')).toBe(true);
    expect(component.rowDiagnostics('kpi', 1).some((d) => d.kind === 'contradiction')).toBe(true);
    // advisory only: both rows are COMPLETE (each is a valid single-member `is`), so the analyzer's
    // finding contributes nothing to the submit-blocking path — hasIncompleteCondition stays false.
    expect(component['hasIncompleteCondition']('kpi')).toBe(false);
  });

  it('is silent across the KPI and Base lists (two separate universes)', () => {
    const { component } = setup();
    component.form.valueType = 'percentage';
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]'];
    component.form.baseConditions = ['[c].[H1].[cat].&[CPU]'];   // disjoint, but a DIFFERENT list
    expect(component.rowDiagnostics('kpi', 0)).toEqual([]);
    expect(component.rowDiagnostics('base', 0)).toEqual([]);
  });

  it('renders an inline ⚠ marker on a contradictory row, keyboard-focusable and screen-reader exposed', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]', '[c].[H1].[cat].&[CPU]'];
    await render(fixture);
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="kpi-conditions-section"] .condition-row');
    const warn = rows[0].querySelector('.condition-warning-icon') as HTMLElement;
    expect(warn).toBeTruthy();
    expect(warn.getAttribute('tabindex')).toBe('0');                 // keyboard-reachable
    expect(warn.getAttribute('aria-label')).toContain('count 0');    // full text on the icon's aria-label
  });
});

describe('KPI condition warnings (quiet icon + toast-on-edit)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  // Seed a cube whose product level has real members, so a typed non-member fires an `unknownMember` diagnostic.
  const withMembers = () => {
    const s = setup();
    s.dashboardChart.getCubeMembers.mockReturnValue(of({ members: [
      { name: 'Battery', key: 'Battery', caption: 'Battery' },
      { name: 'Cable', key: 'Cable', caption: 'Cable' },
    ] }));
    return s;
  };

  // A 1.8.0-only free-text form (flag OFF by default → v180 channel active); the constant body means the
  // v180 message is byte-identical every time, which the "no re-toast" test relies on.
  const V180 = 'EXCEPT([product].[H1].[productFamily].MEMBERS,{[product].[H1].[productFamily].&[Phones]})';

  // ---- warningActive / warningMessage: the quiet-icon state (no stored dismissal) ----
  it('warningActive(diag) tracks the row diagnostic and warningMessage returns its text', async () => {
    const { component } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Nowhere]']; // typed non-member → unknownMember
    await new Promise((r) => setTimeout(r));
    expect(component.warningActive('kpi', 0, 'diag')).toBe(true);
    expect(component.warningMessage('kpi', 0, 'diag')).toContain('not a current value');
  });

  it('warningActive(v180) fires for a free-text 1.8.0-only form (flag off) and messages it', () => {
    const { component } = setup();
    component.openNewForm();
    component.form.kpiConditions = [V180];
    expect(component.conditionIsFreeText('kpi', 0)).toBe(true);
    expect(component.conditionUsesAdvancedMdx('kpi', 0)).toBe(true);
    expect(component.warningActive('kpi', 0, 'v180')).toBe(true);
    expect(component.warningMessage('kpi', 0, 'v180')).toContain('requires SCO 1.8.0');
  });

  it('warningActive is false / warningMessage empty for a clean guided row', () => {
    const { component } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];        // clean guided row, no warnings
    expect(component.warningActive('kpi', 0, 'diag')).toBe(false);
    expect(component.warningActive('kpi', 0, 'v180')).toBe(false);
    expect(component.warningMessage('kpi', 0, 'diag')).toBe('');
    expect(component.warningMessage('kpi', 0, 'v180')).toBe('');
  });

  it('warningActive(v180) is off once the 1.8.0 flag is on', () => {
    const { component } = setup();
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.kpiConditions = [V180];
    expect(component.warningActive('kpi', 0, 'v180')).toBe(false);
  });

  // ---- toast-on-edit: the LOUD text fires ONLY when a direct edit newly triggers a warning ----
  it('a direct edit that introduces a warning fires exactly one warning toast', () => {
    const { component, toasts } = setup();
    component.openNewForm();
    component.onFreeTextInput('kpi', 0, V180);   // escape-hatch write choke point
    expect(component.warningActive('kpi', 0, 'v180')).toBe(true);
    expect(toasts.warning).toHaveBeenCalledTimes(1);
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringContaining('requires SCO 1.8.0'));
  });

  it('re-editing a row that STILL has the same warning does not re-toast', () => {
    const { component, toasts } = setup();
    component.openNewForm();
    component.onFreeTextInput('kpi', 0, V180);
    expect(toasts.warning).toHaveBeenCalledTimes(1);
    toasts.warning.mockClear();
    // a further edit that leaves an equivalent 1.8.0-only form in place — same v180 message, so no new toast
    component.onFreeTextInput('kpi', 0, V180 + ' '); // trailing space: still the same advanced form + message
    expect(component.warningActive('kpi', 0, 'v180')).toBe(true);
    expect(toasts.warning).not.toHaveBeenCalled();
  });

  it('editing the problem away, then back, re-toasts (message left the active set and returned)', () => {
    const { component, toasts } = setup();
    component.openNewForm();
    component.onFreeTextInput('kpi', 0, V180);
    expect(toasts.warning).toHaveBeenCalledTimes(1);
    component.onFreeTextInput('kpi', 0, '[status].[H1].[status].&[Active]');   // clean guided → warning clears
    expect(component.warningActive('kpi', 0, 'v180')).toBe(false);
    component.onFreeTextInput('kpi', 0, V180);
    expect(toasts.warning).toHaveBeenCalledTimes(2);                          // re-fired
  });

  it('a DIFFERENT bad value re-toasts because the diag message embeds the value', async () => {
    const { component, toasts } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    // seed a guided is-row on the product level (empty-key sentinel), then commit member keys through the choke point
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[]'];
    component.selectConditionMember('kpi', 0, 'Nowhere');   // unknown member → toast #1
    expect(toasts.warning).toHaveBeenCalledTimes(1);
    expect((toasts.warning.mock.calls as any[])[0][0]).toContain('"Nowhere"');
    component.selectConditionMember('kpi', 0, 'Elsewhere'); // DIFFERENT unknown → new message → toast #2
    expect(toasts.warning).toHaveBeenCalledTimes(2);
    expect((toasts.warning.mock.calls as any[])[1][0]).toContain('"Elsewhere"');
  });

  it('no toast fires from merely seeding conditions (no direct edit) — reload shows only the icon', async () => {
    const { component, toasts } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Nowhere]'];  // seeded, not edited
    await new Promise((r) => setTimeout(r));
    expect(component.warningActive('kpi', 0, 'diag')).toBe(true);   // icon is active
    expect(toasts.warning).not.toHaveBeenCalled();                 // but nothing was toasted
  });

  it('base and kpi lists are independent — a base-row edit does not touch the kpi row', () => {
    const { component, toasts } = setup();
    component.openNewForm();
    component.onFreeTextInput('base', 0, V180);
    expect(component.warningActive('base', 0, 'v180')).toBe(true);
    expect(component.warningActive('kpi', 0, 'v180')).toBe(false);
    expect(toasts.warning).toHaveBeenCalledTimes(1);
  });

  // ---- markup wiring: the quiet ⚠ icon is ALWAYS present when active (no dismiss); advisory never blocks submit ----
  it('(DOM) an active warning renders the quiet ⚠ icon with the full text on hover/aria and no dismiss button', async () => {
    const { component, fixture } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Nowhere]'];
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    const row = fixture.nativeElement.querySelector(
      '[data-testid="kpi-conditions-section"] .condition-rows .condition-row',
    ) as HTMLElement;
    const icon = row.querySelector('.condition-warning-icon') as HTMLElement;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('data-tooltip')).toContain('not a current value');   // full text on hover
    expect(icon.getAttribute('aria-label')).toContain('not a current value');     // and to a screen reader
    expect(icon.getAttribute('tabindex')).toBe('0');                              // keyboard-reachable
    expect(row.querySelector('.condition-warning-dismiss')).toBeNull();           // no dismiss in the toast model
    // and it lives on the controls line, not inside the chip
    const chip = row.querySelector('.condition-chip') as HTMLElement;
    expect(chip.contains(icon)).toBe(false);
  });

  it('(DOM) a row with BOTH channels active renders two quiet ⚠ icons', async () => {
    const { component, fixture } = withMembers();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    // A free-text unwrapped-FILTER that is ALSO 1.8.0-only fires both lintFreeTextConditions (diag) and v180.
    component.form.kpiConditions = ['FILTER([product].[H1].[productCategory].MEMBERS,[Measures].[AvailableQuantity]>5)'];
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    expect(component.warningActive('kpi', 0, 'diag')).toBe(true);
    expect(component.warningActive('kpi', 0, 'v180')).toBe(true);
    const row = fixture.nativeElement.querySelector(
      '[data-testid="kpi-conditions-section"] .condition-rows .condition-row',
    ) as HTMLElement;
    expect(row.querySelectorAll('.condition-warning-icon').length).toBe(2);
  });

  it('(DOM) a warning never blocks submit (advisory-only contract preserved)', async () => {
    const { component, fixture, kpiApi } = withMembers();
    component.openNewForm();
    component.form.name = 'Quiet KPI';
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'raw';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Nowhere]'];
    await new Promise((r) => setTimeout(r));
    await render(fixture);
    expect(component.warningActive('kpi', 0, 'diag')).toBe(true);   // warning present
    component.submit();
    expect(kpiApi.createKpiDefinition).toHaveBeenCalled();          // still submits
  });
});

describe('KPI condition AND joiner + first-time hint (SC-2666 A+B+C — Task 5)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('renders a quiet AND joiner between adjacent rows and not above the first', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]', '[c].[H1].[cat].&[CPU]'];
    await render(fixture);
    const joiners = fixture.nativeElement.querySelectorAll('[data-testid="kpi-conditions-section"] .condition-and-joiner');
    expect(joiners.length).toBe(1);                                 // one joiner between two rows
  });

  it('shows the first-time AND hint once a list has two rows', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]'];
    await render(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-and-hint')).toBeNull();
    component.form.kpiConditions = ['[c].[H1].[cat].&[Battery]', '[c].[H1].[cat].&[CPU]'];
    await render(fixture);
    const hint = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-and-hint') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain('is one of');                // teaches the OR alternative
  });
});

describe('KPI condition chip grain cue (SC-2666 A+B+C — Task 6)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('a rollup-level condition chip carries the grain tooltip; a leaf-level chip does not', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productCategory].&[Battery]']; // rollup level
    await render(fixture);
    expect(component.conditionIsRollup('kpi', 0)).toBe(true);
    const chip = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-chip') as HTMLElement;
    expect(chip.querySelector('select.condition-level-select')?.getAttribute('title')).toContain('rolled up');
  });

  it('a leaf-level condition chip has no grain tooltip', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = ['[product].[H1].[productFamily].&[Batteries]']; // leaf level
    await render(fixture);
    expect(component.conditionIsRollup('kpi', 0)).toBe(false);
    const chip = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-chip') as HTMLElement;
    expect(chip.querySelector('select.condition-level-select')?.getAttribute('title')).toBeNull();
  });
});

describe('KPI condition level dropdown (Change 1 — Task 2)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck(); fixture.detectChanges(); await fixture.whenStable();
  };

  it('conditionLevelGroups groups levels by dimension and humanizes captions', async () => {
    const { component } = setup();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    const groups = component.conditionLevelGroups();
    const product = groups.find((g) => g.dimension === 'product');
    // The product dimension carries both its levels, in fixture order, keyed on spec (not caption).
    expect(product?.levels.map((l) => l.spec)).toEqual([
      '[product].[H1].[productCategory]',
      '[product].[H1].[productFamily]',
    ]);
    // The caption 'Product Family' appears under BOTH product and vendor → keyed on spec, never collapsed.
    const specs = groups.flatMap((g) => g.levels.map((l) => l.spec));
    expect(specs).toContain('[product].[H1].[productFamily]');
    expect(specs).toContain('[vendor].[H1].[productFamily]');     // distinct option, same caption
    expect(new Set(specs).size).toBe(specs.length);               // every option value unique
  });

  it('each option label reads humanized "Dimension › Level" from the MDX spec so a repeated level name disambiguates', async () => {
    // Karsten 2026-09-18: the closed <select> shows only the option text, and a level name like
    // "Product Family" / "Status" repeats across dimensions — ambiguous. The label prefixes the
    // dimension so the two colliding "Product Family" options read distinctly, matching what the user
    // sees on hover / in the MDX view. Derived from the SPEC parts (not the caption), humanized.
    const { component } = setup();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    const groups = component.conditionLevelGroups();
    const labelOf = (spec: string) =>
      groups.flatMap((g) => g.levels).find((l) => l.spec === spec)?.label;
    expect(labelOf('[product].[H1].[productFamily]')).toBe('Product › Product Family');
    expect(labelOf('[vendor].[H1].[productFamily]')).toBe('Vendor › Product Family'); // same level, distinct label
    expect(labelOf('[status].[H1].[status]')).toBe('Status › Status');
  });

  it('the option label comes from the MDX spec, not the display caption (matches the MDX view)', async () => {
    // A level whose humanized CAPTION ("Aging Status", Karsten's screenshot) differs from the MDX level
    // name ("status"). The label tracks the MDX ("Expiration Status › Status"), so it lines up with the
    // hover tooltip / MDX view — mixing the UI caption with raw MDX was the confusion we avoid.
    const { component, dashboardChart } = setup();
    dashboardChart.getCubeShape.mockReturnValue(of({
      cube: 'AgingCube', measures: [{ name: 'AvailableQuantity' }],
      dimensions: [{ name: 'expirationStatus', kind: 'categorical', levels: [
        { name: 'status', caption: 'Aging Status', spec: '[expirationStatus].[H1].[status]' },
      ] }],
    }));
    component.form.cube = 'AgingCube';
    component['loadCubeMetadata']('AgingCube');
    await component['cubeMetaLoading'];
    const level = component.conditionLevelGroups().flatMap((g) => g.levels)[0];
    expect(level.label).toBe('Expiration Status › Status');
  });

  it('DOM: the level <option> renders the disambiguating "Dimension › Level" label', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component['loadCubeMetadata']('ProductInventoryCube');
    await component['cubeMetaLoading'];
    component.form.kpiConditions = [''];
    await render(fixture);
    const opts = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="kpi-conditions-section"] select.condition-level-select option'),
    ).map((o: any) => o.textContent.trim());
    expect(opts).toContain('Product › Product Family');
    expect(opts).toContain('Vendor › Product Family');
  });

  it('conditionLevelGroups is [] when the cube shape is not loaded', () => {
    const { component } = setup();
    (component as any).cubeShape = null;
    expect(component.conditionLevelGroups()).toEqual([]);
  });

  it('picking a level on an EMPTY row sets the level, defaults to is, leaves member incomplete', () => {
    const { component } = setup();
    component.form.kpiConditions = [''];
    component.setConditionLevel('kpi', 0, '[status].[H1].[status]');
    expect(component.conditionLevelSpec('kpi', 0)).toBe('[status].[H1].[status]');
    expect(component.conditionOperator('kpi', 0)).toBe('is');
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);   // no member yet → blocks save
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[]'); // guided empty-key sentinel
  });

  it('changing the level on a populated is-row keeps the operator and clears the member (kpi AND base)', () => {
    for (const list of ['kpi', 'base'] as const) {
      const { component } = setup();
      const arr = list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions;
      arr[0] = '[status].[H1].[status].&[Active]';
      component.setConditionLevel(list, 0, '[product].[H1].[productFamily]');
      expect(component.conditionLevelSpec(list, 0)).toBe('[product].[H1].[productFamily]');
      expect(component.conditionOperator(list, 0)).toBe('is');        // operator preserved
      expect((list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions)[0])
        .toBe('[product].[H1].[productFamily].&[]');                   // member reset (no stale key)
    }
  });

  it('changing the level on an is-null row keeps is null on the new level', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[<null>]'];
    expect(component.conditionOperator('kpi', 0)).toBe('isNull');
    component.setConditionLevel('kpi', 0, '[product].[H1].[productFamily]');
    expect(component.form.kpiConditions[0]).toBe('[product].[H1].[productFamily].&[<null>]');
    expect(component.conditionOperator('kpi', 0)).toBe('isNull');
  });

  it('changing the level on an isOneOf {A,B} row drops the members (no stale keys on the new level)', () => {
    const { component } = setup();
    component.form.kpiConditions = ['{[status].[H1].[status].&[A],[status].[H1].[status].&[B]}'];
    component.setConditionLevel('kpi', 0, '[product].[H1].[productFamily]');
    expect(component.conditionMemberKeys('kpi', 0)).toEqual([]);       // A,B not carried over
    expect(component.conditionLevelSpec('kpi', 0)).toBe('[product].[H1].[productFamily]');
  });

  it('re-selecting the placeholder ("") is a guarded no-op', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    component.setConditionLevel('kpi', 0, '');
    expect(component.form.kpiConditions[0]).toBe('[status].[H1].[status].&[Active]'); // unchanged
  });

  it('DOM: the guided chip renders select.condition-level-select, and an empty row shows ONLY the level select', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [''];                              // empty row
    await render(fixture);
    const chip = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-chip');
    expect(chip.querySelector('select.condition-level-select')).toBeTruthy();
    expect(chip.querySelector('span.condition-level')).toBeNull();    // the static caption span is gone
    expect(chip.querySelector('select.condition-operator')).toBeNull(); // level-less → no operator control
    expect(chip.querySelector('.condition-member-combobox')).toBeNull();
    expect(fixture.nativeElement.querySelector('.condition-dropzone')).toBeNull(); // drop-zone prompt removed
  });
});

describe('KPI condition rail removed (Change 2 — Task 3)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck(); fixture.detectChanges(); await fixture.whenStable();
  };

  it('the cube-model tree rail is absent from the KPI form DOM', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';      // trigger cube metadata load
    component.onFormCubeChange();                      // → loadCubeMetadata → sets cubeShape
    await render(fixture);
    expect(fixture.nativeElement.querySelector('app-cube-model-tree')).toBeNull();
    expect(fixture.nativeElement.querySelector('.kpi-cube-tree')).toBeNull();
  });
});

describe('KPI/Base chip parity (the guard that lets the two blocks stay duplicated — Task 5)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck(); fixture.detectChanges(); await fixture.whenStable();
  };
  const controlSet = (row: Element) => ({
    level: !!row.querySelector('select.condition-level-select'),
    operator: !!row.querySelector('select.condition-operator'),
    member: !!row.querySelector('.condition-member-combobox, .condition-member-checkboxes'),
    handle: !!row.querySelector('.condition-drag-handle'),
  });

  it('a populated row exposes the SAME control set in the base chip and the kpi chip', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.valueType = 'percentage';                 // enable base
    component.form.baseConditions = ['[status].[H1].[status].&[Active]'];
    component.form.kpiConditions = ['[status].[H1].[status].&[Active]'];
    await render(fixture);
    const baseRow = fixture.nativeElement.querySelector('[data-testid="base-conditions-section"] .condition-row');
    const kpiRow = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-row');
    expect(controlSet(baseRow)).toEqual(controlSet(kpiRow));
    expect(controlSet(kpiRow)).toEqual({ level: true, operator: true, member: true, handle: true });
  });

  it('an empty row exposes ONLY the level select in both chips', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.valueType = 'percentage';
    component.form.baseConditions = [''];
    component.form.kpiConditions = [''];
    await render(fixture);
    for (const testid of ['base-conditions-section', 'kpi-conditions-section']) {
      const row = fixture.nativeElement.querySelector(`[data-testid="${testid}"] .condition-row`);
      expect(row.querySelector('select.condition-level-select')).toBeTruthy();
      expect(row.querySelector('select.condition-operator')).toBeNull();
      expect(row.querySelector('.condition-member-combobox')).toBeNull();
    }
  });
});

describe('KPI dropdown-only flow composes the right slot (crux, unit — Task 5)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('setConditionLevel then selectConditionMember composes the byte-exact is-slot, with the base %-gate', () => {
    const { component } = setup();
    component.form.valueType = 'raw';
    component.form.kpiConditions = [''];
    component.setConditionLevel('kpi', 0, '[status].[H1].[status]');
    component.selectConditionMember('kpi', 0, 'Active');
    const def = (component as any).formToDefinition();
    expect(def.deepseeKpiSpec.kpiConditions).toEqual(['[status].[H1].[status].&[Active]']);
    // %-gate (formToDefinition, `if (f.valueType === 'percentage')`, kpi.ts:1566-1567):
    // baseConditions is set ONLY under the percentage guard, so a raw KPI OMITS the key entirely
    // (undefined) even when the form array holds some.
    component.form.baseConditions = ['[status].[H1].[status].&[Active]'];
    expect((component as any).formToDefinition().deepseeKpiSpec.baseConditions).toBeUndefined();
    // The other side of the gate: a percentage KPI serializes the filtered array.
    component.form.valueType = 'percentage';
    expect((component as any).formToDefinition().deepseeKpiSpec.baseConditions)
      .toEqual(['[status].[H1].[status].&[Active]']);
  });

  it('a merged isOneOf row serializes the union string', () => {
    const { component } = setup();
    component.form.valueType = 'raw';
    component.form.kpiConditions = [
      '[product].[H1].[productFamily].&[X]', '[product].[H1].[productFamily].&[Y]',
    ];
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 1, dragEvent('drop', dt) as any);
    component.acceptMergeOffer();
    const def = (component as any).formToDefinition();
    expect(def.deepseeKpiSpec.kpiConditions).toEqual([
      '{[product].[H1].[productFamily].&[Y],[product].[H1].[productFamily].&[X]}',
    ]);
  });
});

/**
 * Submit from the DETAIL view (not just the edit form).
 *
 * A KPI saved as a draft has unsubmitted changes, and the user shouldn't have to
 * reopen the form to push them to SCO. The shortcut routes through the form so there
 * is exactly ONE submit path — same validation, same create-vs-update decision, same
 * draft cleanup — which is what these tests pin.
 */
describe('submitSelected — Submit from the KPI detail view', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** A complete, submittable KPI definition (the shape validateForSubmit accepts). */
  function definition(name = 'Late Orders') {
    return {
      name,
      type: 'DeepSee',
      deepseeKpiSpec: {
        cube: 'ProductInventoryCube',
        kpiMeasure: 'AvailableQuantity',
        valueType: 'value',
        kpiConditions: ['[status].[H1].[status].&[Active]'],
      },
    };
  }

  /** A KPI that exists ONLY as a local draft → state 'draft'. */
  function withDraft(name = 'Late Orders') {
    return setup({
      getKpiDefinitions: vi.fn(() => of([])),
      listKpiDrafts: vi.fn(() => of({ drafts: [{ kpiName: name, definition: definition(name) }] })),
    });
  }

  it('offers Submit for a draft and submits it, without the user opening the form', () => {
    const { component, kpiApi } = withDraft();
    component.selectKpi(component.groups[0]!.items[0]!);

    expect(component.submitSelectedHint).toBe('Submit this draft to SCO');
    component.submitSelected();

    // No IRIS counterpart yet, so it CREATES (a PUT would 404).
    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1);
    expect(kpiApi.updateKpiDefinition).not.toHaveBeenCalled();
    expect((kpiApi.createKpiDefinition as any).mock.calls[0][0]).toMatchObject({ name: 'Late Orders' });
    // The local draft is cleaned up, and the form closes back to the detail view.
    expect(kpiApi.deleteKpiDraft).toHaveBeenCalledWith('Late Orders');
    expect(component.formMode).toBeNull();
  });

  it('UPDATES instead of creating when the KPI already exists in SCO', () => {
    const { component, kpiApi } = setup({
      getKpiDefinitions: vi.fn(() => of([definition()])),
      listKpiDrafts: vi.fn(() => of({ drafts: [{ kpiName: 'Late Orders', definition: definition() }] })),
    });
    component.selectKpi(component.groups[0]!.items[0]!);

    component.submitSelected();

    expect(kpiApi.updateKpiDefinition).toHaveBeenCalledTimes(1);
    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();
  });

  it('offers Submit for a CREATED KPI too, and re-submitting updates the live one', () => {
    // Not gated to drafts: pushing a KPI again is a legitimate thing to want (after an
    // out-of-band change, or to confirm what is live matches the definition).
    const { component, kpiApi } = setup({ getKpiDefinitions: vi.fn(() => of([definition()])) });
    component.selectKpi(component.groups[0]!.items[0]!);

    expect(component.selectedKpi?.state).toBe('created');
    // The hint says which of the two submits this is.
    expect(component.submitSelectedHint).toMatch(/Re-submit/);

    component.submitSelected();

    expect(kpiApi.updateKpiDefinition).toHaveBeenCalledTimes(1);
    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();
  });

  it('leaves the user in the form with the error when the draft is incomplete', () => {
    // An invalid draft must not be sent, and the form is where it can be fixed.
    const { component, kpiApi } = setup({
      getKpiDefinitions: vi.fn(() => of([])),
      listKpiDrafts: vi.fn(() => of({ drafts: [{ kpiName: 'Half done', definition: { name: 'Half done', type: 'DeepSee' } }] })),
    });
    component.selectKpi(component.groups[0]!.items[0]!);

    component.submitSelected();

    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();
    expect(component.formMode).toBe('edit');
    expect(component.formError).toBeTruthy();
  });

  it('ignores a second press while a submit is in flight', () => {
    const { component, kpiApi } = withDraft();
    component.selectKpi(component.groups[0]!.items[0]!);
    (component as unknown as { submitting: boolean }).submitting = true;

    component.submitSelected();

    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();
  });
});

/**
 * The list keeps its highlight while a KPI's EDIT form is open, so the user can see which
 * KPI the form belongs to. It is suppressed only for a NEW KPI, which has no row yet.
 */
describe('KPI list highlight during the edit form', () => {
  afterEach(() => TestBed.resetTestingModule());

  function definition(name = 'Late Orders') {
    return {
      name,
      type: 'DeepSee',
      deepseeKpiSpec: {
        cube: 'ProductInventoryCube',
        kpiMeasure: 'AvailableQuantity',
        valueType: 'value',
        kpiConditions: ['[status].[H1].[status].&[Active]'],
      },
    };
  }

  function withOneKpi() {
    return setup({ getKpiDefinitions: vi.fn(() => of([definition()])) });
  }

  function activeRows(fixture: ComponentFixture<KpiComponent>): number {
    return (fixture.nativeElement as HTMLElement).querySelectorAll('.kpi-item--active').length;
  }

  it('highlights the selected KPI on its detail view', () => {
    const { component, fixture } = withOneKpi();
    component.selectKpi(component.groups[0]!.items[0]!);
    fixture.detectChanges();
    expect(activeRows(fixture)).toBe(1);
  });

  it('KEEPS the highlight when its edit form opens', () => {
    const { component, fixture } = withOneKpi();
    component.selectKpi(component.groups[0]!.items[0]!);
    component.openEditForm();
    fixture.detectChanges();

    expect(component.formMode).toBe('edit');
    expect(activeRows(fixture)).toBe(1);
  });

  it('drops it while creating a NEW KPI — no row belongs to that form', () => {
    const { component, fixture } = withOneKpi();
    component.selectKpi(component.groups[0]!.items[0]!);
    component.openNewForm();
    fixture.detectChanges();

    expect(activeRows(fixture)).toBe(0);
  });
});

describe('KPI condition free-text FILTER guard (SC-2701 Option 1)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const BARE_FILTER = 'FILTER([c].[H1].[cat].MEMBERS,[Total]>600)';
  const SAFE_AGG = 'AGGREGATE(FILTER([c].[H1].[cat].MEMBERS,[Total]>600))';

  it('surfaces the ⚠ on a bare-FILTER KPI row, focusable + announced, and never blocks submit', async () => {
    const { component, fixture, kpiApi } = setup();
    component.openNewForm();
    component.form.name = 'Filter KPI';
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'raw';
    component.form.kpiConditions = [BARE_FILTER];
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    const warn = row.querySelector('.condition-warning-icon') as HTMLElement;
    expect(warn).toBeTruthy();
    expect(warn.getAttribute('tabindex')).toBe('0');                                  // keyboard-reachable
    expect(warn.getAttribute('aria-label')).toContain('total of the matching rows');  // full text on the icon
    expect(warn.getAttribute('aria-label')).not.toMatch(/AGGREGATE\s*\(\s*FILTER/i);
    // No "Combine into 'is one of'" action button (kind is not contradiction/orNudge — spec §3.2).
    expect(row.querySelector('.condition-warning-action')).toBeNull();
    component.submit();
    expect(kpiApi.createKpiDefinition).toHaveBeenCalled();                            // advisory did NOT block
  });

  it('does NOT warn on an AGGREGATE(FILTER(...)) KPI row (Option-1 diag lint stays silent)', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'raw';
    component.form.kpiConditions = [SAFE_AGG];
    await render(fixture);
    // The Option-1 lint (diag) must stay silent on a properly-wrapped AGGREGATE(FILTER(...)). (The row is a
    // free-text 1.8.0-only form, so the v180 gate icon is expected and NOT asserted-against here.)
    expect(component.warningActive('kpi', 0, 'diag')).toBe(false);
    const row = fixture.nativeElement.querySelector('[data-testid="kpi-conditions-section"] .condition-rows .condition-row');
    expect(row.querySelector('.condition-warning-action')).toBeNull();
  });

  // Base list mirrors the KPI-list assertions (spec §6.B: "both assertions repeated for the base list").
  // base (kpi.html:378-387) and kpi (:517-526) are separate hand-maintained template blocks, so the
  // base block gets its own warn + no-warn + submit-not-blocked pins — an independent base-block edit
  // (safe AGGREGATE wrongly warning, or a base advisory blocking submit) must not ship green.
  it('applies to the Base list too: ⚠ on a bare-FILTER base row, focusable + announced, never blocks submit', async () => {
    const { component, fixture, kpiApi } = setup();
    component.openNewForm();
    component.form.name = 'Base Filter KPI';
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'percentage';                    // showBaseConditions === true (kpi.ts:1017)
    component.form.kpiConditions = [BARE_FILTER];               // a complete numerator row (submit needs one)
    component.form.baseConditions = [BARE_FILTER];
    await render(fixture);
    const row = fixture.nativeElement.querySelector('[data-testid="base-conditions-section"] .condition-rows .condition-row');
    const warn = row.querySelector('.condition-warning-icon') as HTMLElement;
    expect(warn).toBeTruthy();
    expect(warn.getAttribute('tabindex')).toBe('0');                                  // keyboard-reachable
    expect(warn.getAttribute('aria-label')).toContain('total of the matching rows');  // full text on the icon
    expect(warn.getAttribute('aria-label')).not.toMatch(/AGGREGATE\s*\(\s*FILTER/i);
    expect(row.querySelector('.condition-warning-action')).toBeNull();                // no combine button (spec §3.2)
    component.submit();
    expect(kpiApi.createKpiDefinition).toHaveBeenCalled();                            // base advisory did NOT block
  });

  it('does NOT warn on an AGGREGATE(FILTER(...)) base row (percentage KPI) — Option-1 diag lint stays silent', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    component.form.kpiMeasure = 'AvailableQuantity';
    component.form.valueType = 'percentage';
    component.form.baseConditions = [SAFE_AGG];
    await render(fixture);
    // As above: the Option-1 lint (diag) stays silent; the v180 gate icon on this free-text 1.8.0 form is expected.
    expect(component.warningActive('base', 0, 'diag')).toBe(false);
    const row = fixture.nativeElement.querySelector('[data-testid="base-conditions-section"] .condition-rows .condition-row');
    expect(row.querySelector('.condition-warning-action')).toBeNull();
  });
});

describe('KPI guided aggregate comparison (SC-2701 Option 2)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const render = async (fixture: ComponentFixture<KpiComponent>) => {
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const LVL = '[product].[H1].[productCategory]';
  const MEAS = 'AvailableQuantity';
  const COMPOSED_GT = `AGGREGATE(FILTER(${LVL}.MEMBERS,[Measures].[${MEAS}]>45000000))`;
  const COMPOSED_LT = `AGGREGATE(EXCEPT(${LVL}.MEMBERS,FILTER(${LVL}.MEMBERS,[Measures].[${MEAS}]>=45000000)))`;

  function newFormOnCube(component: KpiComponent) {
    component.openNewForm();
    component.form.cube = 'ProductInventoryCube';
    // Realize the cube-metadata precondition the brief names: formCubeMeasures === ['AvailableQuantity']
    // (openNewForm clears it). getCubeShape is a synchronous of() stub, so this settles immediately.
    component['loadCubeMetadata']('ProductInventoryCube');
    component.form.kpiMeasure = MEAS;
    component.form.valueType = 'raw';
  }

  // ── State model (both lists) ──
  for (const list of ['kpi', 'base'] as const) {
    it(`composes the correct slot for a > comparison (${list} list)`, async () => {
      const { component, fixture } = setup();
      newFormOnCube(component);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = () => (list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions);
      arr()[0] = '';
      component.setConditionLevel(list, 0, LVL);
      component.setConditionOperator(list, 0, '>');
      expect(component.conditionIsComparison(list, 0)).toBe(true);
      expect(component.conditionIsIncomplete(list, 0)).toBe(true);      // no measure/value yet
      component.setComparisonMeasure(list, 0, MEAS);
      expect(component.conditionIsIncomplete(list, 0)).toBe(true);      // measure only
      component.setComparisonValue(list, 0, '45000000');
      expect(arr()[0]).toBe(COMPOSED_GT);
      expect(component.conditionIsIncomplete(list, 0)).toBe(false);
    });

    it(`composes the EXCEPT-complement for a < comparison (${list} list)`, async () => {
      const { component, fixture } = setup();
      newFormOnCube(component);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = () => (list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions);
      arr()[0] = '';
      component.setConditionLevel(list, 0, LVL);
      component.setConditionOperator(list, 0, '<');
      component.setComparisonMeasure(list, 0, MEAS);
      component.setComparisonValue(list, 0, '45000000');
      expect(arr()[0]).toBe(COMPOSED_LT);
    });

    it(`round-trips a loaded comparison slot into the controls (${list} list)`, () => {
      const { component } = setup();
      newFormOnCube(component);
      // The aggregate-comparison lane is 1.8.0-only, gated off by default. This test pins the guided
      // round-trip that the gate suppresses, so flip the flag on to exercise it (see mdx-feature-flags).
      vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions;
      arr[0] = COMPOSED_GT;
      expect(component.conditionIsComparison(list, 0)).toBe(true);
      expect(component.conditionComparisonOp(list, 0)).toBe('>');
      expect(component.conditionComparisonMeasure(list, 0)).toBe(MEAS);
      expect(component.conditionComparisonValue(list, 0)).toBe(45000000);
      expect(component.conditionIsFreeText(list, 0)).toBe(false);       // a chip, not free-text
      expect(component.conditionLevelSpec(list, 0)).toBe(LVL);
    });

    it(`switching a comparison back to a six-op operator resets to a member row (${list} list)`, () => {
      const { component } = setup();
      newFormOnCube(component);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions;
      arr[0] = COMPOSED_GT;
      component.setConditionOperator(list, 0, 'is');
      expect(component.conditionIsComparison(list, 0)).toBe(false);
      expect(component.conditionOperator(list, 0)).toBe('is');
      expect(component.conditionIsIncomplete(list, 0)).toBe(true);      // bare [lvl].&[] sentinel, no member
    });

    it(`comparison → six-op → comparison does NOT resurrect the abandoned measure (${list} list; B-PLAN-10)`, () => {
      const { component } = setup();
      newFormOnCube(component);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = () => (list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions);
      arr()[0] = '';
      // Build an UNDER-FILLED comparison (measure, no value yet) so the measure lives in pendingComparison,
      // NOT in the slot — this is the only state B-PLAN-10 can resurrect from.
      component.setConditionLevel(list, 0, LVL);
      component.setConditionOperator(list, 0, '>');
      component.setComparisonMeasure(list, 0, MEAS);
      expect(component.conditionComparisonMeasure(list, 0)).toBe(MEAS);  // pending measure present
      expect(component.conditionIsComparison(list, 0)).toBe(true);
      component.setConditionOperator(list, 0, 'is');                     // leave the comparison lane (six-op)
      component.setConditionOperator(list, 0, '>');                      // switch back to a comparison
      // The row must start EMPTY — the six-op write path (applyConditionOperator) must have cleared the
      // stale pendingComparison entry on the way out; without the Family C fix the abandoned MEAS returns.
      expect(component.conditionComparisonMeasure(list, 0)).toBe('');
      expect(component.conditionComparisonValue(list, 0)).toBeNull();
      expect(component.conditionIsIncomplete(list, 0)).toBe(true);
    });
  }

  // ── pendingComparison lifecycle (B-PLAN-07): the in-progress measure/value must ride the row on
  //    reorder and drop off on delete, in lockstep with pendingOperator. Uses the kpi list (drag helpers
  //    are kpi-wired in the existing suite); the remap code is list-agnostic.
  it('carries an under-filled comparison (op + measure, no value) to its new index on reorder', () => {
    const { component } = setup();
    newFormOnCube(component);
    component.form.kpiConditions = ['', '[status].[H1].[status].&[A]', 'C'];
    // Row 0 is a comparison mid-entry: op '>' + measure chosen, value still blank → under-filled (pending only).
    component.setConditionLevel('kpi', 0, LVL);
    component.setConditionOperator('kpi', 0, '>');
    component.setComparisonMeasure('kpi', 0, MEAS);
    expect(component.conditionIsComparison('kpi', 0)).toBe(true);
    expect(component.conditionIsIncomplete('kpi', 0)).toBe(true);       // still on the sentinel
    const dt = stubDataTransfer();
    component.onRowDragStart('kpi', 0, dragEvent('dragstart', dt) as any);
    component.onConditionDrop('kpi', 2, dragEvent('drop', dt) as any);  // row 0 → index 2
    // The pending comparison rode to index 2 — op AND measure both followed (no key-collision blanking).
    expect(component.conditionIsComparison('kpi', 2)).toBe(true);
    expect(component.conditionComparisonOp('kpi', 2)).toBe('>');
    expect(component.conditionComparisonMeasure('kpi', 2)).toBe(MEAS);
    expect(component.conditionComparisonValue('kpi', 2)).toBeNull();
    expect(component.conditionIsComparison('kpi', 0)).toBe(false);      // vacated
  });

  it('drops an under-filled comparison\'s pending state when its row is removed', () => {
    const { component } = setup();
    newFormOnCube(component);
    component.form.kpiConditions = ['', '[status].[H1].[status].&[A]'];
    component.setConditionLevel('kpi', 0, LVL);
    component.setConditionOperator('kpi', 0, '>');
    component.setComparisonMeasure('kpi', 0, MEAS);
    component.removeKpiCondition(0);                                    // queues the confirm prompt
    component.runConfirmPrompt();                                       // user confirms → splice, row 1 → row 0
    // The surviving row (the six-op member row) must NOT inherit the removed row's stale measure/value.
    expect(component.conditionIsComparison('kpi', 0)).toBe(false);
    expect(component.conditionComparisonMeasure('kpi', 0)).toBe('');
  });

  it('a complete comparison does NOT block submit; an incomplete one does', async () => {
    const { component, kpiApi } = setup();
    newFormOnCube(component);
    component.form.name = 'Cmp KPI';
    component.form.kpiConditions[0] = '';
    component.setConditionLevel('kpi', 0, LVL);
    component.setConditionOperator('kpi', 0, '>');
    component.setComparisonMeasure('kpi', 0, MEAS);
    component.submit();
    expect(kpiApi.createKpiDefinition).not.toHaveBeenCalled();          // incomplete → blocked
    component.setComparisonValue('kpi', 0, '45000000');
    component.submit();
    expect(kpiApi.createKpiDefinition).toHaveBeenCalled();              // complete → allowed
  });

  // ── Rendering (assert PER template copy — Global Constraints / spec §4.4) ──
  for (const [list, section] of [['kpi', 'kpi-conditions-section'], ['base', 'base-conditions-section']] as const) {
    it(`renders the "Aggregate comparison" optgroup in the operator select (${section})`, async () => {
      const { component, fixture } = setup();
      newFormOnCube(component);
      // The optgroup is 1.8.0-only and gated off by default; flip the flag on to assert it renders.
      vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions;
      arr[0] = '';
      component.setConditionLevel(list, 0, LVL);
      await render(fixture);
      const row = fixture.nativeElement.querySelector(`[data-testid="${section}"] .condition-rows .condition-row`);
      const optgroup = row.querySelector('.condition-operator optgroup[label="Aggregate comparison"]') as HTMLOptGroupElement;
      expect(optgroup).toBeTruthy();
      expect(optgroup.disabled).toBe(false);                            // CUBE_SHAPE has a measure
      const values = [...optgroup.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
      expect(values).toEqual(['>', '>=', '<', '<=']);                   // entity refs decode to the ComparisonOp strings
    });

    it(`renders the measure select + numeric input and hides the member control when a comparison is active (${section})`, async () => {
      const { component, fixture } = setup();
      newFormOnCube(component);
      // A loaded comparison slot renders guided controls only when the 1.8.0 lane is enabled.
      vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions;
      arr[0] = COMPOSED_GT;
      await render(fixture);
      const row = fixture.nativeElement.querySelector(`[data-testid="${section}"] .condition-rows .condition-row`);
      expect(row.querySelector('.condition-measure-select')).toBeTruthy();
      expect(row.querySelector('.condition-value-input')).toBeTruthy();
      expect(row.querySelector('.condition-member-combobox')).toBeNull();
      expect(row.querySelector('.condition-member-checkboxes')).toBeNull();
    });

    it(`does NOT warn (Option-1 lint stays silent) on a completed comparison row (${section})`, async () => {
      const { component, fixture } = setup();
      newFormOnCube(component);
      // Asserts the Option-1 lint (a different advisory) stays silent on a guided comparison chip; that
      // chip only renders when the 1.8.0 lane is on, so enable it. The gate's own advisory is tested
      // separately in the "KPI condition 1.8.0 gate" block.
      vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
      if (list === 'base') component.form.valueType = 'percentage';
      const arr = list === 'kpi' ? component.form.kpiConditions : component.form.baseConditions;
      arr[0] = COMPOSED_LT;                                             // the EXCEPT(...FILTER...) form
      await render(fixture);
      const row = fixture.nativeElement.querySelector(`[data-testid="${section}"] .condition-rows .condition-row`);
      expect(row.querySelector('.condition-warning-icon')).toBeNull();  // §5 guard proven in the component, both copies
    });
  }

  it('a completed comparison chip round-trips through the free-text escape hatch (flip out and back)', () => {
    const { component } = setup();
    newFormOnCube(component);
    // The guided comparison chip and its "Use guided" toggle are 1.8.0-only; enable the lane so the
    // flip-out-and-back path is reachable (gated off, the chip degrades to free-text with no toggle).
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.form.kpiConditions[0] = COMPOSED_GT;
    expect(component.conditionIsComparison('kpi', 0)).toBe(true);
    component.toggleFreeText('kpi', 0);                                  // "Edit as raw text"
    expect(component.conditionIsFreeText('kpi', 0)).toBe(true);
    component.toggleFreeText('kpi', 0);                                  // "Use guided" — must flip back
    // Without the parseComparison arm in toggleFreeText, an AGGREGATE(...) slot sticks in free-text
    // (parseCondition rejects it), so the guided comparison chip would be unreachable.
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);
    expect(component.conditionIsComparison('kpi', 0)).toBe(true);
  });
});

describe('KPI page shell (SC-2665 / E4)', () => {
  it('uses the shared .page--full shell', () => {
    const fixture = TestBed.createComponent(KpiComponent);
    expect((fixture.nativeElement as HTMLElement).querySelector('.kpi-page.page--full')).not.toBeNull();
  });
});

/**
 * SC-2707 — the detail view's top row: Live Value (square, connection light), Threshold (band
 * ruler), Issue Breakdown, Value Breakdown. The tiles render RESOLVED numbers, so the maths that
 * places a ruler tick or drops a breakdown row lives in the component and is pinned here. Cases
 * chosen for the ways the arithmetic breaks, not the happy path: an open-ended final band with no
 * finite edge, a zero-width scale, a value past the last edge, a negative value.
 */
describe('KPI detail top row (SC-2707)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** Bands as the envelope carries them: ascending `to`, the last one open-ended (`null`). */
  const BANDS = [
    { to: 800, kind: 'ok' as const, color: '#1faa59' },
    { to: 1200, kind: 'watching' as const, color: '#b45e00' },
    { to: null, kind: 'warning' as const, color: '#cc3300' },
  ];

  function health(over: Record<string, any> = {}) {
    return {
      name: 'Late Orders', label: 'Late Orders', value: 1284,
      threshold: { target: 1000, bands: BANDS, status: 'warning' as const, statusColor: '#cc3300' },
      issues: null,
      ...over,
    };
  }

  /** Drive one health read through the component with a crafted envelope. */
  function read(envelope: any) {
    const ctx = setup();
    const api = TestBed.inject(KpiHealthService) as unknown as { getKpiHealth: any };
    api.getKpiHealth.mockReturnValue(of(envelope));
    ctx.component.fetchHealth('Late Orders');
    return ctx.component;
  }

  it('sizes ruler zones by band SPAN, not one slice per band, and lands each tick on its colour change', () => {
    // lo 0, last finite edge 1200, +10% headroom for the open-ended band → scale 0…1320.
    const r = read(health()).thresholdRuler!;
    expect(r.zones.map(z => +z.pct.toFixed(2))).toEqual([60.61, 30.30, 9.09]);
    // A tick's percent is the running sum of the zones before it — equal-width zones would not line up.
    expect(r.ticks.map(t => +t.pct.toFixed(2))).toEqual([60.61, 90.91]);
    expect(r.ticks[0]!.pct).toBeCloseTo(r.zones[0]!.pct, 6);
  });

  it('stretches the scale when the value sits past the open-ended band, pinning the marker at 100%', () => {
    const r = read(health({ value: 5000 })).thresholdRuler!;
    expect(r.markerPct).toBe(100);
    // The scale grew to the value, so the finite edges compress toward the left.
    expect(r.ticks[1]!.pct).toBeCloseTo(24, 0);
    expect(r.zones.reduce((s, z) => s + z.pct, 0)).toBeCloseTo(100, 6);
  });

  it('extends the scale BELOW zero for a negative value instead of clamping it out of view', () => {
    const r = read(health({ value: -400 })).thresholdRuler!;
    expect(r.markerPct).toBe(0);
    expect(r.ticks[0]!.pct).toBeGreaterThan(0);
    expect(r.zones.reduce((s, z) => s + z.pct, 0)).toBeCloseTo(100, 6);
    expect(r.start).toBe(-400);          // the left end is labelled with where the scale really starts
  });

  it('labels the scale start only when no band edge already sits there', () => {
    expect(read(health()).thresholdRuler!.start).toBe(0);
    // First edge AT the scale start: labelling it twice would stack two labels on one point.
    const atZero = health({ value: 40, threshold: { target: 0, bands: [
      { to: 0, kind: 'ok', color: '#0a0' }, { to: null, kind: 'warning', color: '#c30' },
    ], status: 'warning', statusColor: '#c30' } });
    expect(read(atZero).thresholdRuler!.start).toBeNull();
  });

  it('draws no ruler when there is no finite band edge, or when the scale would be zero-width', () => {
    // One open-ended band: nothing to position against.
    expect(read(health({ threshold: { target: 0, bands: [{ to: null, kind: 'warning', color: '#c30' }], status: null, statusColor: null } })).thresholdRuler).toBeNull();
    // Every edge, the value and the target all 0 → span 0; a naive divide would emit NaN widths.
    expect(read(health({ value: 0, threshold: { target: 0, bands: [{ to: 0, kind: 'ok', color: '#0a0' }], status: 'ok', statusColor: '#0a0' } })).thresholdRuler).toBeNull();
    expect(read(health({ threshold: null })).thresholdRuler).toBeNull();
  });

  it('omits the marker when the value is unavailable but still draws the bands', () => {
    const r = read(health({ value: null, valueUnavailable: true })).thresholdRuler!;
    expect(r.markerPct).toBeNull();
    expect(r.zones).toHaveLength(3);
  });

  it('keeps the four issue states distinct — not tracked, unavailable, none raised, and raised', () => {
    expect(read(health({ issues: null })).issueBreakdown).toMatchObject({ state: 'untracked' });
    expect(read(health({ issues: { baseObject: 'SalesOrder', unavailable: true } })).issueBreakdown).toMatchObject({ state: 'unavailable' });
    expect(read(health({ issues: { baseObject: 'SalesOrder', total: 0, bySeverity: [] } })).issueBreakdown)
      .toMatchObject({ state: 'none', note: 'No issues raised' });

    const raised = read(health({ issues: { baseObject: 'SalesOrder', total: 5, bySeverity: [{ severity: 3, count: 1 }, { severity: 1, count: 4 }] } })).issueBreakdown;
    expect(raised.state).toBe('some');
    expect(raised.total).toBe(5);
    expect(raised.rows.map(r => r.severity)).toEqual([1, 3]);       // ascending severity, most critical first
    expect(raised.rows.map(r => r.tone)).toEqual(['high', 'med']);
    expect(raised.max).toBe(4);                                     // bar scale = the largest count
  });

  it('reports the connection light from the read state, not a hardcoded green', () => {
    const ctx = setup();
    const api = TestBed.inject(KpiHealthService) as unknown as { getKpiHealth: any };
    api.getKpiHealth.mockReturnValue(of(health()));
    ctx.component.fetchHealth('Late Orders');
    expect(ctx.component.connState).toBe('live');

    api.getKpiHealth.mockReturnValue(throwError(() => new Error('down')));
    ctx.component.fetchHealth('Late Orders');
    expect(ctx.component.connState).toBe('down');
    expect(ctx.component.connLabel).toBe('Disconnected');
    expect(ctx.component.thresholdRuler).toBeNull();               // stale ruler cleared, not left on screen
  });

  it('drops zero-value breakdown members and renders only the top rows that fit, ranked by value', () => {
    const values = [
      { label: 'A', value: 412 }, { label: 'B', value: 0 }, { label: 'C', value: 900 },
      { label: 'D', value: null }, { label: 'E', value: 74 }, { label: 'F', value: 260 },
    ];
    const ctx = setup({ getKpiData: vi.fn(() => of({ values })) });
    ctx.component.selectedKpi = { name: 'Late Orders', type: 'DeepSee' } as any;
    ctx.component.selectedDimension = 'Region';
    ctx.component.onDimensionChange();

    // Zero AND null (which coerces to 0) are dropped — a stub bar carries no information.
    expect(ctx.component.breakdown.map(v => v.label)).toEqual(['A', 'C', 'E', 'F']);
    // The tile does not scroll, so only the largest three are rendered, biggest first.
    expect(ctx.component.breakdownTop.map(v => v.label)).toEqual(['C', 'A', 'F']);
    // The full set still drives the "+N more" count and the bar scale.
    expect(ctx.component.breakdown.length - ctx.component.breakdownTop.length).toBe(1);
    expect(ctx.component.breakdownMax).toBe(900);
  });
});

/**
 * SC-2721 — an issue-generating KPI reads its value and its issue rows separately, so for a moment
 * after a load the two can disagree while issue records are still being written. The tile flags that
 * with a warning badge rather than showing two numbers that silently contradict each other. Cases are
 * chosen for the ways a naive `value !== total` check misfires: a KPI that raises no issues at all, a
 * failed issue read, and an unavailable value — none of those are a populating lag.
 */
describe('KPI issue-count staleness warning (SC-2721)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function health(over: Record<string, any> = {}) {
    return { name: 'Late Orders', label: 'Late Orders', value: 1284, threshold: null, issues: null, ...over };
  }

  /** Issue envelope for a KPI that DOES generate issues, totalling `total`. */
  function issues(total: number, bySeverity = [{ severity: 1, count: total }]) {
    return { baseObject: 'SalesOrder', total, bySeverity: total === 0 ? [] : bySeverity };
  }

  function read(envelope: any) {
    const ctx = setup();
    const api = TestBed.inject(KpiHealthService) as unknown as { getKpiHealth: any };
    api.getKpiHealth.mockReturnValue(of(envelope));
    ctx.component.fetchHealth('Late Orders');
    return ctx.component;
  }

  it('flags the tile when the KPI value and the issue total disagree', () => {
    const b = read(health({ value: 1284, issues: issues(5) })).issueBreakdown;
    expect(b.state).toBe('some');
    expect(b.stale).toBe(true);
  });

  it('does not flag the tile when the value already equals the issue total', () => {
    expect(read(health({ value: 5, issues: issues(5) })).issueBreakdown.stale).toBe(false);
  });

  it('flags an issue-generating KPI whose issues have not landed yet (total 0 against a non-zero value)', () => {
    // The most common populating lag: the value is in, not one issue row is. state is 'none', not
    // 'some', so a check that only looked at rendered rows would stay silent exactly when it matters.
    const b = read(health({ value: 1284, issues: issues(0) })).issueBreakdown;
    expect(b.state).toBe('none');
    expect(b.stale).toBe(true);
  });

  it('never flags a KPI that does not generate issues, or one whose issue read failed', () => {
    // No issues key at all: the value has nothing to disagree with.
    expect(read(health({ value: 1284, issues: null })).issueBreakdown.stale).toBe(false);
    // A failed read is already reported as "unavailable"; calling it a lag would be a second, wrong story.
    expect(read(health({ value: 1284, issues: { baseObject: 'SalesOrder', unavailable: true } })).issueBreakdown.stale).toBe(false);
  });

  it('does not flag when the value itself is missing, so there is nothing to compare', () => {
    expect(read(health({ value: null, valueUnavailable: true, issues: issues(5) })).issueBreakdown.stale).toBe(false);
    // A genuinely empty value against zero issues agrees; it is not a lag either.
    expect(read(health({ value: null, issues: issues(0) })).issueBreakdown.stale).toBe(false);
  });

  it('clears the flag when the next read arrives consistent', () => {
    const ctx = setup();
    const api = TestBed.inject(KpiHealthService) as unknown as { getKpiHealth: any };
    api.getKpiHealth.mockReturnValue(of(health({ value: 1284, issues: issues(0) })));
    ctx.component.fetchHealth('Late Orders');
    expect(ctx.component.issueBreakdown.stale).toBe(true);

    api.getKpiHealth.mockReturnValue(of(health({ value: 1284, issues: issues(1284) })));
    ctx.component.fetchHealth('Late Orders');
    expect(ctx.component.issueBreakdown.stale).toBe(false);
  });

  // The warning is only useful if the reason for it is readable. `title` gives a browser tooltip
  // that this card's overflow:hidden and the webview both make unreliable, so the badge must carry
  // the app's own [data-tooltip] bubble instead (styles.css).
  it('explains itself through the app tooltip, not a native title attribute', () => {
    const ctx = setup();
    const api = TestBed.inject(KpiHealthService) as unknown as { getKpiHealth: any };
    api.getKpiHealth.mockReturnValue(of(health({ value: 1284, issues: issues(5) })));
    ctx.component.selectedKpi = { name: 'Late Orders', type: 'DeepSee' } as any;
    ctx.component.fetchHealth('Late Orders');
    ctx.fixture.detectChanges();

    const badge = ctx.fixture.nativeElement.querySelector('[data-testid="issues-stale"]');
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('data-tooltip')).toBe('Issue data can take a minute to populate');
    expect(badge.hasAttribute('title')).toBe(false);
    // Hover is not the only way in: the bubble also shows on :focus-visible.
    expect(badge.getAttribute('tabindex')).toBe('0');
  });
});

/**
 * Refresh must come back to the KPI the user had open — the `?item=` deep link the
 * shell mirrors into the URL — on its DETAIL view.
 */
describe('KPI `?item=` deep link', () => {
  afterEach(() => TestBed.resetTestingModule());

  const DEFINITION = {
    name: 'Late Orders',
    type: 'DeepSee',
    deepseeKpiSpec: { cube: 'ProductInventoryCube', kpiMeasure: 'AvailableQuantity', valueType: 'value' },
  };

  function withKpi() {
    const made = setup({ getKpiDefinitions: vi.fn(() => of([DEFINITION])) });
    const controller = made.component['guidedController'] as GuidedFormController;
    return { ...made, controller };
  }

  it('reports the selected KPI, and nothing on the overview', () => {
    const { component, controller } = withKpi();
    expect(controller.currentItem!()).toBeNull();

    component.selectKpi(component.groups[0]!.items[0]!);

    expect(controller.currentItem!()).toBe('Late Orders');
  });

  it('re-opens the KPI the token names, on its detail view (not the edit form)', async () => {
    const { component, controller } = withKpi();

    expect(await controller.restoreItem!('Late Orders')).toBe(true);

    expect(component.selectedKpi?.name).toBe('Late Orders');
    expect(component.formMode).toBeNull();
  });

  it('opens a DRAFT on its detail view too — a refresh is not a request to resume editing', async () => {
    const made = setup({
      getKpiDefinitions: vi.fn(() => of([])),
      listKpiDrafts: vi.fn(() => of({ drafts: [{ kpiName: 'Late Orders', definition: DEFINITION }] })),
    });
    const controller = made.component['guidedController'] as GuidedFormController;

    expect(await controller.restoreItem!('Late Orders')).toBe(true);

    expect(made.component.selectedKpi?.state).toBe('draft');
    expect(made.component.formMode).toBeNull();
  });

  it('reports false for a KPI that is gone, leaving the overview on screen', async () => {
    const { component, controller } = withKpi();

    expect(await controller.restoreItem!('Deleted KPI')).toBe(false);

    expect(component.selectedKpi).toBeNull();
  });
});

// ── KPI condition 1.8.0 gate ───────────────────────────────────────────────
// `setup(seed)` is the file's existing helper (line 56); it returns
// { fixture, bridge, component, kpiApi, kpiGroups, dashboardChart, toasts }. `vi` is
// already imported at the top of this spec.
const GATED = 'EXCEPT([q].[H1].[s].MEMBERS,{[q].[H1].[s].&[Normal]})';
const BOUNDARY_KEY = '[dept].[H1].[name].&[R AND D]';   // parses to `is`; safe, must stay guided

describe('KPI condition 1.8.0 gate (component)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('advancedMdxEnabled reflects the shipped flag (off)', () => {
    const { component } = setup();
    expect(component.advancedMdxEnabled()).toBe(false);
  });

  it('forces a loaded gated condition to free-text when the flag is off', () => {
    const { component } = setup();
    component.form.kpiConditions = [GATED];
    expect(component.conditionFreeTextForced('kpi', 0)).toBe(true);
    expect(component.conditionIsFreeText('kpi', 0)).toBe(true);
    expect(component.conditionUsesAdvancedMdx('kpi', 0)).toBe(true);
  });

  it('leaves a safe member-key / null-key condition guided', () => {
    const { component } = setup();
    component.form.kpiConditions = ['[quantityStatus].[H1].[status].&[Normal]'];
    expect(component.conditionFreeTextForced('kpi', 0)).toBe(false);
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);
    component.form.kpiConditions = ['[actualTimeOfArrival].[H1].[value].&[<null>]'];
    expect(component.conditionFreeTextForced('kpi', 0)).toBe(false);
    expect(component.conditionUsesAdvancedMdx('kpi', 0)).toBe(false);
  });

  // GATE-PLAN-06 regression guard at the component level: a real member key whose text contains the
  // word "AND" parses to `is`, so the force decision (parsesToAdvancedForm) must keep it guided even
  // though the advisory heuristic (usesAdvancedMdx) fires on it.
  it('does NOT force free-text for a safe key whose text contains an MDX keyword', () => {
    const { component } = setup();
    component.form.kpiConditions = [BOUNDARY_KEY];
    expect(component.conditionFreeTextForced('kpi', 0)).toBe(false);   // stays guided (parse-only says safe)
    expect(component.conditionIsFreeText('kpi', 0)).toBe(false);
    // The loud superset fires on the raw predicate, but the advisory is ALSO gated on the row being
    // free-text (Task 3), so a guided row shows no warning — the false positive is fully contained.
    expect(component.conditionUsesAdvancedMdx('kpi', 0)).toBe(true);
  });

  it('does not force free-text when the flag is on (1.8.0)', () => {
    const { component } = setup();
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.form.kpiConditions = [GATED];
    expect(component.conditionFreeTextForced('kpi', 0)).toBe(false);
  });

  // GATE-PLAN-10: §4.3's core promise — a loaded gated condition is NEVER silently rewritten. Submit an
  // untouched form and assert the emitted kpiConditions[0] equals the input byte-for-byte. formToDefinition
  // only .trim()s and filters the slot (kpi.ts:1821); it must not recompose it.
  it('round-trips a loaded gated condition byte-for-byte on submit', () => {
    const { component, kpiApi } = setup();
    component.form.name = 'GatedRoundTrip';
    component.form.type = 'DeepSee';
    component.form.cube = 'ProductInventoryCube';
    component.form.valueType = 'raw';
    component.form.kpiConditions = [GATED];
    component.form.baseConditions = [''];

    component.submit();   // formMode is null (not 'edit') → createKpiDefinition (POST)

    expect(component.formError).toBe('');
    expect(kpiApi.createKpiDefinition).toHaveBeenCalledTimes(1);
    const def = (kpiApi.createKpiDefinition.mock.calls as any[])[0][0];
    expect(def.deepseeKpiSpec.kpiConditions[0]).toBe(GATED);
  });
});

// ── KPI condition 1.8.0 gate — template/DOM ────────────────────────────────
// Uses the file's `setup()` helper (line 56) and the same render idiom the existing condition-ladder DOM
// tests use (openNewForm → markForCheck → detectChanges → whenStable). A full member-key slot makes the
// level resolvable, so the operator <select> renders without cube metadata (see the existing "operator
// dropdown renders the explicit 6" test at line 833). Scope every query to
// [data-testid="kpi-conditions-section"] — the kpi block always renders (the base block is
// percentage-gated behind showBaseConditions).
const KPI_SECTION = '[data-testid="kpi-conditions-section"]';
const SAFE = '[quantityStatus].[H1].[status].&[Normal]';
const GATED_TPL = 'EXCEPT([q].[H1].[s].MEMBERS,{[q].[H1].[s].&[Normal]})';

async function renderKpi(fixture: ComponentFixture<KpiComponent>) {
  fixture.changeDetectorRef.markForCheck();
  fixture.detectChanges();
  await fixture.whenStable();
}
const operatorOptionValues = (fixture: ComponentFixture<KpiComponent>): string[] => {
  // Direct-child options only — the six-op set. The aggregate-comparison operators live in a nested
  // <optgroup> and are asserted separately (matches the "renders the explicit 6" test at line 833).
  const sel = fixture.nativeElement.querySelector(`${KPI_SECTION} .condition-operator`);
  return sel ? Array.from(sel.querySelectorAll(':scope > option')).map((o: any) => o.getAttribute('value')) : [];
};

describe('KPI condition 1.8.0 gate (template)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers only is and is null when the flag is off', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [SAFE];
    await renderKpi(fixture);
    expect(fixture.nativeElement.querySelector(`${KPI_SECTION} .condition-operator`)).toBeTruthy();
    expect(operatorOptionValues(fixture)).toEqual(['is', 'isNull']);
    // no aggregate-comparison optgroup
    expect(fixture.nativeElement.querySelector(`${KPI_SECTION} optgroup[label="Aggregate comparison"]`)).toBeNull();
  });

  // GATE-PLAN-07: the §7 reversal branch. Flipping the flag on must restore ALL options + the optgroup.
  // This is the one flip the whole design exists to make safe, so it is asserted at the DOM level.
  it('restores all six operators and the comparison optgroup when the flag is on (1.8.0)', async () => {
    const { component, fixture } = setup();
    vi.spyOn(component, 'advancedMdxEnabled').mockReturnValue(true);
    component.openNewForm();
    component.form.kpiConditions = [SAFE];
    await renderKpi(fixture);
    expect(operatorOptionValues(fixture)).toEqual(
      ['is', 'isOneOf', 'isNot', 'isNotOneOf', 'isNull', 'isNotNull']);
    expect(fixture.nativeElement.querySelector(`${KPI_SECTION} optgroup[label="Aggregate comparison"]`)).toBeTruthy();
  });

  it('renders a loaded gated condition as free-text with a non-blocking advisory and no dead toggle', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [GATED_TPL];
    await renderKpi(fixture);
    const row = fixture.nativeElement.querySelector(`${KPI_SECTION} .condition-row`) as HTMLElement;
    // rendered as free-text with the advisory, now the quiet ⚠ icon (full text on its hover/aria tooltip)
    expect(row.querySelector('input.condition-input')).toBeTruthy();
    const icon = row.querySelector('.condition-warning-icon') as HTMLElement;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('aria-label')).toContain('requires SCO 1.8.0');
    // the "Use guided" toggle is hidden — the row cannot go guided on 1.7.3
    expect(row.querySelector('.condition-mdx-toggle')).toBeNull();
    // advisory is non-blocking: submit is not gated by it (validateForSubmit ignores it)
    expect(component.conditionIsFreeText('kpi', 0)).toBe(true);
  });

  it('shows no advisory for a safe member-key condition', async () => {
    const { component, fixture } = setup();
    component.openNewForm();
    component.form.kpiConditions = [SAFE];
    await renderKpi(fixture);
    expect(fixture.nativeElement.querySelector(`${KPI_SECTION} .condition-warning-icon`)).toBeNull();
  });
});
