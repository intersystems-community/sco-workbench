// frontend/src/app/dashboard/tile-host.ts
import {
  Component, ChangeDetectionStrategy, DestroyRef, ElementRef,
  computed, inject, input, output, signal,
} from '@angular/core';
import { ChartTileViewComponent } from './chart-tile-view';
import { TableTileViewComponent } from './table-tile-view';
import { KpiStatusFooterComponent } from './kpi-status-footer';
import { defaultTileTitle } from './dashboard-state';
import type { TileConfig, TileLayout } from './dashboard-config';

/** True when the event target is (or is inside) a control that owns the click —
 *  a body/overlay click there must NOT expand/close. Shared by tile-host + tile-overlay. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('button, a, input, select, textarea, [role="button"]');
}

/** The discrete size presets a tile can take in the coarse 3-column grid. */
interface SizePreset { w: 1 | 2 | 3; h: 1 | 2; label: string }
const SIZE_PRESETS: readonly SizePreset[] = [
  { w: 1, h: 1, label: '1×1' },
  { w: 2, h: 1, label: '2×1' },
  { w: 3, h: 1, label: '3×1' },
  { w: 1, h: 2, label: '1×2' },
  { w: 2, h: 2, label: '2×2' },
  { w: 3, h: 2, label: '3×2' },
];

/**
 * A tile's chrome: a header (title + a single `⋯` More button) over a body that
 * switches on `kind` to the matching view tile. Pure presentation + intent — it
 * holds NO state beyond the transient menu-open flag and issues NO HTTP; it
 * emits edit/delete/resize/move upward and the shell (via the grid) applies the
 * `dashboard-state` transforms. Every control is a real `<button>` so the whole
 * frame is keyboard-first (spec §5). The title defaults to `defaultTileTitle`
 * when the user set none.
 *
 * Redesign R6 (spec §12): the actions used to sit in a persistent band
 * `[◀ ▶ 1×1 … 3×2 Edit Delete]` that wrapped a whole line on wide chart tiles and
 * dominated a surface used mostly for viewing. They now live behind one `⋯`
 * popover (Move ◀▶, a compact 3×2 shape-picker grid, Edit, Delete). The OUTPUTS
 * and their `data-testid`s are unchanged — only the surfacing moved — so the grid
 * / shell wiring is untouched. Acting closes the menu; an outside click or `Esc`
 * closes it too.
 */
@Component({
  selector: 'app-tile-host',
  standalone: true,
  imports: [ChartTileViewComponent, TableTileViewComponent, KpiStatusFooterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tile-host.css',
  template: `
    <section class="tile" [attr.aria-label]="title()">
      <header class="tile__head">
        <span class="tile__grip" data-testid="tile-grip" aria-hidden="true"
              (pointerdown)="onGripDown($event)">⠿</span>
        <h3 class="tile__title" data-testid="tile-title">{{ title() }}</h3>
        <div class="tile__more" (keydown)="onMenuKeydown($event)">
          <button type="button" data-testid="tile-more" class="tile__more-btn"
                  aria-haspopup="menu" [attr.aria-expanded]="menuOpen()"
                  aria-label="Tile actions" (click)="toggleMenu()">⋯</button>
          @if (menuOpen()) {
            <div class="tile__menu" role="menu">
              <div class="tile__menu-row">
                <button type="button" data-testid="tile-move-left" role="menuitem"
                        [disabled]="!canMoveLeft()" (click)="act(emitMoveLeft)"
                        aria-label="Move tile left">◀ Move left</button>
                <button type="button" data-testid="tile-move-right" role="menuitem"
                        [disabled]="!canMoveRight()" (click)="act(emitMoveRight)"
                        aria-label="Move tile right">Move right ▶</button>
              </div>
              <div class="tile__size-grid" role="group" aria-label="Tile size">
                @for (p of sizePresets; track p.label) {
                  <button type="button" [attr.data-testid]="'tile-size-' + p.w + 'x' + p.h" role="menuitemradio"
                          [class.is-active]="p.w === tile().layout.w && p.h === tile().layout.h"
                          [attr.aria-checked]="p.w === tile().layout.w && p.h === tile().layout.h"
                          (click)="act(() => resize.emit({ w: p.w, h: p.h }))">{{ p.label }}</button>
                }
              </div>
              <div class="tile__menu-row">
                <button type="button" data-testid="tile-edit" role="menuitem"
                        (click)="act(emitEdit)">Edit</button>
                <button type="button" data-testid="tile-delete" role="menuitem" class="tile__menu-delete"
                        (click)="act(emitDelete)">Delete</button>
              </div>
            </div>
          }
        </div>
      </header>
      <div class="tile__body" (click)="onBodyClick($event)">
        <span class="tile__zoom-cue" data-testid="tile-zoom-cue" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
               stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <circle cx="6.5" cy="6.5" r="4.5"></circle>
            <line x1="10" y1="10" x2="14.5" y2="14.5"></line>
            <line x1="4.5" y1="6.5" x2="8.5" y2="6.5"></line>
            <line x1="6.5" y1="4.5" x2="6.5" y2="8.5"></line>
          </svg>
        </span>
        @switch (tile().kind) {
          @case ('chart') {
            @if (chartSelection(); as sel) {
              <!-- bareTitle: the tile header already shows the title, so suppress
                   the duplicate in-box chart title (redesign R3 / spec §12). -->
              <app-chart-tile-view [selection]="sel" [label]="title()" [bareTitle]="true" />
            }
          }
          @case ('table') {
            @if (tableSelection(); as sel) {
              <app-table-tile-view [selection]="sel" />
            }
          }
        }
        <!-- KPI tiles carry their state INSIDE the body: a status footer pinned below the
             chart (Phase 2 redesign, replaces the header chip). Body-level so it reads as
             tile content, and present on every KPI tile — not just ones with issues. -->
        @if (kpiTileName(); as name) {
          <app-kpi-status-footer [kpiName]="name" />
        }
      </div>
      <span class="tile__resize" data-testid="tile-resize" aria-hidden="true"
            (pointerdown)="onResizeDown($event)">◲</span>
    </section>`,
})
export class TileHostComponent {
  readonly tile = input.required<TileConfig>();
  readonly canMoveLeft = input<boolean>(true);
  readonly canMoveRight = input<boolean>(true);

  readonly edit = output<void>();
  readonly delete = output<void>();
  readonly resize = output<TileLayout>();
  readonly move = output<'left' | 'right'>();

  // Direct-manipulation zones (A1/A2). Pointer-only additions; keyboard users use
  // the ⋯ menu above. moveStart/resizeStart carry the PointerEvent so the grid can
  // seed the drag from the pointer's start position.
  readonly moveStart = output<PointerEvent>();
  readonly resizeStart = output<PointerEvent>();
  readonly expand = output<void>();

  readonly sizePresets = SIZE_PRESETS;

  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Whether the `⋯` actions popover is open (transient view state, R6). */
  readonly menuOpen = signal(false);

  constructor() {
    // Close on any click outside this tile's frame. The listener is attached for
    // the component's lifetime and cleaned via DestroyRef; the opening click on
    // `⋯` is inside the host so `contains` is true and it never self-closes.
    const onDocClick = (e: MouseEvent) => {
      if (this.menuOpen() && !this.hostEl.nativeElement.contains(e.target as Node)) {
        this.menuOpen.set(false);
      }
    };
    document.addEventListener('click', onDocClick, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('click', onDocClick, true));
  }

  /** A drag begins on the header grip (pointer-only; keyboard uses the ⋯ Move ◀ ▶). */
  onGripDown(ev: PointerEvent): void {
    ev.preventDefault();   // no text selection while dragging
    ev.stopPropagation();  // never read as anything but a drag start
    this.moveStart.emit(ev);
  }
  /** A resize begins on the bottom-right corner handle (pointer-only; keyboard uses the ⋯ size grid). */
  onResizeDown(ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.resizeStart.emit(ev);
  }
  /** Click the body → open the full-size overlay, UNLESS the target is interactive
   *  (sort/paging/retry keep working). The same guard the overlay uses to close. */
  onBodyClick(ev: MouseEvent): void {
    if (isInteractiveTarget(ev.target)) return;
    this.expand.emit();
  }

  toggleMenu(): void { this.menuOpen.update((v) => !v); }
  /** Run an action then close the menu (every menu control acts-and-dismisses). */
  act(fn: () => void): void { fn(); this.menuOpen.set(false); }
  onMenuKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); this.menuOpen.set(false); }
  }

  // Bound emit helpers so the template's `act(...)` stays a plain call (no inline
  // arrows for the parameterless outputs — keeps the change-detection cheap).
  readonly emitEdit = (): void => this.edit.emit();
  readonly emitDelete = (): void => this.delete.emit();
  readonly emitMoveLeft = (): void => this.move.emit('left');
  readonly emitMoveRight = (): void => this.move.emit('right');

  readonly title = computed(() => {
    const t = this.tile();
    return t.title ?? defaultTileTitle(t);
  });

  // Narrowed selection accessors for the template — the discriminated union can't
  // be narrowed inside an @switch on a signal call, so read it through a computed
  // that asserts the branch the @case guarantees.
  readonly chartSelection = computed(() => {
    const t = this.tile();
    return t.kind === 'chart' ? t.selection : null;
  });
  /** The KPI name when this tile is a KPI-source chart tile, else null (drives the issue badge, Task 9). */
  readonly kpiTileName = computed(() => {
    const sel = this.chartSelection();
    return sel?.source === 'kpi' ? sel.kpi : null;
  });
  readonly tableSelection = computed(() => {
    const t = this.tile();
    return t.kind === 'table' ? t.selection : null;
  });
}
