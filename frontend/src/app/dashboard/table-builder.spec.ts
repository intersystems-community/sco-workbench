// frontend/src/app/dashboard/table-builder.spec.ts
import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, type Observable } from 'rxjs';
import { TableBuilderComponent } from './table-builder';
import { ScModelService } from '../services/sc-model.service';
import { DataBrowserService } from '../services/data-browser.service';
import type { TableSelection } from './dashboard-config';
import type { ScObjectSummary } from '../services/sc-model.types';

// Stub the preview tile (real selector) so the builder mounts without pulling the
// view tile's ScData/ScModel HTTP into this picker-only test.
@Component({ selector: 'app-table-tile-view', standalone: true, template: '<div class="stub-preview"></div>' })
class StubTablePreview { readonly selection = input<unknown>(); }

const OBJECTS: ScObjectSummary[] = [
  { objectName: 'Carrier', className: 'SC.Data.Carrier', description: 'Carriers', isCustom: false },
  { objectName: 'ProductInventory', className: 'SC.Data.ProductInventory', description: 'Inventory', isCustom: false },
];

function setup(objs: ScObjectSummary[] = OBJECTS, detail: unknown = { attributes: [] },
               objectsObs?: Observable<ScObjectSummary[]>) {
  TestBed.resetTestingModule();
  const getObjects = vi.fn(() => objectsObs ?? of(objs));
  const getObjectDetail = vi.fn((_objectName: string) => of(detail));
  const getCounts = vi.fn(() => of({
    'SC.Data.Carrier': { ok: true, total: 12 },
    'SC.Data.ProductInventory': { ok: true, total: 0 },
  } as any));
  TestBed.configureTestingModule({
    imports: [TableBuilderComponent],
    providers: [
      { provide: ScModelService, useValue: { getObjects, getObjectDetail } },
      { provide: DataBrowserService, useValue: { getCounts } },
    ],
  });
  TestBed.overrideComponent(TableBuilderComponent, { set: { imports: [StubTablePreview] } });
  const fixture: ComponentFixture<TableBuilderComponent> = TestBed.createComponent(TableBuilderComponent);
  return { fixture, getObjects, getObjectDetail, getCounts };
}

const CARRIER_COLS = { attributes: [{ name: 'uid' }, { name: 'name' }, { name: 'trackingUrl' }] };

function selectTable(fixture: ComponentFixture<TableBuilderComponent>, className: string) {
  const el = fixture.nativeElement as HTMLElement;
  const select = el.querySelector<HTMLSelectElement>('[data-testid="table-select"]')!;
  select.value = className;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

// jsdom has no real DataTransfer and its DragEvent does not carry one, so drag glue can only
// be exercised with stubs. This minimal store backs getData/setData and the effect fields the
// handlers read/write — enough to drive dragstart→dragover→drop through the template bindings.
function stubDataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: 'none' as string,
    dropEffect: 'none' as string,
    setData: (type: string, val: string) => { store[type] = val; },
    getData: (type: string) => store[type] ?? '',
  };
}

// A plain Event tagged as the drag type, with the stub dataTransfer attached — dispatching it
// runs the component's real (dragstart)/(dragover)/(drop)/… handlers exactly as the browser would.
function dragEvent(type: string, dataTransfer: ReturnType<typeof stubDataTransfer>): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
  return ev;
}

describe('TableBuilderComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('wraps the Table picker and Columns fieldset in house section chrome with hints', async () => {
    const { fixture } = setup(OBJECTS, CARRIER_COLS);
    fixture.detectChanges(); await fixture.whenStable();
    selectTable(fixture, 'SC.Data.Carrier');
    await fixture.whenStable(); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const titles = [...el.querySelectorAll('.db-builder-section-title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('Table'))).toBe(true);
    expect(titles.some((t) => t.includes('Columns'))).toBe(true);
    expect(el.querySelectorAll('.db-builder-section-hint').length).toBeGreaterThanOrEqual(2);
    expect(el.querySelector('[data-testid="table-select"]')!.classList.contains('db-builder-control')).toBe(true);
  });

  it('collapses the Table picker label into its section title: no .tb__label, select named via aria (SC-2665)', async () => {
    const { fixture } = setup(OBJECTS, CARRIER_COLS);
    fixture.detectChanges(); await fixture.whenStable();
    selectTable(fixture, 'SC.Data.Carrier');
    await fixture.whenStable(); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    // The redundant "Table" label span is gone — matching Columns, which already names itself once.
    expect(el.querySelectorAll('.tb__label')).toHaveLength(0);
    const select = el.querySelector('[data-testid="table-select"]')!;
    expect(select.getAttribute('aria-labelledby')).toBe('tb-table-label');
    expect(select.getAttribute('aria-describedby')).toBe('tb-table-hint');
    expect(el.querySelector('#tb-table-label')?.textContent?.trim()).toBe('Table');
    expect(el.querySelector('#tb-table-hint')?.textContent?.trim()).toBeTruthy();
  });

  it('shows table-loading while getObjects is pending, gone once resolved', () => {
    const gate = new Subject<ScObjectSummary[]>();
    const { fixture } = setup(OBJECTS, { attributes: [] }, gate.asObservable());
    fixture.detectChanges();                                   // ngOnInit → loadingObjects(true), fetch pending
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="table-loading"]')).not.toBeNull();
    gate.next(OBJECTS); gate.complete(); fixture.detectChanges();
    expect(el.querySelector('[data-testid="table-loading"]')).toBeNull();
  });

  it('selecting a table emits a TableSelection with that className and marks itself valid', async () => {
    const { fixture } = setup();
    const selections: TableSelection[] = [];
    const valids: boolean[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
    fixture.componentInstance.valid.subscribe((v) => valids.push(v));
    fixture.detectChanges();
    await fixture.whenStable();
    selectTable(fixture, 'SC.Data.Carrier');
    expect(selections).toEqual([{ table: 'SC.Data.Carrier' }]);
    expect(valids.at(-1)).toBe(true);
  });

  it('emits selectionChange (a TableSelection, never a spec or resource) — the product is the selection', async () => {
    const { fixture } = setup();
    let emitted: TableSelection | null = null;
    fixture.componentInstance.selectionChange.subscribe((s) => (emitted = s));
    fixture.detectChanges();
    await fixture.whenStable();
    selectTable(fixture, 'SC.Data.ProductInventory');
    // A plain selection: exactly { table }, nothing built.
    expect(emitted).toEqual({ table: 'SC.Data.ProductInventory' });
    expect(Object.keys(emitted!)).toEqual(['table']);
  });

  it('starts invalid (no table chosen) and previews nothing until a table is picked', async () => {
    const { fixture } = setup();
    const valids: boolean[] = [];
    fixture.componentInstance.valid.subscribe((v) => valids.push(v));
    fixture.detectChanges();
    await fixture.whenStable();
    // The very first valid emission is false (nothing picked yet).
    expect(valids[0]).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('app-table-tile-view')).toBeFalsy();
  });

  it('initializing from an input selection pre-selects the dropdown and previews it', async () => {
    const { fixture } = setup();
    fixture.componentRef.setInput('selection', { table: 'SC.Data.ProductInventory' } as TableSelection);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLSelectElement>('[data-testid="table-select"]')!.value).toBe('SC.Data.ProductInventory');
    // The preview tile is mounted with the pre-selected table.
    expect(el.querySelector('app-table-tile-view')).toBeTruthy();
  });

  it('lists tables with their up-front row counts, populated first (Change 6/M2 parity)', async () => {
    const { fixture } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const opts = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLOptionElement>('[data-testid="table-select"] option')];
    // "" placeholder, then Carrier (12) before ProductInventory (0) — populated first.
    const labels = opts.map((o) => o.textContent?.trim());
    expect(labels[0]).toMatch(/select a table/i);
    expect(labels[1]).toContain('Carrier');
    expect(labels[1]).toContain('12');
    expect(labels[2]).toContain('Product Inventory');
  });

  describe('column control (B2)', () => {
    it('shows a row per scmodel column once a table is picked, all included by default', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="column-control"]')).toBeTruthy();
      expect(el.querySelectorAll('[data-testid="col-row"]')).toHaveLength(3); // all included
      // Every column is in, so the pool is empty — the Add affordance is hidden (nothing to add).
      expect(el.querySelector('[data-testid="col-add-btn"]')).toBeFalsy();
    });

    it('keeping every column in natural order omits the columns key (equivalent to "all")', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier' });
      expect(Object.keys(selections.at(-1)!)).toEqual(['table']);
      // And exactly once — onSelect emits {table}, the column-load effect re-derives an
      // identical {table}, and emitSelection's deep-equal guard suppresses the duplicate.
      // This pins the guard (B-PLAN-01) so a regression that drops it turns THIS spec red,
      // not only the pre-existing exact-array assertion at :60.
      expect(selections).toEqual([{ table: 'SC.Data.Carrier' }]);
    });

    it('unchecking a column emits an ordered subset in columns', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      // Uncheck the middle column ('name').
      const el = fixture.nativeElement as HTMLElement;
      const rows = el.querySelectorAll<HTMLElement>('[data-testid="col-row"]');
      rows[1]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier', columns: ['uid', 'trackingUrl'] });
    });

    it('moving a column down changes the emitted order', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Move the first column ('uid') down one.
      el.querySelectorAll<HTMLButtonElement>('[data-testid="col-down"]')[0]!.click();
      fixture.detectChanges();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier', columns: ['name', 'uid', 'trackingUrl'] });
    });

    it('does not let the user uncheck the last remaining column', async () => {
      const { fixture } = setup(OBJECTS, { attributes: [{ name: 'uid' }, { name: 'name' }] });
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Uncheck 'name' — one left ('uid'), whose checkbox must now be disabled.
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      const remaining = el.querySelectorAll<HTMLElement>('[data-testid="col-row"]');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    });

    it('adding an excluded column from the Add menu appends it to the end of the order', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Exclude 'uid' (row 0) — it leaves the selected list and joins the Add-menu pool.
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[0]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      // Re-add it from the Add menu (not a persistent excluded-row) — appends to the end.
      el.querySelector<HTMLButtonElement>('[data-testid="col-add-btn"]')!.click();
      fixture.detectChanges();
      const items = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="col-add-item"]')];
      items.find((b) => b.textContent?.trim() === 'UID')!.click();
      fixture.detectChanges();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier', columns: ['name', 'trackingUrl', 'uid'] });
    });

    it('closes an open Add menu when a selected column is reordered', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Exclude 'name' so the Add pool is non-empty and the menu can open.
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('[data-testid="col-add-btn"]')!.click();
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="col-add-menu"]')).toBeTruthy();
      // Reorder a still-selected column — the transient popover must dismiss, matching the
      // tile-host ⋯ menu (acting closes it). The Add button stays (the pool is unchanged).
      el.querySelector<HTMLButtonElement>('[data-testid="col-down"]')!.click();
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="col-add-menu"]')).toBeFalsy();
      expect(el.querySelector('[data-testid="col-add-btn"]')).toBeTruthy();
    });

    it('closes an open Add menu on a click outside the builder', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('[data-testid="col-add-btn"]')!.click();
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="col-add-menu"]')).toBeTruthy();
      // A click anywhere outside the builder dismisses the popover (tile-host idiom).
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="col-add-menu"]')).toBeFalsy();
    });

    it('collapses the available columns behind an Add menu — never renders them as persistent rows', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Exclude 'name' — the vertical-footprint fix: it must NOT become a persistent row.
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      // Two selected rows remain; the excluded column is reachable only via the Add menu,
      // which is closed by default (so the control's height is ~selected + 1, not + all).
      expect(el.querySelectorAll('[data-testid="col-row"]')).toHaveLength(2);
      expect(el.querySelector('[data-testid="col-add-btn"]')).toBeTruthy();
      expect(el.querySelector('[data-testid="col-add-menu"]')).toBeFalsy(); // collapsed until opened
      // Open it — the excluded column is offered there.
      el.querySelector<HTMLButtonElement>('[data-testid="col-add-btn"]')!.click();
      fixture.detectChanges();
      const items = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="col-add-item"]')].map((b) => b.textContent?.trim());
      expect(items).toEqual(['Name']);
    });

    it('filters the Add menu to matching columns as the user types', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Drop both 'name' and 'trackingUrl' into the pool so the menu has two items to filter.
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('[data-testid="col-add-btn"]')!.click();
      fixture.detectChanges();
      // Two items before filtering (a 20+ list needs this affordance — Hick's Law).
      expect(el.querySelectorAll('[data-testid="col-add-item"]')).toHaveLength(2);
      const filter = el.querySelector<HTMLInputElement>('[data-testid="col-add-filter"]')!;
      filter.value = 'track';
      filter.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      const items = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="col-add-item"]')].map((b) => b.textContent?.trim());
      expect(items).toEqual(['Tracking URL']);
    });

    it('shows no column control and emits { table } when scmodel returns no attributes', async () => {
      const { fixture } = setup(OBJECTS, { attributes: [] });
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="column-control"]')).toBeFalsy();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier' });
    });

    it('names the column in each reorder arrow aria-label (not a generic "Move up")', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const firstRow = el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[0]!;
      // Humanized column label ('uid' -> 'UID') must appear in the arrows' accessible names,
      // so a screen-reader user hears WHICH column each arrow moves.
      expect(firstRow.querySelector('[data-testid="col-up"]')!.getAttribute('aria-label')).toContain('UID');
      expect(firstRow.querySelector('[data-testid="col-down"]')!.getAttribute('aria-label')).toContain('UID');
    });

    it('dragging a column onto another position reorders the emitted set', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      // Drop the last column ('trackingUrl', index 2) onto the first slot (index 0) — the
      // one-shot power move the arrows would take two clicks to do. Reorder logic is tested
      // directly (jsdom has no real DnD); the grip's drag events call this same method.
      fixture.componentInstance.moveColumnTo('trackingUrl', 0);
      fixture.detectChanges();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier', columns: ['trackingUrl', 'uid', 'name'] });
    });

    it('drives the reorder through the real drag glue: dragstart → dragover → drop', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const rows = el.querySelectorAll<HTMLElement>('[data-testid="col-row"]');
      const dt = stubDataTransfer();
      // Grab the LAST row's grip ('trackingUrl') — the template's (dragstart) binding runs.
      rows[2]!.querySelector('[data-testid="col-grip"]')!.dispatchEvent(dragEvent('dragstart', dt));
      fixture.detectChanges();
      // The handler stashed the column key + a 'move' effect on the dataTransfer.
      expect(dt.getData('text/plain')).toBe('trackingUrl');
      expect(dt.effectAllowed).toBe('move');
      // Dragging over the FIRST row marks it as the live drop target AND allows the drop
      // (preventDefault), so the browser doesn't reject it.
      const overEv = dragEvent('dragover', dt);
      rows[0]!.dispatchEvent(overEv);
      fixture.detectChanges();
      expect(rows[0]!.classList.contains('tb__col-row--dragover')).toBe(true);
      expect(overEv.defaultPrevented).toBe(true);
      expect(dt.dropEffect).toBe('move');
      // Dropping on the first row reorders via the same moveColumnTo core — to the front.
      rows[0]!.dispatchEvent(dragEvent('drop', dt));
      fixture.detectChanges();
      expect(selections.at(-1)).toEqual({ table: 'SC.Data.Carrier', columns: ['trackingUrl', 'uid', 'name'] });
      // The drop cleared the target marker (no row is left highlighted).
      expect(el.querySelector('.tb__col-row--dragover')).toBeFalsy();
    });

    it('clears the drag-over marker on dragleave and abandons a drag on dragend', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      const selections: TableSelection[] = [];
      fixture.componentInstance.selectionChange.subscribe((s) => selections.push(s));
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const rows = el.querySelectorAll<HTMLElement>('[data-testid="col-row"]');
      const dt = stubDataTransfer();
      rows[0]!.querySelector('[data-testid="col-grip"]')!.dispatchEvent(dragEvent('dragstart', dt));
      fixture.detectChanges();
      // Hover the second row, then leave it — the highlight must follow and then clear.
      rows[1]!.dispatchEvent(dragEvent('dragover', dt));
      fixture.detectChanges();
      expect(rows[1]!.classList.contains('tb__col-row--dragover')).toBe(true);
      rows[1]!.dispatchEvent(dragEvent('dragleave', dt));
      fixture.detectChanges();
      expect(el.querySelector('.tb__col-row--dragover')).toBeFalsy();
      // dragend without a drop abandons the gesture: no reorder emitted beyond the initial pick.
      rows[0]!.querySelector('[data-testid="col-grip"]')!.dispatchEvent(dragEvent('dragend', dt));
      fixture.detectChanges();
      expect(selections).toEqual([{ table: 'SC.Data.Carrier' }]);
    });

    it('exposes a keyboard-accessible reorder path (arrows) alongside the drag grips', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.detectChanges();
      await fixture.whenStable();
      selectTable(fixture, 'SC.Data.Carrier');
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const firstRow = el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[0]!;
      // A draggable grip exists AND the arrow buttons remain — drag must be additive, never
      // the only way to reorder (WCAG 2.1.1: pointer-only reorder excludes keyboard users).
      expect(firstRow.querySelector('[data-testid="col-grip"]')).toBeTruthy();
      expect(firstRow.querySelector('[data-testid="col-up"]')).toBeTruthy();
      expect(firstRow.querySelector('[data-testid="col-down"]')).toBeTruthy();
    });

    it('edit mode restores a stored subset in its stored order', async () => {
      const { fixture } = setup(OBJECTS, CARRIER_COLS);
      fixture.componentRef.setInput('selection', { table: 'SC.Data.Carrier', columns: ['trackingUrl', 'uid'] } as TableSelection);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const included = [...el.querySelectorAll<HTMLElement>('[data-testid="col-row"] .tb__col-check > span')].map((s) => s.textContent?.trim());
      // Included, in stored order (humanized labels).
      expect(included).toEqual(['Tracking URL', 'UID']);
      // 'name' is excluded — reachable via the Add menu, not a persistent row.
      el.querySelector<HTMLButtonElement>('[data-testid="col-add-btn"]')!.click();
      fixture.detectChanges();
      const offered = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="col-add-item"]')].map((b) => b.textContent?.trim());
      expect(offered).toEqual(['Name']);
    });
  });

  describe('preview layout (SC-2665)', () => {
    // Returns BOTH the host element and the fixture: the Add-trigger test must drive a change
    // detection pass after dispatching the checkbox event (OnPush + zoneless does not auto-run
    // one), exactly as the emit-order baseline at table-builder.spec.ts:182-183 does.
    async function ready() {
      const s = setup(OBJECTS, CARRIER_COLS);
      s.fixture.detectChanges(); await s.fixture.whenStable();
      selectTable(s.fixture, 'SC.Data.Carrier');
      await s.fixture.whenStable(); s.fixture.detectChanges();
      return { el: s.fixture.nativeElement as HTMLElement, fixture: s.fixture };
    }

    it('renders the preview BEFORE the columns fieldset (pinned-on-top order)', async () => {
      const { el } = await ready();
      const preview = el.querySelector('.tb__preview')!;
      const columns = el.querySelector('[data-testid="column-control"]')!;
      expect(preview).toBeTruthy();
      expect(columns).toBeTruthy();
      // columns FOLLOWS preview in document order (a mutant reverting placement reddens).
      expect(preview.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('wraps the column rows in a bounded internal scroller (compiled CSS contract)', async () => {
      const { el } = await ready();
      const scroll = el.querySelector('.tb__col-scroll');
      expect(scroll).toBeTruthy();
      expect(scroll!.querySelectorAll('[data-testid="col-row"]').length).toBeGreaterThan(0);
      // Class rule under Emulated compiles to `.tb__col-scroll[_ngcontent-<id>]{…}` — use the
      // concatenated-<style> idiom (dashboard-grid.spec.ts:126-138), NOT the _nghost host idiom.
      // The selector-spanning regex proves the decl sits INSIDE the .tb__col-scroll block, so a
      // mutant that strips the scroller reddens.
      const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
      expect(css).toMatch(/\.tb__col-scroll[^{]*\{[^}]*overflow:\s*auto/);
      expect(css).toMatch(/\.tb__col-scroll[^{]*\{[^}]*min-height:\s*0/);
    });

    it('fills its host so the fill-height chain resolves (:host compiled contract)', async () => {
      const { el } = await ready();                   // el is the app-table-builder host element
      const nghost = Array.from(el.attributes).map((a) => a.name).find((n) => n.startsWith('_nghost'));
      expect(nghost).toBeTruthy();
      // :host rule compiles to `[_nghost-<id>]{…}` — match THIS host's own rule
      // (mirror of table-tile-view.spec.ts:215-225).
      const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
      expect(css).toMatch(new RegExp(`\\[${nghost}\\][^{]*\\{[^}]*min-height:\\s*0`));
      expect(css).toMatch(new RegExp(`\\[${nghost}\\][^{]*\\{[^}]*flex:`));
    });

    it('keeps the Add trigger OUTSIDE the scroller and before it (popover never inside overflow:auto)', async () => {
      const { el, fixture } = await ready();
      // Uncheck a column so the pool is non-empty and the Add trigger renders.
      el.querySelectorAll<HTMLElement>('[data-testid="col-row"]')[1]!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
      fixture.detectChanges();   // MANDATORY (zoneless/OnPush) — mirrors the emit baseline at :182-183; without it .tb__add is null
      const add = el.querySelector('.tb__add')!;
      const scroll = el.querySelector('.tb__col-scroll')!;
      expect(add).toBeTruthy();
      expect(scroll).toBeTruthy();
      expect(scroll.contains(add)).toBe(false);                                   // not inside the scroll region
      expect(add.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // add precedes scroll
    });

    it('keeps the columns fieldset an accessible name via a <legend> first child containing "Columns"', async () => {
      const { el } = await ready();
      const fieldset = el.querySelector('[data-testid="column-control"]')!;
      const legend = fieldset.firstElementChild!;   // @if add-block is a structural directive, no wrapper element
      expect(legend.tagName).toBe('LEGEND');
      expect(legend.textContent).toContain('Columns');
    });
  });
});
