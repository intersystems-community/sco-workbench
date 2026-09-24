// frontend/src/app/dashboard/table-builder.ts
import { Component, ChangeDetectionStrategy, DestroyRef, ElementRef, OnInit, effect, inject, input, output, signal, computed, untracked } from '@angular/core';
import { ScModelService } from '../services/sc-model.service';
import { DataBrowserService, type CountResult } from '../services/data-browser.service';
import type { ScObjectSummary } from '../services/sc-model.types';
import { TableTileViewComponent } from './table-tile-view';
import { orderPopulatedFirst } from './table-order';
import { humanizeField } from './humanize';
import type { TableSelection } from './dashboard-config';

/**
 * The TABLE builder — the picker half of the old `table-panel`, extracted so the
 * tile editor (Task 12) can host it. It owns ONLY the selection surface: the table
 * dropdown with its up-front row counts and populated-first ordering (Change 6/M2).
 * The product is a `TableSelection` (just `{ table }`), emitted via
 * `selectionChange` on every pick — never a built anything. Its live preview IS
 * `TableTileViewComponent` fed the in-progress selection, so what you build is
 * pixel-identical to the dashboard tile (spec §5, one render seam). `valid` gates
 * the editor's Save: false until a table is chosen. Zoneless: every state change is
 * a signal write.
 */
@Component({
  selector: 'app-table-builder',
  standalone: true,
  imports: [TableTileViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './table-builder.css',
  template: `
    <div class="tb">
      @if (catalogError()) {
        <p class="tb__error" data-testid="catalog-error">Could not load the data model: {{ catalogError() }}</p>
      } @else {
        <div class="db-builder-section">
          <!-- The section title IS the control's label (SC-2665 label-collapse): the dropdown's
               accessible name comes from aria-labelledby → the title word, matching the Columns
               fieldset below, which already names itself once (its <legend>) with no per-row repeat. -->
          <div class="db-builder-section-title"><span id="tb-table-label">Table</span>
            <span class="db-builder-section-hint" id="tb-table-hint">The data table these rows come from.</span></div>
          <div class="tb__field">
            <!-- Selection is driven by each option's [selected] (not the select's [value]) so a
                 programmatic pre-select in edit mode is order-independent: binding [value] before
                 the @for options render leaves a native select on its first enabled option. -->
            <select class="db-builder-control" data-testid="table-select"
                    aria-labelledby="tb-table-label" aria-describedby="tb-table-hint"
                    (change)="onSelect($any($event.target).value)">
              <option value="" disabled [selected]="table() === null">Select a table…</option>
              @for (o of orderedObjects(); track o.className) {
                <option [value]="o.className" [selected]="o.className === table()" [title]="o.description">{{ label(o) }}{{ countSuffix(o) }}</option>
              }
            </select>
          </div>
          @if (loadingObjects()) {
            <span class="db-builder-note" data-testid="table-loading" role="status">Loading tables…</span>
          }
        </div>

        @if (draftSelection(); as sel) {
          <div class="tb__preview">
            <app-table-tile-view [selection]="sel" />
          </div>
        }

        @if (allColumns().length) {
          <fieldset class="tb__columns" data-testid="column-control">
            <legend class="db-builder-section-title">Columns
              <span class="db-builder-section-hint">Which columns to show, and in what order.</span></legend>
            <!-- Add trigger sits high (above the scrolling rows) so its downward \`top:100%\` popover
                 opens over the visible rows band and stays OUTSIDE .tb__col-scroll's overflow:auto,
                 never clipped by .te-body (which keeps overflow:auto). -->
            @if (excludedColumns().length) {
              <div class="tb__add">
                <button type="button" class="tb__add-btn" data-testid="col-add-btn"
                        [attr.aria-expanded]="addOpen()" (click)="toggleAddMenu()">
                  + Add column ({{ excludedColumns().length }})
                </button>
                @if (addOpen()) {
                  <div class="tb__add-menu" data-testid="col-add-menu">
                    <input class="tb__add-filter" type="text" data-testid="col-add-filter"
                           placeholder="Filter columns…" [value]="addFilter()"
                           (input)="addFilter.set($any($event.target).value)" />
                    <div class="tb__add-list">
                      @for (col of addCandidates(); track col) {
                        <button type="button" class="tb__add-item" data-testid="col-add-item"
                                (click)="addColumn(col)">{{ label2(col) }}</button>
                      } @empty {
                        <p class="tb__add-empty">No matching columns</p>
                      }
                    </div>
                  </div>
                }
              </div>
            }
            <div class="tb__col-scroll">
              @for (col of selectedColumns(); track col; let idx = $index) {
                <div class="tb__col-row" data-testid="col-row"
                     [class.tb__col-row--dragover]="dragOverCol() === col"
                     (dragover)="onDragOver($event, col)" (drop)="onDrop($event, col)"
                     (dragleave)="onDragLeave(col)">
                  <span class="tb__col-grip" data-testid="col-grip" draggable="true" aria-hidden="true"
                        (dragstart)="onDragStart($event, col)" (dragend)="onDragEnd()"
                        title="Drag to reorder {{ label2(col) }}">⠿</span>
                  <label class="tb__col-check">
                    <input type="checkbox" checked
                           [disabled]="selectedColumns().length === 1"
                           (change)="toggleColumn(col)" />
                    <span>{{ label2(col) }}</span>
                  </label>
                  <button type="button" class="tb__col-move" data-testid="col-up"
                          [disabled]="idx === 0" (click)="moveColumn(col, -1)"
                          [attr.aria-label]="'Move ' + label2(col) + ' up'">▲</button>
                  <button type="button" class="tb__col-move" data-testid="col-down"
                          [disabled]="idx === selectedColumns().length - 1" (click)="moveColumn(col, 1)"
                          [attr.aria-label]="'Move ' + label2(col) + ' down'">▼</button>
                </div>
              }
            </div>
          </fieldset>
        }
      }
    </div>`,
})
export class TableBuilderComponent implements OnInit {
  private readonly scModel = inject(ScModelService);
  private readonly dataBrowser = inject(DataBrowserService);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The selection to initialize from (edit mode), or null (add mode). */
  readonly selection = input<TableSelection | null>(null);
  readonly selectionChange = output<TableSelection>();
  readonly valid = output<boolean>();

  readonly objects = signal<ScObjectSummary[]>([]);
  readonly catalogError = signal('');
  readonly loadingObjects = signal(false);   // the table catalog fetch is in flight (cube/KPI parity)
  readonly counts = signal<Record<string, CountResult>>({});
  /** Picker order: populated tables first, known-empty last (Change 6/M2). */
  readonly orderedObjects = computed(() => orderPopulatedFirst(this.objects(), this.counts()));

  /** The chosen className (the selection key + dropdown value), or null. */
  readonly table = signal<string | null>(null);

  /** The full attribute list from scmodel, in natural order — the candidate universe. */
  readonly allColumns = signal<string[]>([]);
  /** The included columns, in display order (drives the emitted `columns`). */
  readonly selectedColumns = signal<string[]>([]);
  /** Excluded columns, shown below the included set in natural order. */
  readonly excludedColumns = computed(() => this.allColumns().filter((c) => !this.selectedColumns().includes(c)));
  /** A stored subset to restore once the attribute list has loaded (edit mode). */
  private pendingColumns: string[] | null = null;

  /** The current draft selection, or null when nothing is picked (drives the preview + emit).
   *  `columns` is omitted when every column is kept in scmodel's natural order — the blob
   *  then equals an untouched tile and "absent = all" keeps old tiles rendering. */
  readonly draftSelection = computed<TableSelection | null>(() => {
    const t = this.table();
    if (!t) return null;
    const all = this.allColumns();
    const sel = this.selectedColumns();
    if (all.length === 0 || sameOrder(sel, all)) return { table: t };
    return { table: t, columns: sel };
  });

  constructor() {
    // Close the Add menu on any click outside this builder's frame — the same transient-popover
    // idiom as the tile-host ⋯ menu (tile-host.ts). The opening click on the Add button is inside
    // the host, so `contains` is true and the menu never self-closes; the listener is cleaned via
    // DestroyRef. Reorder / toggle interactions close it directly (closeAddMenu), so this covers
    // only the "clicked away" case.
    const onDocClick = (e: MouseEvent) => {
      if (this.addOpen() && !this.hostEl.nativeElement.contains(e.target as Node)) {
        this.closeAddMenu();
      }
    };
    document.addEventListener('click', onDocClick, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('click', onDocClick, true));

    // Adopt an incoming selection (edit mode) as the initial pick, stashing any stored
    // subset for the column-load effect to restore. Reads only the `selection` input;
    // the emit happens in ngOnInit / onSelect / loadColumnsFor, not here, so this effect
    // never feeds its own writes.
    effect(() => {
      const incoming = this.selection();
      if (incoming) {
        this.table.set(incoming.table);
        this.pendingColumns = incoming.columns ?? null;
      }
    });

    // Load the picked table's columns once both the selection and the catalog are ready.
    // Reads `table` + `objects`; the detail fetch writes column signals under untracked
    // so this effect never feeds its own dependencies (the table-tile-view idiom).
    effect(() => {
      const className = this.table();
      const objs = this.objects();
      if (!className || objs.length === 0) return;
      untracked(() => this.loadColumnsFor(className, objs));
    });
  }

  ngOnInit(): void {
    // Announce the initial validity so the editor's Save starts correctly gated
    // (false in add mode, true when opened on an existing table).
    this.valid.emit(this.table() !== null);
    this.loadingObjects.set(true);
    this.scModel.getObjects().subscribe({
      next: (objs: ScObjectSummary[]) => {
        const list = objs ?? [];
        this.objects.set(list);
        this.loadingObjects.set(false);
        if (list.length) {
          this.dataBrowser.getCounts(list.map((o) => o.className)).subscribe((counts) => this.counts.set(counts));
        }
      },
      error: (err: unknown) => { this.loadingObjects.set(false); this.catalogError.set(message(err)); },
    });
  }

  onSelect(className: string): void {
    if (!className || this.table() === className) return;
    this.pendingColumns = null; // a fresh pick starts from "all columns"
    this.allColumns.set([]);
    this.selectedColumns.set([]);
    this.closeAddMenu(); // don't carry a stale open menu across a table change
    this.table.set(className);
    this.emitSelection(); // {table} now; a later toggle re-emits with columns
  }

  /** Fetch the table's attributes and seed the included set (restoring a stored subset
   *  in edit mode, else all columns in natural order). */
  private loadColumnsFor(className: string, objs: ScObjectSummary[]): void {
    const obj = objs.find((o) => o.className === className);
    if (!obj) { this.allColumns.set([]); this.selectedColumns.set([]); return; }
    this.scModel.getObjectDetail(obj.objectName).subscribe({
      next: (detail: { attributes?: { name: string }[] }) => {
        const names = (detail?.attributes ?? []).map((a) => a.name).filter(Boolean);
        this.allColumns.set(names);
        const restored = this.pendingColumns?.filter((c) => names.includes(c)) ?? null;
        this.selectedColumns.set(restored && restored.length ? restored : [...names]);
        this.pendingColumns = null;
        this.emitSelection();
      },
      error: () => { this.allColumns.set([]); this.selectedColumns.set([]); this.emitSelection(); },
    });
  }

  toggleColumn(col: string): void {
    const sel = this.selectedColumns();
    if (sel.includes(col)) {
      if (sel.length === 1) return; // at least one column must remain
      this.selectedColumns.set(sel.filter((c) => c !== col));
    } else {
      this.selectedColumns.set([...sel, col]); // re-include at the end
    }
    this.closeAddMenu(); // acting on the control dismisses the transient popover
    this.emitSelection();
  }

  // ── Add menu: the available (unselected) columns, collapsed behind one button and
  // filterable, instead of a persistent row each. Keeps the control's footprint to
  // ~selected + 1 (Sweller extraneous load; Hick's Law on the long tail). The reorder /
  // membership logic is unchanged — `addColumn` funnels through `toggleColumn`. ──
  readonly addOpen = signal(false);
  readonly addFilter = signal('');
  /** The pool filtered by the (case-insensitive) query, matched on the humanized label the
   *  user sees — so typing "track" finds "Tracking URL". */
  readonly addCandidates = computed(() => {
    const q = this.addFilter().trim().toLowerCase();
    const pool = this.excludedColumns();
    if (!q) return pool;
    return pool.filter((c) => this.label2(c).toLowerCase().includes(q));
  });

  toggleAddMenu(): void {
    const next = !this.addOpen();
    this.addOpen.set(next);
    if (next) this.addFilter.set(''); // a fresh open starts unfiltered
  }

  /** Dismiss the Add menu and clear its filter. The single close path: acting on the control
   *  (reorder / toggle / add / table change) or a click outside all funnel here, matching the
   *  tile-host ⋯ menu where any action or an outside click dismisses the popover. */
  private closeAddMenu(): void {
    if (!this.addOpen()) return;
    this.addOpen.set(false);
    this.addFilter.set('');
  }

  /** Add a column from the pool (appends to the end via toggleColumn) and close the menu. */
  addColumn(col: string): void {
    if (this.selectedColumns().includes(col)) return;
    this.toggleColumn(col);
    this.closeAddMenu();
  }

  /** Step a column one slot up (-1) or down (+1) — the keyboard/click reorder path. */
  moveColumn(col: string, delta: number): void {
    const sel = this.selectedColumns();
    const i = sel.indexOf(col);
    this.moveColumnTo(col, i + delta);
  }

  /** Move a column to an absolute index in the included set. The shared reorder primitive:
   *  `moveColumn` (arrows) and the drag grip both funnel here, so one code path is tested. */
  moveColumnTo(col: string, target: number): void {
    const sel = [...this.selectedColumns()];
    const i = sel.indexOf(col);
    if (i < 0 || target < 0 || target >= sel.length || target === i) return;
    sel.splice(i, 1);
    sel.splice(target, 0, col);
    this.selectedColumns.set(sel);
    this.closeAddMenu(); // reordering is an action on the control — dismiss the popover
    this.emitSelection();
  }

  // ── Drag-to-reorder: an ADDITIVE power path over the arrows (never the only one — the
  // arrows stay for keyboard/touch, WCAG 2.1.1). The grip handle carries `draggable`, not
  // the whole row, so drag does not collide with the label's click-to-toggle. Reorder logic
  // is `moveColumnTo`; these handlers only translate DnD events into a target index. ──
  readonly draggingCol = signal<string | null>(null);
  readonly dragOverCol = signal<string | null>(null);

  onDragStart(ev: DragEvent, col: string): void {
    this.draggingCol.set(col);
    ev.dataTransfer?.setData('text/plain', col);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }
  onDragOver(ev: DragEvent, col: string): void {
    if (!this.draggingCol()) return;
    ev.preventDefault(); // allow the drop
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    if (col !== this.dragOverCol()) this.dragOverCol.set(col);
  }
  onDragLeave(col: string): void {
    if (this.dragOverCol() === col) this.dragOverCol.set(null);
  }
  onDrop(ev: DragEvent, targetCol: string): void {
    ev.preventDefault();
    const dragged = this.draggingCol() ?? ev.dataTransfer?.getData('text/plain') ?? '';
    this.dragOverCol.set(null);
    this.draggingCol.set(null);
    if (!dragged || dragged === targetCol) return;
    const target = this.selectedColumns().indexOf(targetCol);
    if (target >= 0) this.moveColumnTo(dragged, target);
  }
  onDragEnd(): void {
    this.draggingCol.set(null);
    this.dragOverCol.set(null);
  }

  /** The last selection emitted, for suppressing a duplicate emission. */
  private lastEmitted: TableSelection | null = null;

  private emitSelection(): void {
    const sel = this.draftSelection();
    if (!sel) return;
    this.valid.emit(true);
    // Suppress a re-emit of a deep-equal selection. Without this, `onSelect` emits
    // `{table}` and then the column-load effect fires synchronously in the SAME
    // change-detection pass — with no user column change it re-derives the identical
    // `{table}` draft, firing `selectionChange` twice. An exact-array assertion
    // (table-builder.spec.ts:60 `toEqual([{ table }])`) would go red on the duplicate;
    // more importantly a builder should not announce a selection that did not change.
    if (sameSelection(sel, this.lastEmitted)) return;
    this.lastEmitted = sel;
    this.selectionChange.emit(sel);
  }

  /** The readable table label (camelCase objectName → Title Case), display-only (Change 5/M1). */
  label(obj: ScObjectSummary): string {
    return humanizeField(obj.objectName);
  }

  /** Humanized column label for the control (display only; the stored name stays raw). */
  label2(col: string): string { return humanizeField(col); }

  /** The " (n)" row-count suffix, or "" while loading / on a per-table count failure. */
  countSuffix(obj: ScObjectSummary): string {
    const c = this.counts()[obj.className];
    return c?.ok ? ` (${c.total})` : '';
  }
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameSelection(a: TableSelection, b: TableSelection | null): boolean {
  if (!b || a.table !== b.table) return false;
  const ac = a.columns ?? null;
  const bc = b.columns ?? null;
  if (ac === null || bc === null) return ac === bc; // both absent = equal; one absent = not
  return sameOrder(ac, bc);
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
