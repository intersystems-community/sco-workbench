import { Component, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { DashboardComponent } from './dashboard';
import { DashboardChartService } from './services/dashboard-chart.service';
import { KpiHealthService } from './services/kpi-health.service';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';
import type { DashboardConfig, TileConfig, TileLayout } from './dashboard-config';
import type { TileEditorRequest } from './tile-editor';
import type { ConfirmRequest } from './confirm-dialog';
import type { TileResizeIntent, TileMoveIntent, TileMoveToIntent } from './dashboard-grid';

// Stubs with the real selectors, so the shell renders without pulling the grid's
// view tiles / the editor's builders (and their HTTP) into this shell-only test.
@Component({ selector: 'app-dashboard-grid', standalone: true, template: '<div class="stub-grid"></div>' })
class StubGrid {
  readonly config = input.required<DashboardConfig>();
  readonly tileEdit = output<string>();
  readonly tileDelete = output<string>();
  readonly tileResize = output<TileResizeIntent>();
  readonly tileMove = output<TileMoveIntent>();
  readonly tileMoveTo = output<TileMoveToIntent>();
  readonly tileExpand = output<string>();
}
@Component({ selector: 'app-tile-editor', standalone: true, template: '<div class="stub-editor"></div>' })
class StubEditor {
  readonly open = input<TileEditorRequest | null>(null);
  readonly save = output<TileConfig>();
  readonly cancel = output<void>();
}
@Component({ selector: 'app-confirm-dialog', standalone: true, template: '<div class="stub-confirm"></div>' })
class StubConfirm {
  readonly open = input<ConfirmRequest | null>(null);
  readonly confirm = output<void>();
  readonly cancel = output<void>();
}
@Component({ selector: 'app-tile-overlay', standalone: true, template: '<div class="stub-overlay"></div>' })
class StubOverlay {
  readonly open = input<TileConfig | null>(null);
  readonly close = output<void>();
}

function cfg(tiles: TileConfig[]): DashboardConfig {
  return { schemaVersion: 1, tiles };
}
function tile(id: string, layout: TileLayout = { w: 1, h: 1 }): TileConfig {
  return { id, kind: 'table', layout, selection: { table: 'SC.Data.Carrier' } };
}
function chart(id: string, layout: TileLayout = { w: 1, h: 1 }): TileConfig {
  return { id, kind: 'chart', layout, selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] } };
}
function kpiChart(id: string, layout: TileLayout = { w: 1, h: 1 }): TileConfig {
  return { id, kind: 'chart', layout, selection: { source: 'kpi', kpi: 'On Hand' } };
}

// Mock localStorage for tests (jsdom doesn't provide it by default)
let mockStorage: Record<string, string> = {};
const storageMock = {
  getItem: (key: string) => mockStorage[key] ?? null,
  setItem: (key: string, value: string) => { mockStorage[key] = value; },
  removeItem: (key: string) => { delete mockStorage[key]; },
  clear: () => { mockStorage = {}; },
  length: 0,
  key: (index: number) => Object.keys(mockStorage)[index] ?? null,
};


describe('DashboardComponent shell', () => {
  let realLocalStorage: unknown;
  let getLayout: ReturnType<typeof vi.fn>;
  let saveLayout: ReturnType<typeof vi.fn>;
  let prefetchSpy: ReturnType<typeof vi.fn>;

  function setup(initial: DashboardConfig = cfg([tile('a'), tile('b')])) {
    realLocalStorage = (globalThis as any).localStorage;
    storageMock.clear();
    (globalThis as any).localStorage = storageMock;
    getLayout = vi.fn(() => of({ config: initial }));
    saveLayout = vi.fn(() => of({ ok: true, updatedAt: '2026-08-25T00:00:00Z' }));
    prefetchSpy = vi.fn();
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        { provide: DashboardChartService, useValue: { getLayout, saveLayout } },
        { provide: KpiHealthService, useValue: { prefetch: prefetchSpy, getKpiHealth: vi.fn(), getKpiHealthShared: vi.fn() } },
        WorkbenchBridgeService,
      ],
    });
    TestBed.overrideComponent(DashboardComponent, { set: { imports: [StubGrid, StubEditor, StubConfirm, StubOverlay] } });
    const fixture: ComponentFixture<DashboardComponent> = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  afterEach(() => {
    (globalThis as any).localStorage = realLocalStorage;
    TestBed.resetTestingModule();
  });

  function grid(fixture: ComponentFixture<DashboardComponent>): StubGrid {
    return fixture.debugElement.query((d) => d.componentInstance instanceof StubGrid).componentInstance as StubGrid;
  }
  function editor(fixture: ComponentFixture<DashboardComponent>): StubEditor {
    return fixture.debugElement.query((d) => d.componentInstance instanceof StubEditor).componentInstance as StubEditor;
  }
  function confirm(fixture: ComponentFixture<DashboardComponent>): StubConfirm {
    return fixture.debugElement.query((d) => d.componentInstance instanceof StubConfirm).componentInstance as StubConfirm;
  }
  function overlay(fixture: ComponentFixture<DashboardComponent>): StubOverlay {
    return fixture.debugElement.query((d) => d.componentInstance instanceof StubOverlay).componentInstance as StubOverlay;
  }
  const status = (el: HTMLElement) => el.querySelector('[data-testid="db-status"]')!.textContent!.trim();

  it('renders tiles from getLayout: the grid gets the loaded config', () => {
    const { fixture } = setup(cfg([tile('a'), tile('b')]));
    expect(getLayout).toHaveBeenCalledTimes(1);
    expect(grid(fixture).config().tiles.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('has no theme toggle and no data-theme wrapper attribute', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="theme-toggle"]')).toBeNull();
    expect(el.querySelector('.db')?.hasAttribute('data-theme')).toBe(false);
  });

  it('the aria-live status region is present from first render (empty)', () => {
    const { el } = setup();
    const region = el.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region!.textContent!.trim()).toBe('');
  });

  // Redesign R4 (spec §12): the layout autosaves. There is no Save and no Discard.
  it('has no Save and no Discard button (autosave)', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="db-save"]')).toBeFalsy();
    expect(el.querySelector('[data-testid="db-discard"]')).toBeFalsy();
  });

  it('"+ Add tile" opens the editor in add mode', () => {
    const { fixture, el } = setup();
    el.querySelector<HTMLButtonElement>('[data-testid="db-add"]')!.click();
    fixture.detectChanges();
    expect(editor(fixture).open()).toEqual({ mode: 'add' });
  });

  it('a resize autosaves immediately and announces "All changes saved"', () => {
    const { fixture, el } = setup(cfg([tile('a'), tile('b')]));
    grid(fixture).tileResize.emit({ id: 'a', w: 2, h: 1 });
    fixture.detectChanges();
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(saveLayout.mock.calls[0][0].tiles[0]).toMatchObject({ id: 'a', layout: { w: 2, h: 1 } });
    expect(grid(fixture).config().tiles[0]!.layout).toEqual({ w: 2, h: 1 });
    expect(status(el)).toBe('All changes saved');
  });

  it('a move autosaves immediately', () => {
    const { fixture } = setup(cfg([tile('a'), tile('b')]));
    grid(fixture).tileMove.emit({ id: 'b', dir: 'left' });
    fixture.detectChanges();
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(grid(fixture).config().tiles.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('editor save (add) appends a tile and autosaves', () => {
    const { fixture, el } = setup(cfg([tile('a')]));
    el.querySelector<HTMLButtonElement>('[data-testid="db-add"]')!.click();
    fixture.detectChanges();
    editor(fixture).save.emit({ id: 'tile-0', kind: 'table', title: 'New', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Order' } });
    fixture.detectChanges();
    expect(grid(fixture).config().tiles).toHaveLength(2);
    expect(saveLayout).toHaveBeenCalledTimes(1);
    // The editor was closed after the save.
    expect(editor(fixture).open()).toBeNull();
  });

  it('an added tile gets an id unique to the live tiles (re-keyed, not the editor provisional)', () => {
    const { fixture, el } = setup(cfg([tile('tile-0')]));
    el.querySelector<HTMLButtonElement>('[data-testid="db-add"]')!.click();
    fixture.detectChanges();
    // The editor hands back a provisional 'tile-0' which already exists.
    editor(fixture).save.emit({ id: 'tile-0', kind: 'table', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Order' } });
    fixture.detectChanges();
    const ids = grid(fixture).config().tiles.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain('tile-0');
    expect(ids).toContain('tile-1');
  });

  it('editing a tile then saving updates it in place and autosaves', () => {
    const { fixture } = setup(cfg([tile('a'), tile('b')]));
    grid(fixture).tileEdit.emit('a');
    fixture.detectChanges();
    expect(editor(fixture).open()).toMatchObject({ mode: 'edit' });
    editor(fixture).save.emit({ id: 'a', kind: 'table', title: 'Renamed', layout: { w: 2, h: 1 }, selection: { table: 'SC.Data.Carrier' } });
    fixture.detectChanges();
    const tiles = grid(fixture).config().tiles;
    expect(tiles.map((t) => t.id)).toEqual(['a', 'b']); // order preserved, no append
    expect(tiles[0]!.title).toBe('Renamed');
    expect(tiles[0]!.layout).toEqual({ w: 2, h: 1 });
    expect(saveLayout).toHaveBeenCalledTimes(1);
  });

  // Redesign R4/R5 (spec §12): delete is the one destructive action, so it asks
  // for confirmation and persists ONLY on confirm.
  it('deleting a tile opens the confirm dialog and does not save yet', () => {
    const { fixture } = setup(cfg([tile('a'), tile('b')]));
    grid(fixture).tileDelete.emit('a');
    fixture.detectChanges();
    expect(confirm(fixture).open()).toMatchObject({ title: 'Delete tile?' });
    expect(saveLayout).not.toHaveBeenCalled();
    expect(grid(fixture).config().tiles.map((t) => t.id)).toEqual(['a', 'b']); // still there
  });

  it('confirming the delete removes the tile and autosaves', () => {
    const { fixture } = setup(cfg([tile('a'), tile('b')]));
    grid(fixture).tileDelete.emit('a');
    fixture.detectChanges();
    confirm(fixture).confirm.emit();
    fixture.detectChanges();
    expect(grid(fixture).config().tiles.map((t) => t.id)).toEqual(['b']);
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(confirm(fixture).open()).toBeNull(); // dialog closed
  });

  it('cancelling the delete keeps the tile and does not save', () => {
    const { fixture } = setup(cfg([tile('a'), tile('b')]));
    grid(fixture).tileDelete.emit('a');
    fixture.detectChanges();
    confirm(fixture).cancel.emit();
    fixture.detectChanges();
    expect(grid(fixture).config().tiles.map((t) => t.id)).toEqual(['a', 'b']);
    expect(saveLayout).not.toHaveBeenCalled();
    expect(confirm(fixture).open()).toBeNull();
  });

  it('a failed save keeps the change in memory and announces a retry (no rollback, no silence)', () => {
    const { fixture, el } = setup(cfg([tile('a'), tile('b')]));
    saveLayout.mockReturnValue(throwError(() => new Error('network')));
    grid(fixture).tileResize.emit({ id: 'a', w: 3, h: 1 });
    fixture.detectChanges();
    // Change kept on screen …
    expect(grid(fixture).config().tiles[0]!.layout).toEqual({ w: 3, h: 1 });
    // … and announced, not silently dropped.
    expect(status(el)).toMatch(/retry/i);
  });

  it('registers a GuidedFormController with NO canLeave (navigation is never blocked)', () => {
    const { fixture } = setup(cfg([tile('a')]));
    const bridge = TestBed.inject(WorkbenchBridgeService);
    let proceeded = 0;
    // Allowed even right after a mutation — autosave means nothing is unsaved.
    grid(fixture).tileResize.emit({ id: 'a', w: 2, h: 1 });
    fixture.detectChanges();
    expect(bridge.canLeaveActive(() => proceeded++)).toBe(true);
    // The controller is still registered (feeds the assistant context snapshot).
    expect(bridge.getContextSnapshot()).toContain('dashboard');
  });

  // A1: the drag-move drop applies an absolute-index move (moveTileToIndex) and
  // autosaves once — distinct from the ⋯ menu's single-step onTileMove/reorderTile.
  it('a drag-move drop applies moveTileToIndex and autosaves once', () => {
    const { fixture, el } = setup(cfg([tile('a'), tile('b'), tile('c')]));
    grid(fixture).tileMoveTo.emit({ id: 'a', toIndex: 2 });
    fixture.detectChanges();
    expect(grid(fixture).config().tiles.map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(status(el)).toBe('All changes saved');
  });

  // A2: expanding a tile is pure view state — it opens the overlay with that tile
  // and closing clears it, and neither touches persistence.
  it('expanding a tile opens the overlay with it and never persists; closing clears it', () => {
    const { fixture } = setup(cfg([tile('a'), chart('b')]));
    grid(fixture).tileExpand.emit('b');
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()?.id).toBe('b');
    expect(overlay(fixture).open()?.id).toBe('b');
    expect(saveLayout).not.toHaveBeenCalled();

    overlay(fixture).close.emit();
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()).toBeNull();
    expect(overlay(fixture).open()).toBeNull();
    expect(saveLayout).not.toHaveBeenCalled();
  });

  it('expanding an unknown tile id leaves the overlay closed', () => {
    const { fixture } = setup(cfg([tile('a')]));
    grid(fixture).tileExpand.emit('nope');
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()).toBeNull();
    expect(overlay(fixture).open()).toBeNull();
  });

  it('expanding a KPI chart tile prefetches its health (warm the fetch at the click)', () => {
    const { fixture } = setup(cfg([tile('a'), kpiChart('k')]));
    grid(fixture).tileExpand.emit('k');
    fixture.detectChanges();
    expect(prefetchSpy).toHaveBeenCalledWith('On Hand');
    expect(fixture.componentInstance.expanded()?.id).toBe('k'); // overlay still opens
  });

  it('expanding a cube chart or a table tile does NOT prefetch health', () => {
    const { fixture } = setup(cfg([tile('a'), chart('c')]));
    grid(fixture).tileExpand.emit('c'); // cube chart
    grid(fixture).tileExpand.emit('a'); // table
    fixture.detectChanges();
    expect(prefetchSpy).not.toHaveBeenCalled();
  });

  it('a GET failure renders the shell with an inline error, not a blank page', () => {
    realLocalStorage = (globalThis as any).localStorage;
    storageMock.clear();
    (globalThis as any).localStorage = storageMock;
    getLayout = vi.fn(() => throwError(() => new Error('down')));
    saveLayout = vi.fn(() => of({ ok: true, updatedAt: 'x' }));
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        { provide: DashboardChartService, useValue: { getLayout, saveLayout } },
        WorkbenchBridgeService,
      ],
    });
    TestBed.overrideComponent(DashboardComponent, { set: { imports: [StubGrid, StubEditor, StubConfirm, StubOverlay] } });
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.db')).toBeTruthy(); // shell present, not blank
    expect(el.querySelector('[data-testid="db-load-error"]')).toBeTruthy();
  });

  it('uses the shared .page--full shell', () => {
    const getLayout = () => of({ tiles: [] });
    const saveLayout = () => of({});
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        { provide: DashboardChartService, useValue: { getLayout, saveLayout } },
        WorkbenchBridgeService,
      ],
    });
    const fixture = TestBed.createComponent(DashboardComponent);
    expect((fixture.nativeElement as HTMLElement).querySelector('.db.page--full')).not.toBeNull();
  });
});
