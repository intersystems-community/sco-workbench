import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { CubeChartBuilderComponent } from './cube-chart-builder';
import { DashboardChartService, type CubeShape, type ChartableCube } from './services/dashboard-chart.service';
import type { ChartSelection } from './dashboard-config';

@Component({ selector: 'app-chart-builder-preview', standalone: true, template: '<div class="stub-preview"></div>' })
class StubPreview {
  readonly baseSelection = input<ChartSelection | null>(null);
  readonly allowedTypes = input<readonly string[]>([]);
  readonly seedType = input<string | null>(null);
  readonly seedUseAi = input<boolean>(false);
  readonly draftChange = output<ChartSelection>();
  // NOTE: the preview no longer owns `valid` (A3-PLAN-01) — the builder emits its own.
}

const CUBES: ChartableCube[] = [
  { cubeName: 'SalesCube', className: 'SC.Cube.Sales', editable: false, measureCount: 2, dimensionCount: 3 },
  { cubeName: 'BadCube', className: 'SC.Cube.Bad', editable: false, measureCount: 1, dimensionCount: 1 },
];
// ≥2 measures and a multi-level dimension (`customer` = Country ▸ Customer Name — Chloe's exact case)
// so the level-granular UX is exercisable.
const SHAPE: CubeShape = {
  cube: 'SalesCube',
  measures: [{ name: 'Revenue', caption: 'Revenue' }, { name: 'Units', caption: 'Units' }],
  dimensions: [
    { name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] },
    { name: 'product', kind: 'categorical', levels: [{ name: 'Product', spec: '[product].[H1].[Product]' }] },
    { name: 'customer', kind: 'categorical', levels: [
      { name: 'Country', spec: '[customer].[H1].[Country]' },
      { name: 'CustomerName', caption: 'Customer Name', spec: '[customer].[H1].[CustomerName]' },
    ] },
  ],
};
/** A cube whose shape has no dimensions — unchartable, so the builder nulls measures/category. */
const EMPTY_SHAPE: CubeShape = { cube: 'BadCube', measures: [{ name: 'X' }], dimensions: [] };
/** A distinct chartable shape, to prove which of two racing shape fetches won. */
const OTHER_SHAPE: CubeShape = {
  cube: 'BadCube',
  measures: [{ name: 'Zeta', caption: 'Zeta' }],
  dimensions: [{ name: 'zone', kind: 'categorical', levels: [{ name: 'Zone', spec: '[zone].[H1].[Zone]' }] }],
};
/** A second CHARTABLE cube whose `product` dimension SHARES SalesCube's level spec but has different
 *  members — the cross-cube false-cache-hit fixture (A-CTP-IMPL-01). `zone` is first → becomes the
 *  category, leaving `product` free to offer as a filter. */
const SHARED_LEVEL_SHAPE: CubeShape = {
  cube: 'BadCube',
  measures: [{ name: 'Revenue', caption: 'Revenue' }],
  dimensions: [
    { name: 'zone', kind: 'categorical', levels: [{ name: 'Zone', spec: '[zone].[H1].[Zone]' }] },
    { name: 'product', kind: 'categorical', levels: [{ name: 'Product', spec: '[product].[H1].[Product]' }] },
  ],
};

// The `(cube: string)` param makes the default mock's inferred type match the one-arg mocks
// the A3-PLAN-01 regression tests pass in (a zero-arg default would reject them at compile time).
function setup(
  getCubeShape = vi.fn((_cube: string) => of(SHAPE)),
  getCubeMembers = vi.fn((_cube: string, _dimension: string, _level?: string) => of({ members: [] as { name: string; caption?: string }[] })),
  getChartableCubes = vi.fn(() => of({ cubes: CUBES })),
) {
  TestBed.resetTestingModule();
  const getKpis = vi.fn(() => of({ kpis: [] }));
  TestBed.configureTestingModule({
    imports: [CubeChartBuilderComponent],
    providers: [{ provide: DashboardChartService, useValue: { getChartableCubes, getCubeShape, getCubeMembers, getKpis } }],
  });
  // The builder no longer renders the tree (deleted); the stub stands in for the preview only.
  TestBed.overrideComponent(CubeChartBuilderComponent, { set: { imports: [StubPreview] } });
  const fixture: ComponentFixture<CubeChartBuilderComponent> = TestBed.createComponent(CubeChartBuilderComponent);
  return { fixture, el: () => fixture.nativeElement as HTMLElement, getCubeShape, getCubeMembers };
}

function preview(fixture: ComponentFixture<CubeChartBuilderComponent>): StubPreview | null {
  const de = fixture.debugElement.query((d) => d.componentInstance instanceof StubPreview);
  return (de?.componentInstance as StubPreview) ?? null;
}

function pickCube(fixture: ComponentFixture<CubeChartBuilderComponent>, name = 'SalesCube') {
  const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('[data-testid="cube-select"]')!;
  select.value = name; select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}
const pickFirstCube = pickCube;

// --- DOM helpers keyed on the data-testids Step 7 adds ---
function setValue(fixture: ComponentFixture<CubeChartBuilderComponent>, testid: string, value: string) {
  const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)!;
  select.value = value; select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}
/** The first (default) level spec of a dimension in SHAPE — the pick that emits NO `level`. */
function firstLevelSpecOf(dim: string): string {
  return SHAPE.dimensions.find((d) => d.name === dim)!.levels[0]!.spec;
}
const addMeasure = (fixture: ComponentFixture<CubeChartBuilderComponent>, name: string) => setValue(fixture, 'add-measure', name);
const setSeries = (fixture: ComponentFixture<CubeChartBuilderComponent>, dim: string) => setValue(fixture, 'series-dim-select', firstLevelSpecOf(dim));
const setCategoryLevel = (fixture: ComponentFixture<CubeChartBuilderComponent>, levelSpec: string) => setValue(fixture, 'dimension-select', levelSpec);

// --- Filter add-chip helpers (Task 1) ---
function openFilterDraft(fixture: ComponentFixture<CubeChartBuilderComponent>) {
  const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="add-filter"]')!;
  btn.click(); fixture.detectChanges();
}
function pickFilterLevel(fixture: ComponentFixture<CubeChartBuilderComponent>, levelSpec: string) {
  setValue(fixture, 'filter-level-select', levelSpec); // sets + dispatches change + detectChanges
}
function commitFilterMember(fixture: ComponentFixture<CubeChartBuilderComponent>, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('[data-testid="filter-member-input"]')!;
  input.value = value; input.dispatchEvent(new Event('change')); fixture.detectChanges();
}
function filterOptionValues(fixture: ComponentFixture<CubeChartBuilderComponent>): string[] {
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLOptionElement>('#ccb-filter-members option')].map((o) => o.value);
}

describe('CubeChartBuilderComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('picking a cube feeds the preview a general { source:"cube", measures, dimensions } baseSelection', async () => {
    const { fixture, getCubeShape } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    expect(getCubeShape).toHaveBeenCalledWith('SalesCube');
    const base = preview(fixture)!.baseSelection()! as any;
    expect(base).toMatchObject({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'] });
    expect(base.dimensions).toEqual([{ name: 'region', role: 'category' }]); // first dim's first level → no `level`
    expect(base).not.toHaveProperty('chartType');
  });

  it('feeds the preview the CUBE allow-list (never gauge/bullet)', async () => {
    const { fixture } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    const allowed = preview(fixture)!.allowedTypes();
    expect(allowed).not.toContain('solidgauge');
    expect(allowed).not.toContain('bullet');
    expect(allowed).toContain('bar');
  });

  it('re-emits the preview\'s draftChange UNMODIFIED', async () => {
    const { fixture } = setup();
    const selections: ChartSelection[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    preview(fixture)!.draftChange.emit({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'], chartType: 'pie' });
    expect(selections.at(-1)).toMatchObject({ source: 'cube', chartType: 'pie' });
  });

  it('adds a second measure as a chip and emits two measures', async () => {
    const { fixture } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    addMeasure(fixture, 'Units'); // selects the "+ add measure" control
    const base = preview(fixture)!.baseSelection()! as any;
    expect(base.measures).toEqual(['Revenue', 'Units']);
  });

  it('BLOCKS the deferred combo: a second measure disables the Series control (with a note)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    addMeasure(fixture, 'Units');
    const series = el().querySelector<HTMLSelectElement>('[data-testid="series-dim-select"]')!;
    expect(series.disabled).toBe(true);
    expect(el().querySelector('[data-testid="series-blocked-note"]')).not.toBeNull();
  });

  it('symmetrically, choosing a Series disables adding a second measure', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    setSeries(fixture, 'product');
    expect(el().querySelector<HTMLButtonElement>('[data-testid="add-measure"]')!.disabled).toBe(true);
  });

  it('adds a filter via the add-chip UI and it round-trips into baseSelection (chip port of :152)', async () => {
    // product's members come from getCubeMembers; name≠key so a key/name swap is caught elsewhere.
    const getCubeMembers = vi.fn((_c: string, _d: string, _l?: string) => of({ members: [{ name: 'Widget', key: 'W-01' }] }));
    const { fixture } = setup(undefined, getCubeMembers);   // region = category by default; product/customer free
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[product].[H1].[Product]');    // product's only (first) level → `level` omitted downstream
    commitFilterMember(fixture, 'Widget');
    expect(fixture.componentInstance.filters()).toContainEqual({
      name: 'product', level: '[product].[H1].[Product]', member: 'Widget',
    });
    // byte-identical to today's filter shape (single-level dim omits `level`, B-CUBE-01):
    expect((preview(fixture)!.baseSelection()! as any).dimensions)
      .toContainEqual({ name: 'product', role: 'filter', member: 'Widget' });
  });

  it('excludes a dimension already on another channel from the filter-level picker (role-exclusivity, was usedDims guard)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);                                       // region becomes the category
    openFilterDraft(fixture);
    const groups = [...el().querySelectorAll('[data-testid="filter-level-select"] optgroup')].map((g) => (g as HTMLOptGroupElement).label);
    expect(groups).toContain('Product');                     // positive anchor: the picker IS populated (kills a vacuous empty-groups pass, A-CTP-PLAN-01)
    expect(groups).not.toContain('Region');                  // region is the category → not offerable as a filter
    expect(fixture.componentInstance.filters()).toEqual([]);
  });

  it('picking a filter level fetches its members and the datalist option values are m.name (not m.key)', async () => {
    const getCubeMembers = vi.fn((_c: string, _d: string, _l?: string) => of({ members: [{ name: 'Widget', key: 'W-01' }] }));
    const { fixture } = setup(undefined, getCubeMembers);
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[product].[H1].[Product]');
    expect(getCubeMembers).toHaveBeenCalledWith('SalesCube', 'product', '[product].[H1].[Product]');
    expect(filterOptionValues(fixture)).toEqual(['Widget']); // m.name, NOT 'W-01' — a m.key mutant reddens here
  });

  it('a committed filter can be removed via its chip and drops from baseSelection', async () => {
    const getCubeMembers = vi.fn((_c: string, _d: string, _l?: string) => of({ members: [{ name: 'Widget', key: 'W-01' }] }));
    const { fixture, el } = setup(undefined, getCubeMembers);
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    openFilterDraft(fixture); pickFilterLevel(fixture, '[product].[H1].[Product]'); commitFilterMember(fixture, 'Widget');
    expect((preview(fixture)!.baseSelection()! as any).dimensions).toContainEqual({ name: 'product', role: 'filter', member: 'Widget' });
    // the chip's ✕ (its aria-label starts "Remove filter"):
    el().querySelector<HTMLButtonElement>('[aria-label^="Remove filter"]')!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.filters()).toEqual([]);
    expect((preview(fixture)!.baseSelection()! as any).dimensions ?? []).not.toContainEqual({ name: 'product', role: 'filter', member: 'Widget' });
  });

  it('on a member-fetch error the datalist is empty (no stale options) AND a free-typed value still commits (recoverability)', async () => {
    // customer-CustomerName loads a member; product errors. Proves (i) no stale carry-over and (ii) free-type recovery.
    const getCubeMembers = vi.fn((_c: string, _d: string, level?: string) =>
      level === '[customer].[H1].[CustomerName]' ? of({ members: [{ name: 'Acme Ltd' }] }) : throwError(() => ({ status: 500 })));
    const { fixture } = setup(undefined, getCubeMembers);
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[customer].[H1].[CustomerName]');   // resolves → 1 option
    expect(filterOptionValues(fixture)).toEqual(['Acme Ltd']);
    pickFilterLevel(fixture, '[product].[H1].[Product]');         // errors → datalist must be empty, not stale 'Acme Ltd'
    expect(filterOptionValues(fixture)).toEqual([]);              // (i) — a "leave stale options" mutant reddens
    commitFilterMember(fixture, 'Typed-Value');                    // (ii) — a disable-on-error mutant reddens
    expect(fixture.componentInstance.filters()).toContainEqual({ name: 'product', level: '[product].[H1].[Product]', member: 'Typed-Value' });
  });

  it('invalidates the member cache + draft on a cube switch — the datalist serves the NEW cube, not stale members (A-CTP-IMPL-01)', async () => {
    // Two chartable cubes SHARE the level spec [product].[H1].[Product] but have different members.
    // The cache keys on level spec alone, so without a cube-change reset it would false-hit and serve
    // SalesCube's ['Widget'] under BadCube. Members are cube-scoped by contract (getCubeMembers(cube,…)).
    const getCubeMembers = vi.fn((cube: string, _d: string, _l?: string) =>
      of({ members: [{ name: cube === 'SalesCube' ? 'Widget' : 'Gadget' }] }));
    const getCubeShape = vi.fn((cube: string) => (cube === 'BadCube' ? of(SHARED_LEVEL_SHAPE) : of(SHAPE)));
    const { fixture } = setup(getCubeShape, getCubeMembers);
    fixture.detectChanges(); await fixture.whenStable();

    pickCube(fixture, 'SalesCube');
    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[product].[H1].[Product]');
    expect(filterOptionValues(fixture)).toEqual(['Widget']);       // SalesCube's product members

    pickCube(fixture, 'BadCube');                                   // switch cubes — draft + cache must reset
    expect(fixture.componentInstance.draftFilterOpen()).toBe(false); // draft closed by the switch (no stale open row)
    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[product].[H1].[Product]');           // SAME spec, DIFFERENT cube
    expect(getCubeMembers).toHaveBeenLastCalledWith('BadCube', 'product', '[product].[H1].[Product]');
    expect(filterOptionValues(fixture)).toEqual(['Gadget']);        // NEW cube's members — a stale-cache mutant reddens with ['Widget']
  });

  it('a slow member fetch resolving AFTER a cube switch does not write stale members into the new cube (A-CTP-IMPL-01, async)', async () => {
    // SalesCube's product fetch is gated (still in flight); we switch to BadCube, THEN resolve the stale
    // SalesCube fetch. A cube-blind write would poison [product].[H1].[Product] with SalesCube's members,
    // and the next ensureMembers would false-hit and skip BadCube. The write must be dropped as superseded.
    const gate = new Subject<{ members: { name: string }[] }>();
    const getCubeMembers = vi.fn((cube: string, _d: string, _l?: string) =>
      cube === 'SalesCube' ? gate.asObservable() : of({ members: [{ name: 'Gadget' }] }));
    const getCubeShape = vi.fn((cube: string) => (cube === 'BadCube' ? of(SHARED_LEVEL_SHAPE) : of(SHAPE)));
    const { fixture } = setup(getCubeShape, getCubeMembers);
    fixture.detectChanges(); await fixture.whenStable();

    pickCube(fixture, 'SalesCube');
    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[product].[H1].[Product]');          // SalesCube fetch subscribed, still in flight

    pickCube(fixture, 'BadCube');                                  // switch away before it resolves
    gate.next({ members: [{ name: 'Widget' }] }); gate.complete(); // stale SalesCube resolve arrives now
    fixture.detectChanges();

    openFilterDraft(fixture);
    pickFilterLevel(fixture, '[product].[H1].[Product]');          // BadCube must actually fetch (no false hit)
    expect(getCubeMembers).toHaveBeenLastCalledWith('BadCube', 'product', '[product].[H1].[Product]');
    expect(filterOptionValues(fixture)).toEqual(['Gadget']);       // a cube-blind write mutant reddens with ['Widget']
  });

  it('B-CUBE-15: choosing a non-first level titles that level and carries its spec; members fetched for it', async () => {
    const getCubeMembers = vi.fn((_c: string, _d: string, _l?: string) => of({ members: [{ name: 'Acme Ltd' }] }));
    const { fixture } = setup(undefined, getCubeMembers);
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    // Category dropdown option value is the LEVEL spec, not the dimension name:
    setCategoryLevel(fixture, '[customer].[H1].[CustomerName]');
    const base = preview(fixture)!.baseSelection()! as any;
    expect(base.dimensions).toContainEqual({ name: 'customer', role: 'category', level: '[customer].[H1].[CustomerName]' });
    // and picking that dimension's FIRST level omits `level` (preserving today's default byte-for-byte):
    setCategoryLevel(fixture, '[customer].[H1].[Country]');
    const base2 = preview(fixture)!.baseSelection()! as any;
    expect(base2.dimensions).toContainEqual({ name: 'customer', role: 'category' });
    expect(base2.dimensions.find((d: any) => d.name === 'customer')).not.toHaveProperty('level');
  });

  it('excludes the category dimension from the Series and Filter pickers (whole-dim role exclusivity, any level)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture); // region = category by default (its first level)
    // the Series dropdown groups levels under dimensions; region is on Category so NONE of its levels appear:
    const seriesGroups = [...el().querySelectorAll('[data-testid="series-dim-select"] optgroup')].map((g) => (g as HTMLOptGroupElement).label);
    expect(seriesGroups).not.toContain('Region');
  });

  it('emits valid=true on a complete pick, then valid=false when a later shape empties the pick (A3-PLAN-01)', async () => {
    // The regression the reviewer surfaced: valid MUST fall back to false when a completed
    // selection goes incomplete. The builder — always mounted — owns this, not the preview
    // (which unmounts behind @if (baseSelection()) and could never emit the false).
    const getCubeShape = vi.fn((cube: string) => (cube === 'BadCube' ? of(EMPTY_SHAPE) : of(SHAPE)));
    const { fixture } = setup(getCubeShape);
    const valids: boolean[] = [];
    fixture.componentInstance.valid.subscribe((v) => valids.push(v));
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture, 'SalesCube');
    expect(valids.at(-1)).toBe(true);            // complete → Save would enable
    expect(preview(fixture)).not.toBeNull();     // preview mounted
    pickCube(fixture, 'BadCube');                // empty shape nulls measures → baseSelection null
    expect(valids.at(-1)).toBe(false);           // readiness withdrawn — Save disables
    expect(preview(fixture)).toBeNull();          // preview unmounted; it could not have emitted this
  });

  it('emits valid=false when the shape fetch ERRORS after a valid pick (A3-PLAN-01)', async () => {
    const getCubeShape = vi.fn((cube: string) =>
      (cube === 'BadCube' ? throwError(() => ({ status: 500 })) : of(SHAPE)));
    const { fixture } = setup(getCubeShape);
    const valids: boolean[] = [];
    fixture.componentInstance.valid.subscribe((v) => valids.push(v));
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture, 'SalesCube');
    expect(valids.at(-1)).toBe(true);
    pickCube(fixture, 'BadCube');                // error path also nulls measures
    expect(valids.at(-1)).toBe(false);
  });

  it('the cube shape is fetched once per pick (a downstream type override is a pure preview edit)', async () => {
    const { fixture, getCubeShape } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    // A type override happens entirely inside the preview — no re-fetch here.
    expect(getCubeShape).toHaveBeenCalledTimes(1);
  });

  it('edit mode seeds the cube picker and passes seedType to the preview', async () => {
    const { fixture, el } = setup();
    fixture.componentRef.setInput('selection', {
      source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }], chartType: 'line',
    } as Extract<ChartSelection, { source: 'cube' }>);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(el().querySelector<HTMLSelectElement>('[data-testid="cube-select"]')!.value).toBe('SalesCube');
    expect(preview(fixture)!.seedType()).toBe('line');
  });

  it('edit mode rehydrates measures chips + category (with its saved level) / filter from a saved general selection', async () => {
    const getCubeMembers = vi.fn(() => of({ members: [{ name: 'West' }] }));
    const { fixture } = setup(undefined, getCubeMembers);
    fixture.componentRef.setInput('selection', {
      source: 'cube', cube: 'SalesCube', measures: ['Revenue', 'Units'],
      dimensions: [
        { name: 'customer', role: 'category', level: '[customer].[H1].[CustomerName]' }, // a saved NON-first level
        { name: 'product', role: 'filter', member: 'West' },
      ],
      chartType: 'bar',
    } as any);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const base = preview(fixture)!.baseSelection()! as any;
    expect(base.measures).toEqual(['Revenue', 'Units']);
    // the saved level round-trips (re-selected in the dropdown, re-emitted):
    expect(base.dimensions).toContainEqual({ name: 'customer', role: 'category', level: '[customer].[H1].[CustomerName]' });
    expect(base.dimensions).toContainEqual({ name: 'product', role: 'filter', member: 'West' });
  });

  // --- Cognitive-audit fixes (2026-08-31): distinct empty/loading/error/unchartable status,
  // async feedback on the fetches, an out-of-order guard, and a11y labelling. ---

  describe('builder status message (audit #1) — one string per state, never a misleading catch-all', () => {
    it('shows the "pick a cube" idle message ONLY before a cube is picked', async () => {
      const { fixture, el } = setup();
      fixture.detectChanges(); await fixture.whenStable();
      expect(el().querySelector('[data-testid="ccb-idle"]')).not.toBeNull();
      expect(el().querySelector('[data-testid="dimension-select"]')).toBeNull();
    });

    it('a picked-but-unchartable cube gets a cube-specific message, NOT "pick a cube"', async () => {
      const getCubeShape = vi.fn((cube: string) => (cube === 'BadCube' ? of(EMPTY_SHAPE) : of(SHAPE)));
      const { fixture, el } = setup(getCubeShape);
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'BadCube');
      expect(el().querySelector('[data-testid="ccb-unchartable"]')).not.toBeNull();
      expect(el().querySelector('[data-testid="ccb-idle"]')).toBeNull(); // the misleading string is gone
    });

    it('removing every measure on a chartable cube shows "add a measure", disables Save, and KEEPS the controls', async () => {
      const { fixture, el } = setup();
      const valids: boolean[] = [];
      fixture.componentInstance.valid.subscribe((v) => valids.push(v));
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube'); // Revenue auto-selected → valid
      expect(valids.at(-1)).toBe(true);
      el().querySelector<HTMLButtonElement>('.ccb__chip button')!.click(); // remove the only measure
      fixture.detectChanges();
      expect(valids.at(-1)).toBe(false);                                    // Save disables (A3-PLAN-01 holds)
      expect(el().querySelector('[data-testid="ccb-needs-measure"]')).not.toBeNull();
      expect(el().querySelector('[data-testid="ccb-idle"]')).toBeNull();
      expect(el().querySelector('[data-testid="add-measure"]')).not.toBeNull(); // controls stay so you can re-add
    });

    it('a shape-fetch error shows an error status with a Retry that re-fetches', async () => {
      let attempts = 0;
      const getCubeShape = vi.fn((cube: string) => {
        if (cube !== 'BadCube') return of(SHAPE);
        attempts++;
        return attempts === 1 ? throwError(() => ({ status: 500 })) : of(OTHER_SHAPE);
      });
      const { fixture, el } = setup(getCubeShape);
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'BadCube');
      expect(el().querySelector('[data-testid="ccb-error"]')).not.toBeNull();
      expect(el().querySelector('[data-testid="ccb-idle"]')).toBeNull();
      el().querySelector<HTMLButtonElement>('[data-testid="ccb-error"] button')!.click(); // Retry
      fixture.detectChanges();
      expect(getCubeShape).toHaveBeenCalledTimes(2);
      expect(el().querySelector('[data-testid="ccb-error"]')).toBeNull();
      expect(el().querySelector('[data-testid="dimension-select"]')).not.toBeNull(); // recovered
    });
  });

  describe('async feedback + out-of-order guard (audit #2/#5/#9)', () => {
    it('shows a loading status while the shape is in flight, and clears the prior cube\'s controls', async () => {
      const sales = of(SHAPE);
      const gate = new Subject<CubeShape>();
      let calls = 0;
      const getCubeShape = vi.fn((_c: string) => (++calls === 1 ? sales : gate.asObservable()));
      const { fixture, el } = setup(getCubeShape);
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube'); // resolves immediately → controls shown
      expect(el().querySelector('[data-testid="dimension-select"]')).not.toBeNull();
      pickCube(fixture, 'BadCube');   // second fetch pending → stale controls cleared, loading shown (#9)
      expect(el().querySelector('[data-testid="dimension-select"]')).toBeNull();
      expect(el().querySelector('[data-testid="ccb-loading"]')).not.toBeNull();
      gate.next(OTHER_SHAPE); fixture.detectChanges();
      expect(el().querySelector('[data-testid="ccb-loading"]')).toBeNull();
      expect(el().querySelector('[data-testid="dimension-select"]')).not.toBeNull();
    });

    it('drops an out-of-order shape response — a fast re-pick wins even if the earlier shape resolves last (#5)', async () => {
      const sales = new Subject<CubeShape>();
      const bad = new Subject<CubeShape>();
      const getCubeShape = vi.fn((cube: string) => (cube === 'SalesCube' ? sales : bad).asObservable());
      const { fixture } = setup(getCubeShape);
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube'); // fetch 1 in flight
      pickCube(fixture, 'BadCube');   // fetch 2 supersedes it
      bad.next(OTHER_SHAPE);          // the later pick resolves FIRST
      fixture.detectChanges();
      sales.next(SHAPE);              // the earlier pick resolves LATE — must be dropped
      fixture.detectChanges();
      expect(fixture.componentInstance.shape()!.measures[0]!.name).toBe('Zeta'); // OTHER_SHAPE won
      expect((preview(fixture)!.baseSelection()! as any).measures).toEqual(['Zeta']);
    });

    // The filter-member loading + error/retry behaviour is now pinned by the add-filter chip tests
    // above (member-fetch success + reddenable error path), replacing the deleted tree's own coverage.
  });

  describe('accessibility + information scent (audit #3/#4/#6/#8)', () => {
    it('the add-measure select carries an accessible name (#3)', async () => {
      const { fixture, el } = setup();
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube');
      expect(el().querySelector('[data-testid="add-measure"]')!.getAttribute('aria-label')).toBeTruthy();
    });

    it('a disabled control links its explanatory note via aria-describedby (#4)', async () => {
      const { fixture, el } = setup();
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube');
      addMeasure(fixture, 'Units'); // 2 measures → the Series control is blocked
      const series = el().querySelector<HTMLSelectElement>('[data-testid="series-dim-select"]')!;
      expect(series.disabled).toBe(true);
      const describedby = series.getAttribute('aria-describedby');
      expect(describedby).toBeTruthy();
      expect(el().querySelector('[data-testid="series-blocked-note"]')!.id).toBe(describedby);
    });

    it('the Series control hints it is a second-dimension breakdown (#6)', async () => {
      const { fixture, el } = setup();
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube'); // 1 measure → not blocked
      const series = el().querySelector<HTMLSelectElement>('[data-testid="series-dim-select"]')!;
      expect((series.getAttribute('title') ?? '').toLowerCase()).toContain('second dimension');
    });

    it('glosses the OLAP vocabulary (Cube, Measures) for first-time users (#8)', async () => {
      const { fixture, el } = setup();
      fixture.detectChanges(); await fixture.whenStable();
      pickCube(fixture, 'SalesCube');
      // The gloss now rides the SECTION-TITLE word (label-collapse, SC-2665) — the per-widget
      // .ccb__label is gone. The title= must survive on the title span that names the control.
      const cubeLabel = el().querySelector('#ccb-cube-label')!;
      const measuresLabel = el().querySelector('#ccb-measures-label')!;
      expect(cubeLabel.textContent?.trim()).toBe('Cube');
      expect(measuresLabel.textContent?.trim()).toBe('Measures');
      expect(cubeLabel.getAttribute('title')).toBeTruthy();
      expect(measuresLabel.getAttribute('title')).toBeTruthy();
      // And the cube select takes its accessible name from that title word, with no repeated label:
      expect(el().querySelector('[data-testid="cube-select"]')!.getAttribute('aria-labelledby')).toBe('ccb-cube-label');
      expect(el().querySelector('.ccb__label')).toBeNull();
    });
  });

  it('renders a section title + hint for the Filters section and at least one other (so dropping chrome reddens)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture, 'SalesCube');
    const titles = [...el().querySelectorAll('.ccb__section-title')].map((t) => t.textContent?.trim().toLowerCase() ?? '');
    expect(titles.some((t) => t.includes('filters'))).toBe(true);
    expect(titles.some((t) => t.includes('measures'))).toBe(true);
    expect(el().querySelectorAll('.ccb__section-hint').length).toBeGreaterThanOrEqual(2);
    // the OLAP gloss is preserved on the section-title word (Cube still carries title=) — §6.2,
    // now that the per-widget .ccb__label was collapsed into the title (SC-2665):
    expect(el().querySelector('#ccb-cube-label')!.getAttribute('title')).toBeTruthy();
  });

  it('collapses the per-widget label into the section title: no .ccb__label, each picker named via aria-labelledby (SC-2665)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture, 'SalesCube');
    // The redundant per-widget label span is gone everywhere.
    expect(el().querySelectorAll('.ccb__label')).toHaveLength(0);
    // Each single-select picker takes its accessible name from its section-title word, and the
    // referenced id actually exists (a dangling aria-labelledby names nothing).
    for (const [testid, labelId] of [
      ['cube-select', 'ccb-cube-label'],
      ['dimension-select', 'ccb-category-label'],
      ['series-dim-select', 'ccb-series-label'],
    ] as const) {
      const ctl = el().querySelector(`[data-testid="${testid}"]`)!;
      expect(ctl.getAttribute('aria-labelledby')).toBe(labelId);
      expect(el().querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
    }
  });

  it('promotes the bubble Size picker to a titled section named via aria-labelledby (SC-2665)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture, 'SalesCube');
    // Enter bubble mode via the preview's draftChange, mirroring the bubble-size test at :554.
    const base = preview(fixture)!.baseSelection()! as any;
    preview(fixture)!.draftChange.emit({ ...base, chartType: 'bubble' });
    fixture.detectChanges();
    const size = el().querySelector('[data-testid="bubble-size"]')!;
    expect(size).not.toBeNull();
    // It sits in a titled section (no bare label) and is named by that title.
    expect(size.getAttribute('aria-labelledby')).toBe('ccb-size-label');
    expect(el().querySelector('#ccb-size-label')?.textContent?.trim()).toBe('Size');
    expect(el().querySelectorAll('.ccb__label')).toHaveLength(0);
  });

  it('every picker shares one width class (uniform rows, §6.3 crit 1)', async () => {
    const { fixture, el } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture, 'SalesCube');
    fixture.componentInstance.openDraftFilter();
    fixture.componentInstance.onDraftFilterLevel('[product].[H1].[Product]');
    fixture.detectChanges();
    for (const id of ['cube-select', 'add-measure', 'dimension-select', 'series-dim-select', 'filter-level-select', 'filter-member-input']) {
      expect(el().querySelector(`[data-testid="${id}"]`)!.classList.contains('ccb__control')).toBe(true);
    }
  });

  it('shows a cube-loading indicator while the catalog fetch is in flight, gone once it resolves (§6.3)', async () => {
    const gate = new Subject<{ cubes: ChartableCube[] }>();
    const { fixture, el } = setup(undefined, undefined, vi.fn(() => gate.asObservable()));
    fixture.detectChanges();                                   // ngOnInit → loadingCubes(true), fetch pending
    expect(el().querySelector('[data-testid="cube-loading"]')).not.toBeNull();
    gate.next({ cubes: CUBES }); gate.complete(); fixture.detectChanges();
    expect(el().querySelector('[data-testid="cube-loading"]')).toBeNull();
  });

  it('picking bubble ensures a size measure — appends %COUNT when only two measures are set', async () => {
    const THREE_MEASURE_SHAPE: CubeShape = {
      cube: 'SalesCube',
      measures: [{ name: 'Revenue', caption: 'Revenue' }, { name: 'Units', caption: 'Units' }, { name: 'Cost', caption: 'Cost' }],
      dimensions: SHAPE.dimensions,
    };
    const { fixture, el } = setup(vi.fn((_c: string) => of(THREE_MEASURE_SHAPE)));
    fixture.detectChanges(); await fixture.whenStable();
    pickCube(fixture);
    const initial = (preview(fixture)!.baseSelection()! as any).measures;
    expect(initial.length).toBe(1);
    addMeasure(fixture, 'Units');
    const beforeBubble = (preview(fixture)!.baseSelection()! as any).measures;
    expect(beforeBubble.length).toBe(2);
    expect(beforeBubble).toContain('Units');
    preview(fixture)!.draftChange.emit({ source: 'cube', cube: 'SalesCube', measures: beforeBubble, chartType: 'bubble' });
    fixture.detectChanges();
    const withBubble = (preview(fixture)!.baseSelection()! as any).measures;
    expect(withBubble.length).toBe(3);
    expect(withBubble[2]).toBe('%COUNT');
    expect(el().querySelector('[data-testid="bubble-size"]')).not.toBeNull();
    const bubbleSize = el().querySelector<HTMLSelectElement>('[data-testid="bubble-size"]')!;
    bubbleSize.value = 'Cost'; bubbleSize.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const withCost = (preview(fixture)!.baseSelection()! as any).measures;
    expect(withCost.length).toBe(3);
    expect(withCost[2]).toBe('Cost');
  });
});
