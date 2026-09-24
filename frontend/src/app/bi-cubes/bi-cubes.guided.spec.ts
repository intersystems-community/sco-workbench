import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { BiCubesComponent } from './bi-cubes';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult } from '../core/workbench-bridge.service';
import { ScModelService } from '../services/sc-model.service';
import { CubeService } from '../services/cube.service';
import { ToastService } from '../core/toast.service';
import { styleScopeFree } from '../shared/test-markup';

/**
 * Guided-mode cube form: the assistant must fill the Source Class from the REAL
 * dropdown options, never a hallucinated class (the reported bug — it invented
 * `SC.Data.InventoryItem` because the options were never in its UI context). These
 * pins fix that the form snapshot exposes every source-class option up front (like
 * the KPI form's availableCubes), and that guidedSetField resolves a plain term to
 * a real class and rejects an invented one.
 */
const OBJECTS = [
  { objectName: 'Inventory', className: 'SC.Data.Inventory' },
  { objectName: 'SalesOrder', className: 'SC.Data.SalesOrder' },
  { objectName: 'Product', className: 'SC.Data.Product' },
];

function setup() {
  TestBed.resetTestingModule();
  const scModel = { getObjects: vi.fn(() => of(OBJECTS)) };
  const cubes = {
    list: vi.fn(() => of({ cubes: [] })),
    sourceProperties: vi.fn(() => of({ className: 'SC.Data.Inventory', properties: [{ name: 'quantity' }, { name: 'location' }] })),
    save: vi.fn(() => of({ ok: true })),
    compile: vi.fn(() => of({ ok: true })),
    build: vi.fn(() => of({ ok: true })),
  };
  const toasts = { success: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    imports: [BiCubesComponent],
    providers: [
      { provide: ScModelService, useValue: scModel },
      { provide: CubeService, useValue: cubes },
      { provide: ToastService, useValue: toasts },
    ],
  });
  const fixture: ComponentFixture<BiCubesComponent> = TestBed.createComponent(BiCubesComponent);
  const bridge = TestBed.inject(WorkbenchBridgeService);
  fixture.detectChanges(); // ngOnInit → loads objects (source classes) + cube list
  return { fixture, bridge, component: fixture.componentInstance, scModel, cubes };
}

function setField(bridge: WorkbenchBridgeService, path: string, value: string): Promise<SetFieldResult> {
  return bridge.applyDirective({ action: 'set_field', target: path, value });
}

describe('BiCubes guided source-class options (no hallucination)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('exposes every source-class option in the open-form snapshot', () => {
    const { component } = setup();
    component.openNewForm();
    const snap = (component as unknown as { formSnapshot: () => Record<string, unknown> })['formSnapshot']();
    // baseObjects is sorted by the short object name (Inventory, Product, SalesOrder).
    expect(snap['availableSourceClasses']).toEqual([
      'SC.Data.Inventory', 'SC.Data.Product', 'SC.Data.SalesOrder',
    ]);
    // The friendly-name mapping is present too, so the assistant can match on
    // either the short object name or the class.
    expect(snap['sourceClassChoices']).toContainEqual({ objectName: 'Inventory', className: 'SC.Data.Inventory' });
  });

  it('resolves a plain term ("inventory") to the real fully-qualified class', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    const res = await setField(bridge, 'sourceClass', 'inventory');
    expect(res.applied).toBe(true);
    expect(component.cubeForm.sourceClass).toBe('SC.Data.Inventory');
    expect(component.sourceClassOther).toBe(false);
  });

  it('corrects a near-miss hallucination ("InventoryItem") to the real Inventory class', async () => {
    // The reported bug was the AI inventing SC.Data.InventoryItem when the real
    // class is SC.Data.Inventory. The resolver maps that near-miss onto the real
    // class instead of accepting the invented one.
    const { bridge, component } = setup();
    component.openNewForm();
    const res = await setField(bridge, 'sourceClass', 'InventoryItem');
    expect(res.applied).toBe(true);
    expect(component.cubeForm.sourceClass).toBe('SC.Data.Inventory');
  });

  it('rejects a plain class name that matches NOTHING and lists the real options', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    const res = await setField(bridge, 'sourceClass', 'Warehouse');
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/not one of the available source classes/i);
    expect(res.detail).toContain('SC.Data.Inventory');
    // Nothing was written — the form isn't left pointing at a bogus class.
    expect(component.cubeForm.sourceClass).toBe('');
  });

  it('returns the source class\'s properties in the SAME set_field result (dependent dropdown)', async () => {
    const { bridge } = setup();
    (TestBed.inject(WorkbenchBridgeService)); // ensure bridge init
    const res = await setField(bridge, 'sourceClass', 'SC.Data.Inventory');
    expect(res.applied).toBe(true);
    expect(res.detail).toContain('quantity');
    expect(res.detail).toContain('location');
  });

  it('whenListReady waits for the source-class options to load', async () => {
    const { component } = setup();
    // Both the cube list and the base-objects fetch have settled synchronously
    // (of(...)), so the controller's whenListReady resolves.
    await (component as unknown as { guidedController: { whenListReady: () => Promise<void> } }).guidedController.whenListReady();
    expect(component.baseObjects.map((o) => o.className)).toContain('SC.Data.Inventory');
  });
});

/**
 * Compile / Build straight from the cube's DETAIL view.
 *
 * These shortcuts exist so the user doesn't have to open the form to recompile or
 * rebuild a saved cube. They must run the SAME validated action the form's own buttons
 * run — and, critically, only AFTER the saved definition has been loaded into the form:
 * the definition fetch is async, so firing the action too early would compile whatever
 * happened to be in the form (an empty one, or the previously edited cube).
 */
describe('BiCubes compile/build from the detail view', () => {
  afterEach(() => TestBed.resetTestingModule());

  const CUBE = { name: 'InventoryCube', displayName: 'Inventory Cube', sourceClass: 'SC.Data.Inventory', state: 'compiled', editable: true };
  /** The saved definition the backend returns for editing — enough to pass validateForBuild. */
  const DEFINITION = {
    // The backend's /definition payload keys the name as `cubeName` (definitionToForm).
    cubeName: 'InventoryCube',
    displayName: 'Inventory Cube',
    sourceClass: 'SC.Data.Inventory',
    measures: [{ name: 'Quantity', sourceProperty: 'quantity', aggregate: 'SUM' }],
    dimensions: [],
  };

  /** A component parked on the detail view of an editable, already-compiled cube. */
  function onDetail(over: Record<string, unknown> = {}) {
    const made = setup();
    made.cubes.list = vi.fn(() => of({ cubes: [CUBE] })) as never;
    (made.cubes as Record<string, unknown>)['get'] = vi.fn(() => of({ cube: { ...CUBE, dimensions: [], measures: [] } }));
    (made.cubes as Record<string, unknown>)['getDefinition'] = vi.fn(() => of({ definition: DEFINITION }));
    Object.assign(made.cubes as Record<string, unknown>, over);
    made.component.selectCube(CUBE as never);
    return made;
  }

  it('BUILD loads the saved definition first, then builds it', () => {
    const { component, cubes } = onDetail();

    component.buildSelectedCube();

    // The definition was fetched, and the build carries THAT definition — not an
    // empty form (the bug an unchained call would produce).
    expect((cubes as Record<string, any>)['getDefinition']).toHaveBeenCalledWith('InventoryCube');
    expect(cubes.build).toHaveBeenCalledTimes(1);
    expect((cubes.build as any).mock.calls[0][0]).toMatchObject({ cubeName: 'InventoryCube' });
    expect(cubes.compile).not.toHaveBeenCalled();
  });

  it('COMPILE runs the compile action, not the build', () => {
    const { component, cubes } = onDetail();

    component.compileSelectedCube();

    expect(cubes.compile).toHaveBeenCalledTimes(1);
    expect(cubes.build).not.toHaveBeenCalled();
  });

  it('passes the ORIGINAL name, so a compile does not duplicate the cube', () => {
    const { component, cubes } = onDetail();

    component.compileSelectedCube();

    expect((cubes.compile as any).mock.calls[0][1]).toBe('InventoryCube');
  });

  it('returns to the DETAIL view on success (it is where the user was)', () => {
    const { component } = onDetail();

    component.buildSelectedCube();

    // Unlike the in-form buttons, which keep the user on the form to carry on editing.
    expect(component.editingCube).toBe(false);
    expect(component.creatingNew).toBe(false);
  });

  it('does NOT act when the definition fetch fails', () => {
    const { component, cubes } = onDetail({
      getDefinition: vi.fn(() => throwError(() => ({ error: { error: 'no such cube' } }))),
    });

    component.buildSelectedCube();

    expect(cubes.build).not.toHaveBeenCalled();
    expect(component.formError).toContain('no such cube');
  });

  it('blocks an INVALID definition and leaves the form open with the error', () => {
    // Nothing to aggregate: validateForBuild refuses, and the form is where it's fixed.
    const { component, cubes } = onDetail({
      getDefinition: vi.fn(() => of({ definition: { ...DEFINITION, measures: [], dimensions: [] } })),
    });

    component.buildSelectedCube();

    expect(cubes.build).not.toHaveBeenCalled();
    expect(component.editingCube).toBe(true);
    expect(component.formError).toBeTruthy();
  });

  it('ignores a second press while an action is already running', () => {
    const { component, cubes } = onDetail();
    (component as unknown as { formBusy: string | null }).formBusy = 'build';

    component.buildSelectedCube();

    expect(cubes.build).not.toHaveBeenCalled();
  });
});

/**
 * The list keeps its highlight while the cube's EDIT form is open, so the user can see
 * which cube the form belongs to. It is suppressed only while creating a NEW cube, which
 * has no row in the list to point at.
 */
describe('BiCubes list highlight during the edit form', () => {
  afterEach(() => TestBed.resetTestingModule());

  // The list endpoint's own shape (cubeName, not name) — the component maps it to its
  // display model, and the row's highlight compares against THAT.
  const SUMMARY = { className: 'SC.Workbench.Cube.InventoryCube', cubeName: 'InventoryCube', sourceClass: 'SC.Data.Inventory', editable: true };

  function withOneCube() {
    const made = setup();
    made.cubes.list = vi.fn(() => of({ cubes: [SUMMARY] })) as never;
    (made.cubes as Record<string, unknown>)['get'] = vi.fn(() =>
      of({ cube: { name: 'InventoryCube', editable: true, dimensions: [], measures: [] } }),
    );
    (made.cubes as Record<string, unknown>)['getDefinition'] = vi.fn(() =>
      of({ definition: { cubeName: 'InventoryCube', sourceClass: 'SC.Data.Inventory', measures: [], dimensions: [] } }),
    );
    made.component.loadCubes();
    made.fixture.detectChanges();
    return made;
  }

  /** The row as the component actually models it, so a name mismatch can't fake a pass. */
  function theCube(component: BiCubesComponent) {
    const row = component.sortedCubes[0];
    if (!row) throw new Error('The cube list rendered no rows.');
    return row;
  }

  function activeRows(fixture: ComponentFixture<BiCubesComponent>): number {
    return (fixture.nativeElement as HTMLElement).querySelectorAll('.cube-item--active').length;
  }

  it('highlights the selected cube on its detail view', () => {
    const { component, fixture } = withOneCube();
    component.selectCube(theCube(component));
    fixture.detectChanges();
    expect(activeRows(fixture)).toBe(1);
  });

  it('KEEPS the highlight when its edit form opens', () => {
    const { component, fixture } = withOneCube();
    component.selectCube(theCube(component));
    component.openEditForm();
    fixture.detectChanges();

    expect(component.editingCube).toBe(true);
    expect(activeRows(fixture)).toBe(1);
  });

  it('drops it while creating a NEW cube — no row belongs to that form', () => {
    const { component, fixture } = withOneCube();
    component.selectCube(theCube(component));
    component.openNewForm();
    fixture.detectChanges();

    expect(activeRows(fixture)).toBe(0);
  });
});

/**
 * Adding a dimension or measure appends the block at the BOTTOM of its section. With a
 * few already defined that is below the fold, so the click looked like it did nothing and
 * the user had to go hunting. The form now marks the new block and scrolls to it.
 */
describe('BiCubes — a newly added block is revealed', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks the dimension just added, and only that one', () => {
    const { component } = setup();
    component.openNewForm();
    component.addDimension();
    component.addDimension();

    // The second one is the new one.
    expect(component.isJustAdded('dimension', 1)).toBe(true);
    expect(component.isJustAdded('dimension', 0)).toBe(false);
    // …and the marker is scoped to its kind.
    expect(component.isJustAdded('measure', 1)).toBe(false);
  });

  it('marks the measure just added', () => {
    const { component } = setup();
    component.openNewForm();
    component.addMeasure();

    expect(component.isJustAdded('measure', 0)).toBe(true);
    expect(component.isJustAdded('dimension', 0)).toBe(false);
  });

  it('moves the marker to the newest block rather than accumulating', () => {
    const { component } = setup();
    component.openNewForm();
    component.addDimension();
    component.addMeasure();

    // Adding a measure takes the cue away from the dimension — one "here it is" at a time.
    expect(component.isJustAdded('dimension', 0)).toBe(false);
    expect(component.isJustAdded('measure', 0)).toBe(true);
  });

  it('clears the cue after its timer, so the ring is transient not a state', () => {
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.openNewForm();
      component.addDimension();
      expect(component.isJustAdded('dimension', 0)).toBe(true);

      vi.advanceTimersByTime(2500);

      expect(component.justAddedBlock).toBeNull();
      expect(component.isJustAdded('dimension', 0)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still adds the block itself — the reveal is decoration', () => {
    const { component } = setup();
    component.openNewForm();
    const before = component.cubeForm.dimensions.length;

    component.addDimension();

    expect(component.cubeForm.dimensions.length).toBe(before + 1);
    // A fresh dimension arrives expanded, with one hierarchy and one level to fill in.
    const dim = component.cubeForm.dimensions[before]!;
    expect(dim.expanded).toBe(true);
    expect(dim.hierarchies[0]?.levels.length).toBe(1);
  });

  it('uses the shared .page--full shell', () => {
    const { fixture } = setup();
    expect((fixture.nativeElement as HTMLElement).querySelector('.cubes-page.page--full')).not.toBeNull();
  });

  // SC-2665 / E4 Item-4 dedup guard: the .form-* chrome moved from bi-cubes.css into the ONE
  // global styles.css block. That edit touches zero templates, so this form-region markup must
  // be byte-identical after the move — the snapshot pins it. If a future edit changes the form's
  // class list/structure, this reddens and forces a re-baseline decision.
  it('form region markup snapshot (Item 4 dedup guard)', () => {
    const { component, fixture } = setup();
    component.openNewForm();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.form-section, .form-grid');
    expect(region).toBeTruthy();
    expect(styleScopeFree(region?.outerHTML)).toMatchSnapshot();
  });
});

/**
 * Refresh must come back to the cube the user had open — the `?item=` deep link the
 * shell mirrors into the URL — on its DETAIL view, not the edit form and not the
 * overview (the reported bug).
 */
describe('BiCubes `?item=` deep link', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setupWithCubes() {
    TestBed.resetTestingModule();
    const cubes = {
      list: vi.fn(() => of({ cubes: [{ cubeName: 'SalesOrderCube', className: 'SC.Workbench.Cube.SalesOrderCube', sourceClass: 'SC.Data.SalesOrder', editable: true, state: 'built' }] })),
      get: vi.fn(() => of({ cube: { cubeName: 'SalesOrderCube', measures: [], dimensions: [], listings: [] } })),
      sourceProperties: vi.fn(() => of({ className: 'SC.Data.SalesOrder', properties: [] })),
    };
    TestBed.configureTestingModule({
      imports: [BiCubesComponent],
      providers: [
        { provide: ScModelService, useValue: { getObjects: vi.fn(() => of(OBJECTS)) } },
        { provide: CubeService, useValue: cubes },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture: ComponentFixture<BiCubesComponent> = TestBed.createComponent(BiCubesComponent);
    fixture.detectChanges(); // ngOnInit → source classes + cube list
    const component = fixture.componentInstance;
    const controller = component['guidedController'] as GuidedFormController;
    return { component, controller, cubes };
  }

  it('reports the selected cube, and nothing on the overview', () => {
    const { component, controller } = setupWithCubes();
    expect(controller.currentItem!()).toBeNull();

    component.selectCube(component.filteredCubes[0]!);

    expect(controller.currentItem!()).toBe('SalesOrderCube');
  });

  it('re-opens the cube the token names, on its detail view', async () => {
    const { component, controller } = setupWithCubes();

    expect(await controller.restoreItem!('SalesOrderCube')).toBe(true);

    expect(component.selectedCube?.name).toBe('SalesOrderCube');
    expect(component.creatingNew).toBe(false);
    expect(component.editingCube).toBe(false);
  });

  it('reports false for a cube that is gone, leaving the overview on screen', async () => {
    const { component, controller } = setupWithCubes();

    expect(await controller.restoreItem!('DeletedCube')).toBe(false);

    expect(component.selectedCube).toBeNull();
  });
});

/**
 * Guided fills into the cube form's DROPDOWNS (aggregate, measure type, dimension
 * type, time function, source kind).
 *
 * Same defect class as the reported Data Integration one, where "InterSystems IRIS"
 * was written into a `<select>` offering only `IRIS` and the field silently stayed
 * empty. Here the check was exact-match-only, which refused the user's ordinary
 * wording ("average", "monthly", "text") and left the assistant guessing again. The
 * options carry aliases now, so the closest real option wins — and a term matching
 * nothing is still refused rather than written through.
 */
describe('BiCubes guided dropdown resolution', () => {
  afterEach(() => TestBed.resetTestingModule());

  it.each([
    ['average', 'AVG'],
    ['mean', 'AVG'],
    ['total', 'SUM'],
    ['sum', 'SUM'],
    ['how many', 'COUNT'],
    ['maximum', 'MAX'],
  ])('resolves the aggregate "%s" to %s', async (given, expected) => {
    const { bridge, component } = setup();
    component.openNewForm();
    const res = await setField(bridge, 'measures.0.aggregate', given);
    expect(res.applied).toBe(true);
    expect(component.cubeForm.measures[0]!.aggregate).toBe(expected);
    // Whatever lands has to be pickable in the dropdown, or the field reads blank.
    expect(component.AGGREGATES).toContain(component.cubeForm.measures[0]!.aggregate);
  });

  it('refuses an aggregate the dropdown does not offer, and lists the real ones', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    const res = await setField(bridge, 'measures.0.aggregate', 'MEDIAN');
    expect(res.applied).toBe(false);
    expect(res.detail).toContain('SUM, COUNT, AVG, MIN, MAX');
    expect(component.cubeForm.measures[0]!.aggregate).not.toBe('MEDIAN');
  });

  it.each([
    ['text', 'string'],
    ['decimal', 'number'],
    ['int', 'integer'],
    ['bool', 'boolean'],
  ])('resolves the measure type "%s" to %s', async (given, expected) => {
    const { bridge, component } = setup();
    component.openNewForm();
    expect((await setField(bridge, 'measures.0.type', given)).applied).toBe(true);
    expect(component.cubeForm.measures[0]!.type).toBe(expected);
  });

  it.each([
    ['monthly', 'MonthYear'],
    ['by quarter', 'QuarterYear'],
    ['year', 'Year'],
    ['day of week', 'DayWeek'],
  ])('resolves the time function "%s" to %s', async (given, expected) => {
    const { bridge, component } = setup();
    component.openNewForm();
    await setField(bridge, 'dimensions.0.type', 'time');
    const res = await setField(bridge, 'dimensions.0.hierarchies.0.levels.0.timeFunction', given);
    expect(res.applied).toBe(true);
    expect(component.cubeForm.dimensions[0]!.hierarchies[0]!.levels[0]!.timeFunction).toBe(expected);
  });

  it('resolves a dimension type from its everyday name', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    expect((await setField(bridge, 'dimensions.0.type', 'calendar')).applied).toBe(true);
    expect(component.cubeForm.dimensions[0]!.type).toBe('time');
    expect((await setField(bridge, 'dimensions.0.type', 'category')).applied).toBe(true);
    expect(component.cubeForm.dimensions[0]!.type).toBe('data');
  });

  it('publishes every dropdown\'s options in the form snapshot', () => {
    const { component } = setup();
    component.openNewForm();
    const snap = (component as unknown as { formSnapshot: () => Record<string, unknown> })['formSnapshot']();
    const opts = snap['fieldOptions'] as Record<string, string[]>;

    expect(opts['measures.N.aggregate']).toEqual(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX']);
    expect(opts['dimensions.N.type']).toEqual(['data', 'time']);
    expect(opts['measures.N.srcKind']).toEqual(['property', 'expression']);
  });
});

describe('BiCubes guided level ranges', () => {
  afterEach(() => TestBed.resetTestingModule());
  const PATH = 'dimensions.0.hierarchies.0.levels.0.rangeExpression';
  const useExpression = (bridge: WorkbenchBridgeService) =>
    setField(bridge, 'dimensions.0.hierarchies.0.levels.0.srcKind', 'expression');

  it('sets a valid range expression on a data level and normalizes it', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    await useExpression(bridge);
    const res = await setField(bridge, PATH, ' (,0]:Expired; (0,7]:Expiring; (7,):Good ');
    expect(res.applied).toBe(true);
    expect(component.cubeForm.dimensions[0]!.hierarchies[0]!.levels[0]!.rangeExpression).toBe('(,0]:Expired;(0,7]:Expiring;(7,):Good;');
  });

  it('rejects invalid syntax and a missing label with a detail message', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    await useExpression(bridge);
    for (const bad of ['(0,7]Expiring;', '(0,7]:;']) {
      const res = await setField(bridge, PATH, bad);
      expect(res.applied).toBe(false);
      expect(res.detail).toContain('Invalid range expression');
    }
    expect(component.cubeForm.dimensions[0]!.hierarchies[0]!.levels[0]!.rangeExpression ?? '').toBe('');
  });

  it('rejects ranges on a time dimension level', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    await setField(bridge, 'dimensions.0.type', 'time');
    const res = await setField(bridge, PATH, '(,0]:Low;');
    expect(res.applied).toBe(false);
    expect(res.detail).toContain('not allowed on time');
  });

  it('rejects ranges on a non-numeric property', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    component.sourceClassProperties = ['orderStatus'];
    component.sourcePropertyTypes = { orderStatus: '%Library.String', qty: '%Library.Integer' };
    await setField(bridge, 'dimensions.0.hierarchies.0.levels.0.sourceProperty', 'orderStatus');
    const res = await setField(bridge, PATH, '(,0]:Low;');
    expect(res.applied).toBe(false);
    expect(res.detail).toContain('numeric source');
    const level = component.cubeForm.dimensions[0]!.hierarchies[0]!.levels[0]!;
    expect(component.rangesAllowed(level)).toBe(false);
    level.sourceProperty = 'qty';
    expect(component.rangesAllowed(level)).toBe(true);
  });

  it('clears ranges with an empty value and lists the path in the snapshot', async () => {
    const { bridge, component } = setup();
    component.openNewForm();
    await useExpression(bridge);
    await setField(bridge, PATH, '(,0]:Low;');
    expect((await setField(bridge, PATH, '')).applied).toBe(true);
    expect(component.cubeForm.dimensions[0]!.hierarchies[0]!.levels[0]!.rangeExpression).toBe('');
    expect(component.SET_FIELD_PATHS).toContain('dimensions.N.hierarchies.M.levels.L.rangeExpression');
  });
});

describe('BiCubes guided measure source and type', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** A new form over MfgOrder-like properties (types as the source-properties endpoint returns them). */
  function mfgForm() {
    const ctx = setup();
    ctx.component.openNewForm();
    ctx.component.cubeForm.sourceClass = 'SC.Data.MfgOrder';
    ctx.component.sourceClassProperties = ['uid', 'orderStatus', 'quantity', 'plannedEndDate'];
    ctx.component.sourcePropertyTypes = {
      uid: '%Library.String', orderStatus: '%Library.String', quantity: '%Library.Numeric', plannedEndDate: '%Library.DateTime',
    };
    return ctx;
  }
  const measure = (component: BiCubesComponent) => component.cubeForm.measures[0]!;

  it('lets the assistant leave a count measure with no source (a row count)', async () => {
    const { bridge, component } = mfgForm();
    await setField(bridge, 'measures.0.sourceProperty', 'quantity');
    const res = await setField(bridge, 'measures.0.sourceProperty', '');
    expect(res.applied).toBe(true);
    expect(res.detail).toMatch(/counts records/i);
    expect(measure(component).sourceProperty).toBe('');
  });

  it('refuses uid as a measure source and says to leave it empty', async () => {
    const { bridge, component } = mfgForm();
    await setField(bridge, 'measures.0.aggregate', 'COUNT');
    await setField(bridge, 'measures.0.type', 'integer');
    const res = await setField(bridge, 'measures.0.sourceProperty', 'uid');
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/leave the source empty/i);
    expect(measure(component).sourceProperty).toBe('');
  });

  it('sets a string property on a number measure but says it will not build yet', async () => {
    const { bridge, component } = mfgForm();
    const res = await setField(bridge, 'measures.0.sourceProperty', 'orderStatus');
    expect(res.applied).toBe(true);
    expect(res.detail).toMatch(/won't build yet/);
    expect(res.detail).toContain('%Library.String');
    expect(measure(component).sourceProperty).toBe('orderStatus');
  });

  it('warns when the type does not fit the source (date over %DateTime)', async () => {
    const { bridge } = mfgForm();
    await setField(bridge, 'measures.0.sourceProperty', 'plannedEndDate');
    await setField(bridge, 'measures.0.aggregate', 'MAX');
    const res = await setField(bridge, 'measures.0.type', 'date');
    expect(res.applied).toBe(true);
    expect(res.detail).toContain('%Date');
  });

  it('is not trapped: a warned step can be fixed by the next field', async () => {
    const { bridge, component } = mfgForm();
    const warned = await setField(bridge, 'measures.0.sourceProperty', 'orderStatus'); // number over a string
    expect(warned.detail).toMatch(/won't build yet/);
    const fixed = await setField(bridge, 'measures.0.sourceProperty', 'quantity');
    expect(fixed).toEqual({ applied: true });
    expect(measure(component).sourceProperty).toBe('quantity');
  });

  it('warns that a string measure cannot be aggregated, pointing to a dimension', async () => {
    const { bridge } = mfgForm();
    await setField(bridge, 'measures.0.sourceProperty', 'orderStatus');
    const res = await setField(bridge, 'measures.0.type', 'string');
    expect(res.applied).toBe(true);
    expect(res.detail).toMatch(/use a dimension/);
  });

  it('blocks Compile with an inline error when a hand-edited measure does not fit its source', () => {
    const { component, cubes } = mfgForm();
    component.cubeForm.name = 'MfgOrderCube';
    component.addMeasure();
    Object.assign(measure(component), { name: 'statusTotal', sourceProperty: 'orderStatus', aggregate: 'SUM', type: 'number' });
    component.compileCube();
    expect(component.formError).toContain('"statusTotal" is type number');
    expect(cubes.compile).not.toHaveBeenCalled();
  });
});
