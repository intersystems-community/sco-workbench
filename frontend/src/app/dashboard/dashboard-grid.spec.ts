// frontend/src/app/dashboard/dashboard-grid.spec.ts
import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { DashboardGridComponent } from './dashboard-grid';
import type { DashboardConfig, TileConfig, TileLayout } from './dashboard-config';

// Stub the host with the real selector + a superset of its I/O, so the grid wires
// up without pulling the view tiles' services into this layout-only test.
@Component({ selector: 'app-tile-host', standalone: true, template: '<div class="stub-host">{{ tile().id }}</div>' })
class StubHost {
  readonly tile = input.required<TileConfig>();
  readonly canMoveLeft = input<boolean>(true);
  readonly canMoveRight = input<boolean>(true);
  readonly edit = output<void>();
  readonly delete = output<void>();
  readonly resize = output<TileLayout>();
  readonly move = output<'left' | 'right'>();
  readonly moveStart = output<PointerEvent>();
  readonly resizeStart = output<PointerEvent>();
  readonly expand = output<void>();
}

function tile(id: string, layout: TileLayout = { w: 1, h: 1 }): TileConfig {
  return { id, kind: 'table', layout, selection: { table: 'SC.Data.Carrier' } };
}

function config(tiles: TileConfig[]): DashboardConfig {
  return { schemaVersion: 1, tiles };
}

function setup(cfg: DashboardConfig) {
  TestBed.configureTestingModule({ imports: [DashboardGridComponent] });
  TestBed.overrideComponent(DashboardGridComponent, { set: { imports: [StubHost] } });
  const fixture: ComponentFixture<DashboardGridComponent> = TestBed.createComponent(DashboardGridComponent);
  fixture.componentRef.setInput('config', cfg);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('DashboardGridComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders one host per tile, in array order', () => {
    const { el } = setup(config([tile('a'), tile('b'), tile('c')]));
    const hosts = Array.from(el.querySelectorAll('app-tile-host'));
    expect(hosts).toHaveLength(3);
    expect(hosts.map((h) => h.textContent?.trim())).toEqual(['a', 'b', 'c']);
  });

  it('gives each cell a grid span from the tile layout', () => {
    const { el } = setup(config([tile('a', { w: 2, h: 1 }), tile('b', { w: 1, h: 2 })]));
    const cells = el.querySelectorAll<HTMLElement>('[data-testid="grid-cell"]');
    expect(cells[0]!.style.gridColumn).toBe('span 2');
    expect(cells[0]!.style.gridRow).toBe('span 1');
    expect(cells[1]!.style.gridColumn).toBe('span 1');
    expect(cells[1]!.style.gridRow).toBe('span 2');
  });

  it('disables move-left on the first tile and move-right on the last', () => {
    const { fixture } = setup(config([tile('a'), tile('b'), tile('c')]));
    // By.directive returns debug elements in DOM order, so [0]/[1]/[2] map to a/b/c.
    const hosts = fixture.debugElement
      .queryAll(By.directive(StubHost))
      .map((de) => de.componentInstance as StubHost);
    expect(hosts[0]!.canMoveLeft()).toBe(false);
    expect(hosts[0]!.canMoveRight()).toBe(true);
    expect(hosts[1]!.canMoveLeft()).toBe(true);
    expect(hosts[1]!.canMoveRight()).toBe(true);
    expect(hosts[2]!.canMoveLeft()).toBe(true);
    expect(hosts[2]!.canMoveRight()).toBe(false);
  });

  it('bubbles a host edit up as tileEdit with the tile id', () => {
    const { fixture } = setup(config([tile('a'), tile('b')]));
    const ids: string[] = [];
    fixture.componentInstance.tileEdit.subscribe((id) => ids.push(id));
    const secondHost = fixture.debugElement.queryAll(By.directive(StubHost))[1]!
      .componentInstance as StubHost;
    secondHost.edit.emit();
    expect(ids).toEqual(['b']);
  });

  it('bubbles a host delete up as tileDelete with the tile id', () => {
    const { fixture } = setup(config([tile('a'), tile('b')]));
    const ids: string[] = [];
    fixture.componentInstance.tileDelete.subscribe((id) => ids.push(id));
    const firstHost = fixture.debugElement.queryAll(By.directive(StubHost))[0]!
      .componentInstance as StubHost;
    firstHost.delete.emit();
    expect(ids).toEqual(['a']);
  });

  it('bubbles a host resize up as tileResize with id + {w,h}', () => {
    const { fixture } = setup(config([tile('a'), tile('b')]));
    const events: Array<{ id: string; w: number; h: number }> = [];
    fixture.componentInstance.tileResize.subscribe((e) => events.push(e));
    const secondHost = fixture.debugElement.queryAll(By.directive(StubHost))[1]!
      .componentInstance as StubHost;
    secondHost.resize.emit({ w: 3, h: 2 });
    expect(events).toEqual([{ id: 'b', w: 3, h: 2 }]);
  });

  it('bubbles a host move up as tileMove with id + direction', () => {
    const { fixture } = setup(config([tile('a'), tile('b')]));
    const events: Array<{ id: string; dir: string }> = [];
    fixture.componentInstance.tileMove.subscribe((e) => events.push(e));
    const secondHost = fixture.debugElement.queryAll(By.directive(StubHost))[1]!
      .componentInstance as StubHost;
    secondHost.move.emit('left');
    expect(events).toEqual([{ id: 'b', dir: 'left' }]);
  });

  it('renders an empty grid with no hosts when there are no tiles', () => {
    const { el } = setup(config([]));
    expect(el.querySelectorAll('app-tile-host')).toHaveLength(0);
  });

  // Redesign R2 (spec §12): a 1×1 table tile must stay one cell tall and scroll
  // inside its body, not grow to its content height and stretch the page. That
  // requires the row track to be DEFINITE (a fixed unit height × the span), not
  // `grid-auto-rows: minmax(320px, auto)` whose `auto` maximum lets a tall tile
  // grow the track. jsdom does no grid layout, so the geometry itself is proven
  // in R7's live render; here we guard the CSS CONTRACT the fix relies on by
  // reading the component's shipped stylesheet (Angular injects it at render).
  it('gives the grid a definite row-track height (no open-ended auto rows)', () => {
    setup(config([tile('a')]));
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    // The fix defines a definite unit row height and drives grid-auto-rows off it.
    expect(css).toContain('--db-row-h');
    expect(css).toMatch(/grid-auto-rows:\s*var\(--db-row-h\)/);
    // Regression guard: the open-ended auto max is gone.
    expect(css).not.toMatch(/grid-auto-rows:\s*minmax\([^)]*auto\s*\)/);
    // The default unit row is 360px — tall enough that a chart tile fills without a
    // scrollbar (the fixed 320px earlier left every chart a few px short → V-scroll).
    expect(css).toMatch(/--db-row-h:\s*360px/);
  });

  // Redesign R8b (spec §12): the earlier `repeat(3, 1fr)` let every column — and so
  // every tile — shrink to any width, crushing charts/tables at tablet/narrow-laptop
  // widths. The fix floors each column at a definite minimum (360px, matching the
  // row height) via `minmax(--db-col-min, 1fr)`: tracks still grow to fill a wide
  // viewport (1fr) but never fall below the floor; when three floored columns no
  // longer fit, the grid overflows and the dashboard body (overflow:auto) scrolls
  // horizontally rather than squeezing tiles. jsdom does no grid layout, so the
  // pixel behaviour is proven in the live render; here we guard the CSS CONTRACT.
  it('enforces a minimum tile width so columns cannot shrink arbitrarily (minmax floor)', () => {
    setup(config([tile('a')]));
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    // A definite column-min token, matching the row-height convention.
    expect(css).toMatch(/--db-col-min:\s*360px/);
    // Columns are floored via minmax(var(--db-col-min), 1fr) — not a bare 1fr.
    expect(css).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(var\(--db-col-min\),\s*1fr\)\)/);
    // Regression guard: the un-floored `repeat(3, 1fr)` is gone.
    expect(css).not.toMatch(/grid-template-columns:\s*repeat\(3,\s*1fr\)/);
  });
});

describe('DashboardGridComponent — drag orchestration (A1) + expand bubble (A2)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('emits one tileMoveTo with the drop index when the drag changes position', () => {
    const { fixture } = setup(config([tile('a'), tile('b'), tile('c')]));
    const grid = fixture.componentInstance;
    const intents: Array<{ id: string; toIndex: number }> = [];
    grid.tileMoveTo.subscribe((e) => intents.push(e));
    grid.onMoveStart('a', new PointerEvent('pointerdown'));
    grid.onDragOver(2);   // pointer now over the 3rd slot (production: from indexAtPoint)
    grid.endDrag();
    expect(intents).toEqual([{ id: 'a', toIndex: 2 }]);
  });

  it('emits NOTHING when the drag ends at the origin index', () => {
    const { fixture } = setup(config([tile('a'), tile('b'), tile('c')]));
    const grid = fixture.componentInstance;
    let fired = 0;
    grid.tileMoveTo.subscribe(() => (fired += 1));
    grid.onMoveStart('b', new PointerEvent('pointerdown'));
    grid.onDragOver(1); // same slot b already occupies
    grid.endDrag();
    expect(fired).toBe(0);
  });

  it('cancelDrag emits nothing and restores order', () => {
    const { fixture } = setup(config([tile('a'), tile('b'), tile('c')]));
    const grid = fixture.componentInstance;
    let fired = 0;
    grid.tileMoveTo.subscribe(() => (fired += 1));
    grid.onMoveStart('a', new PointerEvent('pointerdown'));
    grid.onDragOver(2);
    grid.cancelDrag();
    expect(fired).toBe(0);
    expect(grid.displayTiles().map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('renders the preview order mid-drag (dragged tile follows the over-index)', () => {
    const { fixture } = setup(config([tile('a'), tile('b'), tile('c')]));
    const grid = fixture.componentInstance;
    grid.onMoveStart('a', new PointerEvent('pointerdown'));
    grid.onDragOver(2);
    expect(grid.displayTiles().map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('emits one tileResize at the snapped span when a resize changes size, nothing when unchanged', () => {
    const { fixture } = setup(config([tile('a', { w: 1, h: 1 })]));
    const grid = fixture.componentInstance;
    const sizes: Array<{ id: string; w: number; h: number }> = [];
    grid.tileResize.subscribe((e) => sizes.push(e));
    grid.testCellSize = { cellW: 480, cellH: 360, gap: 16 }; // stand in for the measured read — set BEFORE start (onResizeStart caches the measurement)
    grid.onResizeStart('a', new PointerEvent('pointerdown'));
    grid.onResizeMove(2 * 480 + 16, 360); // ~2 cols × 1 row
    grid.endResize();
    expect(sizes).toEqual([{ id: 'a', w: 2, h: 1 }]);

    grid.onResizeStart('a', new PointerEvent('pointerdown'));
    grid.onResizeMove(5, 5); // rounds back to 1×1 = unchanged
    grid.endResize();
    expect(sizes).toHaveLength(1); // no second emit
  });

  it('bubbles a host expand up as tileExpand with the tile id', () => {
    const { fixture } = setup(config([tile('a'), tile('b')]));
    const ids: string[] = [];
    fixture.componentInstance.tileExpand.subscribe((id) => ids.push(id));
    const secondHost = fixture.debugElement.queryAll(By.directive(StubHost))[1]!.componentInstance as StubHost;
    secondHost.expand.emit();
    expect(ids).toEqual(['b']);
  });
});
