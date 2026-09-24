// frontend/src/app/dashboard/tile-host.spec.ts
import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TileHostComponent } from './tile-host';
import type { TileConfig } from './dashboard-config';

// Stubs with the real selectors, so the frame renders without pulling the view
// tiles' services/HTTP into this frame-only test.
@Component({ selector: 'app-chart-tile-view', standalone: true, template: '<div class="stub-chart"></div>' })
class StubChartView { readonly selection = input<unknown>(); readonly label = input<string>(); readonly bareTitle = input<boolean>(false); }
@Component({ selector: 'app-table-tile-view', standalone: true, template: '<div class="stub-table"></div>' })
class StubTableView { readonly selection = input<unknown>(); }
// The status footer (Phase 2 redesign) does its own KpiHealthService fetch; stub it so this
// frame-only test asserts the MOUNT (present in the BODY for a KPI tile, absent otherwise)
// without pulling in HTTP.
@Component({ selector: 'app-kpi-status-footer', standalone: true, template: '<div class="stub-footer"></div>' })
class StubStatusFooter { readonly kpiName = input.required<string>(); }

const CHART_TILE: TileConfig = {
  id: 'tile-0', kind: 'chart', layout: { w: 1, h: 1 },
  selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] },
};
const KPI_TILE: TileConfig = {
  id: 'tile-2', kind: 'chart', layout: { w: 1, h: 1 },
  selection: { source: 'kpi', kpi: 'Fill Rate' },
};
const TABLE_TILE: TileConfig = {
  id: 'tile-1', kind: 'table', layout: { w: 2, h: 1 }, title: 'My Carriers',
  selection: { table: 'SC.Data.Carrier' },
};

function setup(tile: TileConfig, over: { canMoveLeft?: boolean; canMoveRight?: boolean } = {}) {
  TestBed.resetTestingModule(); // allow a second setup() within one test
  TestBed.configureTestingModule({ imports: [TileHostComponent] });
  TestBed.overrideComponent(TileHostComponent, { set: { imports: [StubChartView, StubTableView, StubStatusFooter] } });
  const fixture: ComponentFixture<TileHostComponent> = TestBed.createComponent(TileHostComponent);
  fixture.componentRef.setInput('tile', tile);
  fixture.componentRef.setInput('canMoveLeft', over.canMoveLeft ?? true);
  fixture.componentRef.setInput('canMoveRight', over.canMoveRight ?? true);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

/** Redesign R6: the controls live behind a `⋯` (More) popover — open it first. */
function openMenu(el: HTMLElement, fixture: ComponentFixture<TileHostComponent>): void {
  el.querySelector<HTMLButtonElement>('[data-testid="tile-more"]')!.click();
  fixture.detectChanges();
}

describe('TileHostComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the tile title, or falls back to the derived default when none is set', () => {
    const withTitle = setup(TABLE_TILE);
    expect(withTitle.el.querySelector('[data-testid="tile-title"]')?.textContent?.trim()).toBe('My Carriers');

    const noTitle = setup(CHART_TILE); // defaultTileTitle → "Revenue by Region"
    expect(noTitle.el.querySelector('[data-testid="tile-title"]')?.textContent?.trim()).toBe('Revenue by Region');
  });

  it('renders the chart view for a chart tile and the table view for a table tile', () => {
    expect(setup(CHART_TILE).el.querySelector('app-chart-tile-view')).toBeTruthy();
    expect(setup(CHART_TILE).el.querySelector('app-table-tile-view')).toBeFalsy();
    expect(setup(TABLE_TILE).el.querySelector('app-table-tile-view')).toBeTruthy();
    expect(setup(TABLE_TILE).el.querySelector('app-chart-tile-view')).toBeFalsy();
  });

  // Phase 2 redesign: the status footer mounts in the tile BODY (not the header) for a
  // KPI-source chart tile only — a cube chart tile and a table tile never fetch health,
  // so never show a footer. Body-level so it reads as tile content, not title-bar chrome.
  it('mounts the status footer in the body for a KPI-source chart tile (bound to the KPI name)', () => {
    const { el } = setup(KPI_TILE);
    const footer = el.querySelector('app-kpi-status-footer');
    expect(footer).toBeTruthy();
    // It lives inside the body, below the chart — not in the header row.
    expect(el.querySelector('.tile__body')!.contains(footer)).toBe(true);
    expect(el.querySelector('.tile__head')!.contains(footer)).toBe(false);
  });

  it('does NOT mount the status footer for a cube-source chart tile', () => {
    expect(setup(CHART_TILE).el.querySelector('app-kpi-status-footer')).toBeFalsy();
  });

  it('does NOT mount the status footer for a table tile', () => {
    expect(setup(TABLE_TILE).el.querySelector('app-kpi-status-footer')).toBeFalsy();
  });

  // Redesign R3 (spec §12): the header carries the title, so the tile tells its
  // chart view to drop the duplicate in-box title.
  it('requests a bare (headerless) chart title on the chart view', () => {
    const { fixture } = setup(CHART_TILE);
    const view = fixture.debugElement.query(By.directive(StubChartView)).componentInstance as StubChartView;
    expect(view.bareTitle()).toBe(true);
  });

  it('emits edit when the Edit button is clicked', () => {
    const { fixture, el } = setup(CHART_TILE);
    openMenu(el, fixture);
    let fired = 0;
    fixture.componentInstance.edit.subscribe(() => (fired += 1));
    el.querySelector<HTMLButtonElement>('[data-testid="tile-edit"]')?.click();
    expect(fired).toBe(1);
  });

  it('emits delete when the Delete button is clicked', () => {
    const { fixture, el } = setup(CHART_TILE);
    openMenu(el, fixture);
    let fired = 0;
    fixture.componentInstance.delete.subscribe(() => (fired += 1));
    el.querySelector<HTMLButtonElement>('[data-testid="tile-delete"]')?.click();
    expect(fired).toBe(1);
  });

  it('emits move("left"/"right") from the reorder buttons', () => {
    const { fixture, el } = setup(CHART_TILE);
    const dirs: string[] = [];
    fixture.componentInstance.move.subscribe((d) => dirs.push(d));
    openMenu(el, fixture);
    el.querySelector<HTMLButtonElement>('[data-testid="tile-move-left"]')?.click();
    // acting closes the menu — reopen for the second control (R6).
    openMenu(el, fixture);
    el.querySelector<HTMLButtonElement>('[data-testid="tile-move-right"]')?.click();
    expect(dirs).toEqual(['left', 'right']);
  });

  it('disables move-left at the start and move-right at the end', () => {
    const atStart = setup(CHART_TILE, { canMoveLeft: false, canMoveRight: true });
    openMenu(atStart.el, atStart.fixture);
    expect(atStart.el.querySelector<HTMLButtonElement>('[data-testid="tile-move-left"]')?.disabled).toBe(true);
    expect(atStart.el.querySelector<HTMLButtonElement>('[data-testid="tile-move-right"]')?.disabled).toBe(false);

    const atEnd = setup(CHART_TILE, { canMoveLeft: true, canMoveRight: false });
    openMenu(atEnd.el, atEnd.fixture);
    expect(atEnd.el.querySelector<HTMLButtonElement>('[data-testid="tile-move-left"]')?.disabled).toBe(false);
    expect(atEnd.el.querySelector<HTMLButtonElement>('[data-testid="tile-move-right"]')?.disabled).toBe(true);
  });

  it('emits resize with the {w,h} of the chosen size preset', () => {
    const { fixture, el } = setup(CHART_TILE);
    openMenu(el, fixture);
    const sizes: Array<{ w: number; h: number }> = [];
    fixture.componentInstance.resize.subscribe((s) => sizes.push(s));
    // A 2×1 preset button.
    el.querySelector<HTMLButtonElement>('[data-testid="tile-size-2x1"]')?.click();
    expect(sizes).toEqual([{ w: 2, h: 1 }]);
  });

  // ── Redesign R6 (spec §12): the persistent control band collapsed into a ⋯ popover.
  it('hides the controls behind a More button until it is opened', () => {
    const { fixture, el } = setup(CHART_TILE);
    expect(el.querySelector('[data-testid="tile-more"]')).toBeTruthy();
    // Nothing from the band is in the DOM until the menu opens.
    expect(el.querySelector('[data-testid="tile-edit"]')).toBeFalsy();
    expect(el.querySelector('[data-testid="tile-size-2x1"]')).toBeFalsy();
    openMenu(el, fixture);
    expect(el.querySelector('[data-testid="tile-edit"]')).toBeTruthy();
    // All six size presets are present in the popover grid.
    for (const s of ['1x1', '2x1', '3x1', '1x2', '2x2', '3x2'])
      expect(el.querySelector(`[data-testid="tile-size-${s}"]`)).toBeTruthy();
  });

  it('closes the menu after acting on a control (resize)', () => {
    const { fixture, el } = setup(CHART_TILE);
    openMenu(el, fixture);
    el.querySelector<HTMLButtonElement>('[data-testid="tile-size-2x1"]')?.click();
    fixture.detectChanges();
    // acting closed it — the band is gone again.
    expect(el.querySelector('[data-testid="tile-edit"]')).toBeFalsy();
  });

  it('Escape closes the menu', () => {
    const { fixture, el } = setup(CHART_TILE);
    openMenu(el, fixture);
    el.querySelector('[data-testid="tile-more"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="tile-edit"]')).toBeFalsy();
  });

  it('the ⋯ toggle exposes its expanded state for assistive tech', () => {
    const { fixture, el } = setup(CHART_TILE);
    const more = () => el.querySelector<HTMLButtonElement>('[data-testid="tile-more"]')!;
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    openMenu(el, fixture);
    expect(more().getAttribute('aria-expanded')).toBe('true');
  });

  // Redesign R8 (spec §12): the tile BODY must not be the scroll container. It bounds
  // its content (a definite grid track) and the view inside scrolls internally, so a
  // table's horizontal bar sits INSIDE the visible tile frame — not below the fold,
  // reachable only by scrolling the whole tile down. Guard the CSS contract: the body
  // is overflow:hidden (bounds), not overflow:auto (whole-tile scroll). jsdom does no
  // layout, so the pixel result is proven in R8's live render.
  it('bounds the tile body (overflow:hidden) so the inner view owns its scrollbars', () => {
    setup(TABLE_TILE);
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    const body = css.match(/\.tile__body[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).not.toMatch(/overflow:\s*auto/);
  });
});

describe('TileHostComponent — interaction zones (A1/A2)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('emits moveStart on a pointerdown on the header grip', () => {
    const { fixture, el } = setup(CHART_TILE);
    let fired = 0;
    fixture.componentInstance.moveStart.subscribe(() => (fired += 1));
    el.querySelector<HTMLElement>('[data-testid="tile-grip"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('emits resizeStart on a pointerdown on the corner handle', () => {
    const { fixture, el } = setup(CHART_TILE);
    let fired = 0;
    fixture.componentInstance.resizeStart.subscribe(() => (fired += 1));
    el.querySelector<HTMLElement>('[data-testid="tile-resize"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('emits expand on a body click on a non-interactive target', () => {
    const { fixture, el } = setup(CHART_TILE);
    let fired = 0;
    fixture.componentInstance.expand.subscribe(() => (fired += 1));
    // The stub chart view renders a plain <div class="stub-chart"> inside the body.
    el.querySelector<HTMLElement>('.stub-chart')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('does NOT emit expand when the body click lands on an interactive control', () => {
    const { fixture, el } = setup(CHART_TILE);
    let fired = 0;
    fixture.componentInstance.expand.subscribe(() => (fired += 1));
    // Inject a button into the stub body and click it (mirrors a table tile's sort/paging/retry).
    const body = el.querySelector<HTMLElement>('.tile__body')!;
    const btn = document.createElement('button');
    body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(0);
  });

  it('a grip interaction never triggers expand, and its pointerdown does not bubble past the grip', () => {
    const { fixture, el } = setup(CHART_TILE);
    let expanded = 0, moved = 0;
    fixture.componentInstance.expand.subscribe(() => (expanded += 1));
    fixture.componentInstance.moveStart.subscribe(() => (moved += 1));
    const grip = el.querySelector<HTMLElement>('[data-testid="tile-grip"]')!;
    // A real CLICK on the grip (header zone) must not reach the body's expand handler —
    // expand is a click handler on .tile__body, and the grip lives in .tile__head (sibling).
    grip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(expanded).toBe(0);
    // The drag-start pointerdown emits moveStart AND stops propagating: an ancestor
    // listener never sees it (this is the guard the test names — onGripDown's stopPropagation).
    let ancestorSaw = 0;
    el.querySelector<HTMLElement>('.tile')!.addEventListener('pointerdown', () => (ancestorSaw += 1));
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(moved).toBe(1);       // drag started
    expect(ancestorSaw).toBe(0); // stopPropagation held — never bubbled to .tile
  });

  it('the grip and corner handle are aria-hidden and not tab stops (keyboard uses the ⋯ menu)', () => {
    const { el } = setup(CHART_TILE);
    for (const sel of ['[data-testid="tile-grip"]', '[data-testid="tile-resize"]']) {
      const node = el.querySelector<HTMLElement>(sel)!;
      expect(node.getAttribute('aria-hidden')).toBe('true');
      expect(node.hasAttribute('tabindex')).toBe(false); // not focusable; <span>/<div> default
    }
  });

  // A1: a magnifying-glass cue on the body signals "click to zoom" (spec §3). It is
  // decorative (aria-hidden) and non-interactive (pointer-events:none) so the existing
  // onBodyClick + isInteractiveTarget behavior is untouched.
  it('renders a decorative, aria-hidden zoom-in cue inside the body', () => {
    const { el } = setup(CHART_TILE);
    const cue = el.querySelector<HTMLElement>('[data-testid="tile-zoom-cue"]');
    expect(cue).toBeTruthy();
    expect(el.querySelector('.tile__body')!.contains(cue)).toBe(true);
    expect(cue!.getAttribute('aria-hidden')).toBe('true');
    expect(cue!.tagName.toLowerCase()).toBe('span'); // not a button/interactive element
  });

  it('a click landing on the zoom cue still emits expand (the cue is non-interactive)', () => {
    const { fixture, el } = setup(CHART_TILE);
    let fired = 0;
    fixture.componentInstance.expand.subscribe(() => (fired += 1));
    el.querySelector<HTMLElement>('[data-testid="tile-zoom-cue"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('sets a zoom-in cursor on the tile body (affordance that clicking zooms)', () => {
    setup(CHART_TILE);
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    const body = css.match(/\.tile__body[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(body).toMatch(/cursor:\s*zoom-in/);
  });

  it('emits expand on a click on the KPI status footer (Fix 1: footer opts in to expand)', () => {
    const { fixture, el } = setup(KPI_TILE);
    let fired = 0;
    fixture.componentInstance.expand.subscribe(() => (fired += 1));
    // The footer stub renders <div class="stub-footer"> inside .tile__body; after Fix 1 the real
    // footer carries no data-no-expand, so a click on it bubbles to onBodyClick and expands.
    const footer = el.querySelector<HTMLElement>('.stub-footer')!;
    expect(el.querySelector('.tile__body')!.contains(footer)).toBe(true);
    footer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('a resize-handle pointerdown still emits resizeStart and never expand (Fix 1 no-regression)', () => {
    const { fixture, el } = setup(KPI_TILE);
    let expanded = 0, resized = 0;
    fixture.componentInstance.expand.subscribe(() => (expanded += 1));
    fixture.componentInstance.resizeStart.subscribe(() => (resized += 1));
    el.querySelector<HTMLElement>('[data-testid="tile-resize"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(resized).toBe(1);
    expect(expanded).toBe(0);
  });
});
