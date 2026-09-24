// frontend/src/app/dashboard/tile-editor.spec.ts
import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TileEditorComponent, type TileEditorRequest } from './tile-editor';
import type { TileConfig, TableSelection, ChartSelection } from './dashboard-config';

// Stub the two builders with their real selectors + matching I/O, so the editor
// wires up without pulling the builders' catalog/shape HTTP into this modal test.
// A test drives selectionChange / valid to simulate the hosted builder.
@Component({ selector: 'app-table-builder', standalone: true, template: '<div class="stub-table-builder"></div>' })
class StubTableBuilder {
  readonly selection = input<TableSelection | null>(null);
  readonly selectionChange = output<TableSelection>();
  readonly valid = output<boolean>();
}
@Component({ selector: 'app-cube-chart-builder', standalone: true, template: '<div class="stub-cube-builder"></div>' })
class StubCubeBuilder {
  readonly selection = input<ChartSelection | null>(null);
  readonly selectionChange = output<ChartSelection>();
  readonly valid = output<boolean>();
}
@Component({ selector: 'app-kpi-chart-builder', standalone: true, template: '<div class="stub-kpi-builder"></div>' })
class StubKpiBuilder {
  readonly selection = input<ChartSelection | null>(null);
  readonly selectionChange = output<ChartSelection>();
  readonly valid = output<boolean>();
}

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [TileEditorComponent] });
  TestBed.overrideComponent(TileEditorComponent, { set: { imports: [StubTableBuilder, StubCubeBuilder, StubKpiBuilder] } });
  const fixture: ComponentFixture<TileEditorComponent> = TestBed.createComponent(TileEditorComponent);
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function openWith(fixture: ComponentFixture<TileEditorComponent>, req: TileEditorRequest) {
  fixture.componentRef.setInput('open', req);
  fixture.detectChanges();
}

/** The stub instance for the given builder selector, to drive its outputs. */
function builder<T>(fixture: ComponentFixture<TileEditorComponent>, Stub: new () => T): T | null {
  const de = fixture.debugElement.query((d) => d.componentInstance instanceof (Stub as any));
  return de ? (de.componentInstance as T) : null;
}

describe('TileEditorComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is closed (renders nothing) until `open` is set', () => {
    const { fixture, el } = setup();
    fixture.detectChanges();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opening in add mode asks the kind first, then mounts the chosen builder', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    // Kind picker shown, no builder yet.
    expect(el.querySelector('[data-testid="kind-table"]')).toBeTruthy();
    expect(el.querySelector('app-cube-chart-builder')).toBeNull();
    expect(el.querySelector('app-table-builder')).toBeNull();
    // Choose Cube → the cube chart builder mounts, the table builder does not.
    el.querySelector<HTMLButtonElement>('[data-testid="kind-cube"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('app-cube-chart-builder')).toBeTruthy();
    expect(el.querySelector('app-table-builder')).toBeNull();
  });

  it('offers three add choices: Table, Cube, KPI', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    expect(el.querySelector('[data-testid="kind-table"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="kind-cube"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="kind-kpi"]')).toBeTruthy();
    // The old single "Chart" button is gone.
    expect(el.querySelector('[data-testid="kind-chart"]')).toBeNull();
  });

  it('renders the three add choices in Cube, KPI, Table order (A2)', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    const order = [...el.querySelectorAll<HTMLElement>('.te-kind__btn')]
      .map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['kind-cube', 'kind-kpi', 'kind-table']);
  });

  it('Table mounts the table builder (kind:table, no locked source)', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="kind-table"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('app-table-builder')).toBeTruthy();
    expect(el.querySelector('app-cube-chart-builder')).toBeNull();
    expect(el.querySelector('app-kpi-chart-builder')).toBeNull();
  });

  it('Cube mounts the cube chart builder', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="kind-cube"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('app-cube-chart-builder')).toBeTruthy();
    expect(el.querySelector('app-kpi-chart-builder')).toBeNull();
  });

  it('KPI mounts the KPI chart builder', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="kind-kpi"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('app-kpi-chart-builder')).toBeTruthy();
    expect(el.querySelector('app-cube-chart-builder')).toBeNull();
  });

  it('edit mode mounts the builder matching the stored chart source', () => {
    const { fixture, el } = setup();
    const kpiTile: TileConfig = {
      id: 'tile-9', kind: 'chart', title: 'KPI tile', layout: { w: 1, h: 1 },
      selection: { source: 'kpi', kpi: 'OnHand' },
    };
    openWith(fixture, { mode: 'edit', tile: kpiTile });
    expect(el.querySelector('app-kpi-chart-builder')).toBeTruthy();
    expect(el.querySelector('app-cube-chart-builder')).toBeNull();
    // A cube tile mounts the cube builder instead.
    const cubeTile: TileConfig = {
      id: 'tile-10', kind: 'chart', title: 'Cube tile', layout: { w: 1, h: 1 },
      selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'] },
    };
    openWith(fixture, { mode: 'edit', tile: cubeTile });
    expect(el.querySelector('app-cube-chart-builder')).toBeTruthy();
    expect(el.querySelector('app-kpi-chart-builder')).toBeNull();
  });

  it('is a real dialog: role="dialog", aria-modal, and moves focus inside on open', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    const dialog = el.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Focus landed inside the dialog (the dialog element itself is focusable).
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Save emits a TileConfig carrying the builder selection and a defaulted title when blank', () => {
    const { fixture, el } = setup();
    const saved: TileConfig[] = [];
    fixture.componentInstance.save.subscribe((t) => saved.push(t));
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="kind-table"]')!.click();
    fixture.detectChanges();
    // The hosted builder reports a complete selection.
    const b = builder(fixture, StubTableBuilder)!;
    b.valid.emit(true);
    b.selectionChange.emit({ table: 'SC.Data.Carrier' });
    fixture.detectChanges();
    const saveBtn = el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-save"]')!;
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    expect(saved).toHaveLength(1);
    const tile = saved[0]!;
    expect(tile.kind).toBe('table');
    expect(tile.selection).toEqual({ table: 'SC.Data.Carrier' });
    // Title was left blank → derived from the selection (never empty).
    expect(tile.title).toBeTruthy();
    expect(tile.layout).toEqual({ w: 1, h: 1 });
  });

  it('keeps Save disabled until the builder reports valid', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="kind-cube"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-save"]')!.disabled).toBe(true);
    const b = builder(fixture, StubCubeBuilder)!;
    b.selectionChange.emit({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'] });
    b.valid.emit(true);
    fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-save"]')!.disabled).toBe(false);
  });

  it('a disabled Save explains WHY it is disabled, and drops the explanation once enabled (audit #4)', () => {
    const { fixture, el } = setup();
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="kind-cube"]')!.click();
    fixture.detectChanges();
    const save = () => el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-save"]')!;
    expect(save().disabled).toBe(true);
    expect(save().getAttribute('title')).toBeTruthy(); // a non-visual user learns the requirement
    const b = builder(fixture, StubCubeBuilder)!;
    b.selectionChange.emit({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'] });
    b.valid.emit(true);
    fixture.detectChanges();
    expect(save().disabled).toBe(false);
    expect(save().getAttribute('title')).toBeFalsy(); // enabled → no stale "can't save" hint
  });

  it('Cancel emits cancel and never save', () => {
    const { fixture, el } = setup();
    const saved: TileConfig[] = [];
    let cancelled = 0;
    fixture.componentInstance.save.subscribe((t) => saved.push(t));
    fixture.componentInstance.cancel.subscribe(() => cancelled++);
    openWith(fixture, { mode: 'add' });
    el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-cancel"]')!.click();
    expect(cancelled).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('Esc triggers cancel', () => {
    const { fixture, el } = setup();
    let cancelled = 0;
    fixture.componentInstance.cancel.subscribe(() => cancelled++);
    openWith(fixture, { mode: 'add' });
    const dialog = el.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(cancelled).toBe(1);
  });

  it('edit mode edits a COPY — cancelling never mutates the passed-in tile', () => {
    const { fixture, el } = setup();
    const original: TileConfig = {
      id: 'tile-3', kind: 'chart', title: 'My chart', layout: { w: 2, h: 1 },
      selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] },
    };
    const snapshot = structuredClone(original);
    openWith(fixture, { mode: 'edit', tile: original });
    // The cube chart builder is mounted (kind came from the tile — no kind picker).
    expect(el.querySelector('app-cube-chart-builder')).toBeTruthy();
    expect(el.querySelector('[data-testid="kind-table"]')).toBeNull();
    // Simulate an edit to the copy, then cancel.
    const b = builder(fixture, StubCubeBuilder)!;
    b.selectionChange.emit({ source: 'cube', cube: 'OtherCube', measures: ['Units'] });
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-cancel"]')!.click();
    // The original object is untouched.
    expect(original).toEqual(snapshot);
  });

  it('edit mode Save preserves the tile id and keeps a user-set title', () => {
    const { fixture, el } = setup();
    const saved: TileConfig[] = [];
    fixture.componentInstance.save.subscribe((t) => saved.push(t));
    const original: TileConfig = {
      id: 'tile-7', kind: 'table', title: 'Carriers', layout: { w: 3, h: 2 },
      selection: { table: 'SC.Data.Carrier' },
    };
    openWith(fixture, { mode: 'edit', tile: original });
    const b = builder(fixture, StubTableBuilder)!;
    b.valid.emit(true);
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="tile-editor-save"]')!.click();
    expect(saved).toHaveLength(1);
    const tile = saved[0]!;
    expect(tile.id).toBe('tile-7');
    expect(tile.title).toBe('Carriers');
    expect(tile.layout).toEqual({ w: 3, h: 2 });
    expect(tile.selection).toEqual({ table: 'SC.Data.Carrier' });
  });
});
