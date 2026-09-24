// frontend/src/app/dashboard/tile-editor.ts
import {
  Component, ChangeDetectionStrategy, ElementRef, computed, effect, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { TableBuilderComponent } from './table-builder';
import { CubeChartBuilderComponent } from './cube-chart-builder';
import { KpiChartBuilderComponent } from './kpi-chart-builder';
import { newTileId, defaultTileTitle } from './dashboard-state';
import type { TileConfig, TileLayout, TableSelection, ChartSelection } from './dashboard-config';

/** The payload the shell opens the editor with: add a new tile, or edit an existing one. */
export interface TileEditorRequest {
  mode: 'add' | 'edit';
  /** Present for `edit` (the tile to clone-and-edit); absent for `add`. */
  tile?: TileConfig;
}

/**
 * The tile editor — a modal that hosts the matching builder (table or chart) and
 * commits or discards a tile. It always works on a COPY: a structural clone for
 * `edit` (so cancelling never mutates the live tile), a fresh skeleton for `add`.
 * In `add` mode it first asks the tile KIND (a two-button choice) before mounting
 * the builder; the builder then drives the copy's `selection`, and `valid` gates
 * Save. On Save it emits a complete `TileConfig` (defaulting the title from the
 * selection when the user left it blank); Cancel / `Esc` / backdrop-click emit
 * `cancel` and drop the copy. It is a real dialog: `role="dialog"`/`aria-modal`,
 * a focus trap and an `Esc` handler (spec §5, keyboard-first).
 *
 * The editor holds the copy in signals rather than binding the builder's live
 * selection back into it: `initialSelection` (set once on open) seeds the builder,
 * and the builder's `selectionChange` flows into a SEPARATE `selection` signal used
 * for Save — so there is no input⇄output feedback loop.
 */
@Component({
  selector: 'app-tile-editor',
  standalone: true,
  imports: [TableBuilderComponent, CubeChartBuilderComponent, KpiChartBuilderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tile-editor.html',
  styleUrl: './tile-editor.css',
})
export class TileEditorComponent {
  /** Non-null opens the modal; null keeps it closed. */
  readonly open = input<TileEditorRequest | null>(null);
  readonly save = output<TileConfig>();
  readonly cancel = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialog');

  /** The chosen kind — null in `add` until the user picks. For a chart it also carries the
   *  source ('cube'|'kpi'): which builder is mounted IS the source (spec §5.3, no lockedSource). */
  readonly kind = signal<'table' | 'cube' | 'kpi' | null>(null);
  /** The tile id being edited (preserved for `edit`; provisional for `add` — the shell finalises uniqueness). */
  private readonly tileId = signal<string>('');
  private readonly layout = signal<TileLayout>({ w: 1, h: 1 });
  /** The optional title the user typed; blank means "derive it from the selection". */
  readonly titleText = signal<string>('');

  /** The selection the builder is seeded with (set once on open); never rebound, so no loop. */
  private readonly initialSelection = signal<TableSelection | ChartSelection | null>(null);
  /** The live selection the builder reports — the product committed on Save. */
  private readonly selection = signal<TableSelection | ChartSelection | null>(null);
  /** Whether the hosted builder considers its selection complete (gates Save). */
  readonly builderValid = signal(false);

  // Narrowed seeds for the three builders' `[selection]` inputs.
  readonly tableInitial = computed<TableSelection | null>(() =>
    this.kind() === 'table' ? (this.initialSelection() as TableSelection | null) : null);
  readonly cubeInitial = computed<Extract<ChartSelection, { source: 'cube' }> | null>(() =>
    this.kind() === 'cube' ? (this.initialSelection() as Extract<ChartSelection, { source: 'cube' }> | null) : null);
  readonly kpiInitial = computed<Extract<ChartSelection, { source: 'kpi' }> | null>(() =>
    this.kind() === 'kpi' ? (this.initialSelection() as Extract<ChartSelection, { source: 'kpi' }> | null) : null);

  readonly heading = computed(() => (this.open()?.mode === 'edit' ? 'Edit tile' : 'Add tile'));
  readonly canSave = computed(() => this.builderValid() && this.kind() !== null && this.selection() !== null);
  /** Why Save is disabled (audit #4) — a title so a non-visual user learns the requirement; null once enabled. */
  readonly saveDisabledReason = computed(() =>
    this.canSave() ? null : this.kind() === null ? 'Choose what to add first.' : 'Finish the tile — pick its data — to save.');

  constructor() {
    // Adopt each open request onto a fresh copy. Depends ONLY on `open`; the state
    // writes happen untracked so the effect never feeds its own dependencies.
    effect(() => {
      const req = this.open();
      if (req) untracked(() => this.initFromRequest(req));
    });
    // Move focus into the dialog once it has rendered (keyboard-first, spec §5).
    effect(() => {
      const req = this.open();
      const el = this.dialogEl();
      if (req && el) el.nativeElement.focus();
    });
  }

  private initFromRequest(req: TileEditorRequest): void {
    this.builderValid.set(false);
    this.selection.set(null);
    this.titleText.set('');
    if (req.mode === 'edit' && req.tile) {
      // A structural clone: cancelling must never mutate the live tile.
      const copy = structuredClone(req.tile);
      // Which builder mounts IS the source: a chart tile's kind widens to its selection's source.
      this.kind.set(copy.kind === 'chart' ? (copy.selection as ChartSelection).source : 'table');
      this.tileId.set(copy.id);
      this.layout.set(copy.layout);
      this.titleText.set(copy.title ?? '');
      this.initialSelection.set(copy.selection);
      // Seed `selection` too: the table builder does not re-emit on adoption, so
      // an edit would otherwise start with no selection to save.
      this.selection.set(copy.selection);
    } else {
      this.kind.set(null); // add mode asks the kind first
      // Provisional id; the shell re-keys against its live tiles on add (newTileId).
      this.tileId.set(newTileId([]));
      this.layout.set({ w: 1, h: 1 });
      this.initialSelection.set(null);
    }
  }

  /** Resolve the three-way Add choice to a kind. For a chart the kind carries the source
   *  ('cube'|'kpi'); which builder mounts IS the source (spec §5.3). */
  chooseAdd(choice: 'table' | 'cube' | 'kpi'): void {
    this.kind.set(choice);
  }

  onSelection(sel: TableSelection | ChartSelection): void {
    this.selection.set(sel);
  }

  onSave(): void {
    const tile = this.buildTile();
    if (tile) this.save.emit(tile);
  }

  onCancel(): void {
    this.cancel.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onCancel();
      return;
    }
    if (event.key === 'Tab') this.trapTab(event);
  }

  /** Assemble the committed tile from the copy, defaulting the title from the selection. */
  private buildTile(): TileConfig | null {
    const kind = this.kind();
    const sel = this.selection();
    if (!kind || !sel) return null;
    const id = this.tileId();
    const layout = this.layout();
    const base: TileConfig =
      kind === 'table'
        ? { id, kind: 'table', layout, selection: sel as TableSelection }
        : { id, kind: 'chart', layout, selection: sel as ChartSelection };
    const title = this.titleText().trim() || defaultTileTitle(base);
    return { ...base, title };
  }

  /** Keep Tab focus within the dialog (a minimal, jsdom-tolerant focus trap). */
  private trapTab(event: KeyboardEvent): void {
    const root = this.dialogEl()?.nativeElement;
    if (!root) return;
    const focusables = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusables.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = (root.ownerDocument.activeElement as HTMLElement) ?? null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
