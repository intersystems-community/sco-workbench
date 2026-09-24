import {
  Component, ChangeDetectionStrategy, OnInit, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { DashboardGridComponent, type TileResizeIntent, type TileMoveIntent, type TileMoveToIntent } from './dashboard-grid';
import { TileEditorComponent, type TileEditorRequest } from './tile-editor';
import { ConfirmDialogComponent, type ConfirmRequest } from './confirm-dialog';
import { TileOverlayComponent } from './tile-overlay';
import { DashboardChartService } from './services/dashboard-chart.service';
import { KpiHealthService } from './services/kpi-health.service';
import { WorkbenchBridgeService, type GuidedFormController } from '../core/workbench-bridge.service';
import {
  addTile, deleteTile, updateTile, reorderTile, resizeTile, moveTileToIndex, newTileId,
} from './dashboard-state';
import { emptyDashboardConfig, type DashboardConfig, type TileConfig } from './dashboard-config';

/**
 * The dashboard shell — a real dashboard of N add/delete/edit-able tiles laid out
 * in a coarse grid, saved to and reloaded from local persistence. It owns a single
 * `config` signal (the live, always-persisted layout); every mutation runs a pure
 * `dashboard-state` transform over it and persists at once (spec §5). The tiles
 * render themselves; the editor edits a copy.
 *
 * Persistence is REVERSIBILITY-GATED (redesign 2026-08-25 / spec §12): the layout
 * autosaves — move / resize / delete and each editor commit take effect and PUT
 * immediately, because the page is live and undimmed and these are cheap to undo by
 * hand; there is no dashboard-level Save/Discard, no dirty flag, and no leave-guard.
 * A failed save NEVER rolls the change back — the edit stays on screen and a quiet
 * status line announces a retry (spec §7, never silently drop work). Delete is the
 * one destructive action, so it asks for confirmation first (ConfirmDialogComponent).
 *
 * A `GuidedFormController` is still registered on the shared bridge so the dashboard
 * appears in the assistant's context snapshot, but it carries NO `canLeave`: with
 * autosave there is never an unsaved edit to guard, and an absent `canLeave` means
 * the bridge always allows navigation (workbench-bridge canLeaveActive).
 */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DashboardGridComponent, TileEditorComponent, ConfirmDialogComponent, TileOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly svc = inject(DashboardChartService);
  private readonly bridge = inject(WorkbenchBridgeService);
  private readonly health = inject(KpiHealthService);

  /** The live, always-persisted layout the grid renders and every mutation transforms. */
  readonly config = signal<DashboardConfig>(emptyDashboardConfig());

  /** The editor request (null = closed); set by Add / Edit. */
  readonly editorRequest = signal<TileEditorRequest | null>(null);
  /** A delete awaiting confirmation (null = no dialog open). */
  readonly pendingDelete = signal<{ id: string } | null>(null);
  /** The tile shown full-size in the overlay (null = closed). Pure view state — never persisted (A2). */
  readonly expanded = signal<TileConfig | null>(null);

  /** aria-live status text (DA-PLAN-03) — present in the DOM from first render. */
  readonly status = signal('');
  /** A non-blank load error shows an inline retry instead of a blank page (spec §7). */
  readonly loadError = signal('');

  /**
   * Registered on the bridge so the dashboard shows up in the assistant's context
   * snapshot (feature + snapshot are read there). No `canLeave` — autosave leaves
   * nothing unsaved to guard, and its absence makes the bridge always allow a
   * navigation. The four form hooks are minimal stubs (no assistant-driven form).
   */
  private readonly guidedController: GuidedFormController = {
    feature: 'dashboard',
    openNewForm: () => {},
    setField: () => ({ applied: false }),
    highlight: () => {},
    snapshot: () => ({}),
  };

  constructor() {
    this.bridge.register(this.guidedController);
  }

  ngOnInit(): void {
    this.svc.getLayout().subscribe({
      next: ({ config }) => {
        this.config.set(config);
        this.loadError.set('');
      },
      // Never blank: render the empty shell + an inline error + retry (spec §7).
      error: () => {
        this.config.set(emptyDashboardConfig());
        this.loadError.set("Couldn't load your dashboard. Retry, or start adding tiles.");
      },
    });
  }

  ngOnDestroy(): void {
    this.bridge.unregister(this.guidedController);
  }

  /** Retry the initial load after a GET failure. */
  retryLoad(): void {
    this.loadError.set('');
    this.ngOnInit();
  }

  // ── the one persistence path ──────────────────────────────
  /**
   * Apply a layout change: set it optimistically (the UI reflects it at once), then
   * PUT it. On success announce "All changes saved"; on failure KEEP the change in
   * memory and announce a retry — never roll back, never go silent (spec §7/§12).
   */
  private persist(next: DashboardConfig): void {
    this.config.set(next);
    this.status.set('Saving…');
    this.svc.saveLayout(next).subscribe({
      next: () => this.status.set('All changes saved'),
      error: () => this.status.set("Couldn't save — retrying"),
    });
  }

  // ── toolbar ───────────────────────────────────────────────
  openAdd(): void {
    this.editorRequest.set({ mode: 'add' });
  }

  // ── grid intents (all autosave; delete confirms first) ─────
  onTileEdit(id: string): void {
    const tile = this.config().tiles.find((t) => t.id === id);
    if (tile) this.editorRequest.set({ mode: 'edit', tile });
  }
  onTileDelete(id: string): void {
    this.pendingDelete.set({ id }); // ask first — the one destructive action (R5)
  }
  onTileResize(intent: TileResizeIntent): void {
    this.persist(resizeTile(this.config(), intent.id, intent.w, intent.h));
  }
  onTileMove(intent: TileMoveIntent): void {
    this.persist(reorderTile(this.config(), intent.id, intent.dir));
  }
  /** Drag-move drop: absolute-index move (A1), distinct from the ⋯ menu's single-step onTileMove. */
  onTileMoveTo(intent: TileMoveToIntent): void {
    this.persist(moveTileToIndex(this.config(), intent.id, intent.toIndex));
  }

  // ── expand overlay (A2 — pure view state, never persisted) ─
  onTileExpand(id: string): void {
    const tile = this.config().tiles.find((t) => t.id === id);
    if (!tile) return;
    // Warm the health fetch at the CLICK for a KPI chart tile, so the overlay's health panel starts its
    // read a mount cycle earlier (the panel consumes this via getKpiHealthShared). Cube/table tiles have
    // no health panel, so no prefetch.
    if (tile.kind === 'chart' && tile.selection.source === 'kpi') this.health.prefetch(tile.selection.kpi);
    this.expanded.set(tile);
  }
  onOverlayClose(): void {
    this.expanded.set(null);
  }

  // ── delete confirmation ───────────────────────────────────
  /** The confirm dialog's request (null = closed), derived from a pending delete. */
  readonly confirmRequest = computed<ConfirmRequest | null>(() =>
    this.pendingDelete()
      ? { title: 'Delete tile?', message: 'This removes the tile from your dashboard.' }
      : null);
  onDeleteConfirm(): void {
    const pending = this.pendingDelete();
    if (pending) this.persist(deleteTile(this.config(), pending.id));
    this.pendingDelete.set(null);
  }
  onDeleteCancel(): void {
    this.pendingDelete.set(null);
  }

  // ── editor outcome ────────────────────────────────────────
  onEditorSave(tile: TileConfig): void {
    const req = this.editorRequest();
    if (!req) return;
    const next = req.mode === 'add'
      // Re-key against the live tiles: the editor's provisional id may collide.
      ? addTile(this.config(), { ...tile, id: newTileId(this.config().tiles) })
      : updateTile(this.config(), tile.id, tile);
    this.editorRequest.set(null);
    this.persist(next);
  }
  onEditorCancel(): void {
    this.editorRequest.set(null);
  }
}
