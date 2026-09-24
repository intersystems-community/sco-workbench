// frontend/src/app/dashboard/dashboard-grid.ts
import {
  Component, ChangeDetectionStrategy, DestroyRef, ElementRef,
  computed, inject, input, output, signal,
} from '@angular/core';
import { TileHostComponent } from './tile-host';
import { previewOrder, snapSpan } from './dashboard-drag';
import type { DashboardConfig, TileConfig, TileLayout } from './dashboard-config';

/** A resize intent carrying which tile and its new discrete span. */
export interface TileResizeIntent { id: string; w: 1 | 2 | 3; h: 1 | 2 }
/** A reorder intent carrying which tile and which way (the ⋯ menu's single-step move). */
export interface TileMoveIntent { id: string; dir: 'left' | 'right' }
/** An absolute-index move intent — the drag gesture's drop (additive; menu keeps TileMoveIntent). */
export interface TileMoveToIntent { id: string; toIndex: number }

/**
 * Lays the saved tiles out in a coarse 3-column CSS grid: position is array
 * order, size is a discrete `grid-column`/`grid-row` span from each tile's
 * layout (no {x,y} bookkeeping). Purely presentational for persistence — it
 * holds no persisted state and issues no HTTP; it renders a `TileHostComponent`
 * per tile and re-emits each host's intent upward keyed by tile id, so the shell
 * applies the `dashboard-state` transforms. Collapses to a single column ≤640px
 * (the existing Change-7 breakpoint).
 *
 * Direct manipulation (A1): the grid owns the TRANSIENT drag state — a move-drag
 * renders a live preview order (`displayTiles`) and emits one `TileMoveToIntent`
 * on drop; a resize-drag previews the snapped span (`displaySpan`) and emits one
 * `TileResizeIntent` on drop. Neither mutates config nor persists mid-drag; a
 * drop that changes nothing (or Esc/cancel) emits nothing. Window-lifetime
 * pointer listeners run only while a drag is live.
 */
@Component({
  selector: 'app-dashboard-grid',
  standalone: true,
  imports: [TileHostComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid">
      @for (t of displayTiles(); track t.id; let i = $index, last = $last) {
        <div class="grid__cell" data-testid="grid-cell" [attr.data-tile-id]="t.id"
             [class.is-dragging]="drag()?.id === t.id"
             [style.gridColumn]="'span ' + displaySpan(t).w"
             [style.gridRow]="'span ' + displaySpan(t).h">
          <app-tile-host
            [tile]="t"
            [canMoveLeft]="i > 0"
            [canMoveRight]="!last"
            (edit)="tileEdit.emit(t.id)"
            (delete)="tileDelete.emit(t.id)"
            (resize)="onResize(t.id, $event)"
            (move)="tileMove.emit({ id: t.id, dir: $event })"
            (moveStart)="onMoveStart(t.id, $event)"
            (resizeStart)="onResizeStart(t.id, $event)"
            (expand)="tileExpand.emit(t.id)" />
        </div>
      }
    </div>`,
  styleUrl: './dashboard-grid.css',
})
export class DashboardGridComponent {
  readonly config = input.required<DashboardConfig>();

  readonly tileEdit = output<string>();
  readonly tileDelete = output<string>();
  readonly tileResize = output<TileResizeIntent>();
  readonly tileMove = output<TileMoveIntent>();
  readonly tileMoveTo = output<TileMoveToIntent>();
  readonly tileExpand = output<string>();

  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Transient move-drag state (view-only; never mutates config, never PUTs). */
  readonly drag = signal<{ id: string; fromIndex: number; overIndex: number } | null>(null);
  /** Transient resize-drag state; `preview` is the snapped span shown mid-drag. */
  private readonly resize = signal<{ id: string; cellW: number; cellH: number; gap: number; preview: TileLayout } | null>(null);

  /** Test seam: stand in for the measured cell read in jsdom (no layout). */
  testCellSize: { cellW: number; cellH: number; gap: number } | null = null;

  constructor() { inject(DestroyRef).onDestroy(() => this.removePointerListeners()); }

  /** The order to render: preview order mid-move-drag, else config order. */
  readonly displayTiles = computed<TileConfig[]>(() => {
    const d = this.drag();
    const tiles = this.config().tiles;
    return d ? previewOrder(tiles, d.id, d.overIndex) : tiles;
  });
  /** The span to render for a tile: the snapped preview for the tile being resized, else its stored layout. */
  displaySpan(t: TileConfig): TileLayout {
    const r = this.resize();
    return r && r.id === t.id ? r.preview : t.layout;
  }

  onResize(id: string, layout: TileLayout): void {
    this.tileResize.emit({ id, w: layout.w, h: layout.h });
  }

  // ── move ─────────────────────────────────────────────
  onMoveStart(id: string, ev: PointerEvent): void {
    const fromIndex = this.config().tiles.findIndex((t) => t.id === id);
    if (fromIndex < 0) return;
    this.drag.set({ id, fromIndex, overIndex: fromIndex });
    this.addPointerListeners('move', ev);
  }
  /** Called by the window pointermove after indexAtPoint(); driven directly in tests. */
  onDragOver(index: number): void {
    const d = this.drag();
    if (!d) return;
    const clamped = Math.max(0, Math.min(index, this.config().tiles.length - 1));
    if (clamped !== d.overIndex) this.drag.set({ ...d, overIndex: clamped });
  }
  endDrag(): void {
    const d = this.drag();
    this.removePointerListeners();
    this.drag.set(null);
    if (d && d.overIndex !== d.fromIndex) this.tileMoveTo.emit({ id: d.id, toIndex: d.overIndex });
  }
  cancelDrag(): void {
    this.removePointerListeners();
    this.drag.set(null); // no emit; displayTiles reverts to config order
  }

  // ── resize ───────────────────────────────────────────
  onResizeStart(id: string, ev: PointerEvent): void {
    const tile = this.config().tiles.find((t) => t.id === id);
    if (!tile) return;
    const { cellW, cellH, gap } = this.measureCell();
    this.resize.set({ id, cellW, cellH, gap, preview: tile.layout });
    this.addPointerListeners('resize', ev);
  }
  /** px/py = pointer offset from the tile's top-left (production: ev.client* − rect.left/top). */
  onResizeMove(px: number, py: number): void {
    const r = this.resize();
    if (!r) return;
    this.resize.set({ ...r, preview: snapSpan(px, py, r.cellW, r.cellH, r.gap) });
  }
  endResize(): void {
    const r = this.resize();
    this.removePointerListeners();
    this.resize.set(null);
    if (!r) return;
    const tile = this.config().tiles.find((t) => t.id === r.id);
    if (tile && (tile.layout.w !== r.preview.w || tile.layout.h !== r.preview.h)) {
      this.tileResize.emit({ id: r.id, w: r.preview.w, h: r.preview.h });
    }
  }
  cancelResize(): void {
    this.removePointerListeners();
    this.resize.set(null); // no emit
  }

  // ── DOM geometry (the only jsdom-invisible parts; proven in the live render) ──
  /** Measured unit-cell size. cellW is derived from the grid CONTENT box, not from
   *  any single cell — a cell that spans >1 column would measure 2–3 units wide and
   *  corrupt the divisor. Three columns + two gaps ⇒ unit = (contentWidth − 2·gap)/3
   *  (spec §4.3). cellH is the fixed --db-row-h track. Test override / CSS floor otherwise. */
  private measureCell(): { cellW: number; cellH: number; gap: number } {
    if (this.testCellSize) return this.testCellSize;
    const gridEl = this.hostEl.nativeElement.querySelector<HTMLElement>('.grid');
    const cs = gridEl ? getComputedStyle(gridEl) : null;
    const gap = cs ? (parseFloat(cs.columnGap || cs.gap) || 16) : 16;
    // Content width = padding box − horizontal padding (getComputedStyle gives px).
    const rect = gridEl?.getBoundingClientRect();
    const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
    const contentW = rect ? rect.width - padX : 3 * 360 + 2 * gap;
    const cellW = (contentW - 2 * gap) / 3;
    const cellH = cs ? (parseFloat(cs.getPropertyValue('--db-row-h')) || 360) : 360;
    return { cellW, cellH, gap };
  }
  /** The top-left of a specific tile's cell — the resize origin. Read by tile id, NOT
   *  the first cell (a tile in column 3 would otherwise measure its span from column 1
   *  and snap too wide — the "jumps past the cursor" defect, spec §4.3). */
  private cellRect(id: string): DOMRect | null {
    const cell = this.hostEl.nativeElement.querySelector<HTMLElement>(`[data-tile-id="${id}"]`);
    return cell ? cell.getBoundingClientRect() : null;
  }
  /** The rendered index the pointer is over (hit-test cell rects); −1 if none. Proven live. */
  private indexAtPoint(clientX: number, clientY: number): number {
    const cells = Array.from(this.hostEl.nativeElement.querySelectorAll<HTMLElement>('[data-testid="grid-cell"]'));
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return i;
    }
    return -1;
  }
  private moveHandler?: (e: PointerEvent) => void;
  private upHandler?: (e: PointerEvent) => void;
  private keyHandler?: (e: KeyboardEvent) => void;
  private addPointerListeners(kind: 'move' | 'resize', start: PointerEvent): void {
    const startX = start.clientX, startY = start.clientY;
    // For resize, the origin is the RESIZED tile's own cell top-left (captured at
    // start), not the first cell — see cellRect / ADS-PLAN-03.
    const resizeId = kind === 'resize' ? this.resize()?.id : undefined;
    this.moveHandler = (e: PointerEvent) => {
      if (kind === 'move') {
        const i = this.indexAtPoint(e.clientX, e.clientY);
        if (i >= 0) this.onDragOver(i);
      } else {
        const rect = resizeId ? this.cellRect(resizeId) : null;
        const left = rect?.left ?? startX, top = rect?.top ?? startY;
        this.onResizeMove(e.clientX - left, e.clientY - top);
      }
    };
    this.upHandler = () => (kind === 'move' ? this.endDrag() : this.endResize());
    this.keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') (kind === 'move' ? this.cancelDrag() : this.cancelResize()); };
    window.addEventListener('pointermove', this.moveHandler);
    window.addEventListener('pointerup', this.upHandler);
    window.addEventListener('pointercancel', this.upHandler);
    window.addEventListener('keydown', this.keyHandler);
  }
  private removePointerListeners(): void {
    if (this.moveHandler) window.removeEventListener('pointermove', this.moveHandler);
    if (this.upHandler) { window.removeEventListener('pointerup', this.upHandler); window.removeEventListener('pointercancel', this.upHandler); }
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.moveHandler = this.upHandler = this.keyHandler = undefined;
  }
}
