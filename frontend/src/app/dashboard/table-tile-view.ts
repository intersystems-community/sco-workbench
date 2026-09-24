// frontend/src/app/dashboard/table-tile-view.ts
import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ScModelService } from '../services/sc-model.service';
import { ScDataService } from '../services/sc-data.service';
import { DataBrowserService } from '../services/data-browser.service';
import { resourceForObject } from '../services/sc-data-resources';
import type { ScObjectSummary, ScObjectDetailPayload } from '../services/sc-model.types';
import { DataGridComponent } from './data-grid';
import {
  DEFAULT_PAGE_SIZE, initialPageState, nextPage, prevPage, firstPage, lastPage, sortParam,
  toggleSort, withResult, withTotal, type PageState,
} from './page-state';
import type { TableSelection } from './dashboard-config';

/**
 * View-only table tile: given a TableSelection (a scdata class name), load its
 * columns + one page of rows and render via <app-data-grid>, paging and sorting
 * through the same `page-state.ts` transforms the D1 panel uses. ZERO builder UI —
 * no dropdown, no up-front counts (that surface belongs to the table *builder*,
 * Task 11). Per-tile error/loading/source-gone state so one tile's failure never
 * takes down the dashboard (spec §7). The table's `objectName`/`isCustom` are
 * resolved from the scmodel catalog (the stored selection carries only the
 * className); a className absent from the catalog, or one with no scdata resource,
 * routes to the distinct source-gone state (spec §7 "config references something
 * gone"), parallel to the chart tile's 404 handling.
 */
@Component({
  selector: 'app-table-tile-view',
  standalone: true,
  imports: [DataGridComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Fill the bounded tile body (redesign R8) so <app-data-grid> (its .dg is height:100%)
  // gets a definite height and its own .dg__scroll region becomes the bounded scroller —
  // the table's horizontal bar then sits inside the tile frame instead of below the fold
  // at the end of a full-height grid. The error/sort-error states are short divs above it.
  styles: [`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    app-data-grid { flex: 1 1 auto; min-height: 0; }
  `],
  template: `
    @if (sourceGone()) {
      <div class="tile-source-gone" role="alert">This table's data source is no longer available. Edit the tile to pick another, or delete it.</div>
    } @else if (rowsError()) {
      <div class="tile-error" role="alert">{{ rowsError() }} <button type="button" (click)="retryRows()">Retry</button></div>
    } @else {
      @if (sortError()) {
        <div class="tile-sort-error" role="status">{{ sortError() }}</div>
      }
      <app-data-grid
        [rows]="rows()" [columns]="displayColumns()" [page]="page()"
        [sortable]="!columnsDerived()" [loading]="loadingRows()"
        (sortChange)="onSortChange($event)"
        (pageChange)="onPageChange($event)"></app-data-grid>
    }`,
})
export class TableTileViewComponent {
  private readonly scModel = inject(ScModelService);
  private readonly scData = inject(ScDataService);
  private readonly dataBrowser = inject(DataBrowserService);

  readonly selection = input.required<TableSelection>();

  /** Null when the selected object has no scdata resource / is not in the catalog. */
  private readonly resource = signal<string | null>(null);
  readonly sourceGone = signal(false);

  readonly columns = signal<string[]>([]);
  readonly columnsDerived = signal(false);

  /**
   * The columns actually rendered: the stored `selection.columns` filtered to those
   * available (stored order ∩ available), or all columns when the subset is absent
   * or empty. A display projection — scdata has no column parameter (spec §4), so we
   * fetch every column and render the chosen subset. An empty intersection (every
   * stored column vanished from the source) degrades to all columns so the tile stays
   * useful and editable rather than showing an empty grid.
   */
  readonly displayColumns = computed<string[]>(() => {
    const all = this.columns();
    const wanted = this.selection().columns;
    if (!wanted || wanted.length === 0) return all;
    const projected = wanted.filter((c) => all.includes(c));
    return projected.length ? projected : all;
  });
  readonly rows = signal<Array<Record<string, unknown>>>([]);
  readonly page = signal<PageState>(initialPageState(DEFAULT_PAGE_SIZE));
  readonly loadingRows = signal(false);
  readonly rowsError = signal('');
  readonly sortError = signal('');

  constructor() {
    // Depend ONLY on the selection input; the load reads/writes the tile's own
    // signals (page, resource, columns), which must not become effect dependencies
    // or the row fetch's `page.update` would retrigger the effect in a loop.
    effect(() => { const sel = this.selection(); untracked(() => this.load(sel.table)); });
  }

  private load(className: string): void {
    // Reset per-selection state.
    this.sourceGone.set(false);
    this.columns.set([]);
    this.columnsDerived.set(false);
    this.rows.set([]);
    this.rowsError.set('');
    this.sortError.set('');
    this.resource.set(null);
    this.page.set(initialPageState(DEFAULT_PAGE_SIZE));

    // Resolve className → object via the catalog (the stored selection carries only
    // the className; objectName/isCustom are needed for detail + resource). A table
    // no longer in the catalog is a gone source.
    this.scModel.getObjects().subscribe({
      next: (objs: ScObjectSummary[]) => {
        const obj = (objs ?? []).find((o) => o.className === className);
        if (!obj) { this.sourceGone.set(true); return; }
        const resource = resourceForObject(obj.objectName, obj.isCustom ?? false);
        if (resource === null) { this.sourceGone.set(true); return; } // not browsable via scdata
        this.resource.set(resource);
        this.loadColumns(obj.objectName);
        this.fetchCount(className);
        this.fetchRows();
      },
      error: (err: unknown) => this.rowsError.set(message(err)),
    });
  }

  /** Fetch the exact row total once per selection load (never per page). The count
   *  route never errors; a failure leaves `total` null and the pager degrades to the
   *  returnCount sentinel with Last disabled (spec §7). */
  private fetchCount(className: string): void {
    this.dataBrowser.getCount(className).subscribe((r) => {
      this.page.update((p) => withTotal(p, r.ok ? r.total : null));
    });
  }

  private loadColumns(objectName: string): void {
    this.scModel.getObjectDetail(objectName).subscribe({
      next: (detail: ScObjectDetailPayload) => {
        const names = (detail?.attributes ?? []).map((a) => a.name).filter(Boolean);
        if (names.length) { this.columns.set(names); this.columnsDerived.set(false); }
        else this.deriveColumns();
      },
      error: () => this.deriveColumns(),
    });
  }

  onSortChange(column: string): void {
    const before = this.page();
    this.sortError.set('');
    this.page.set(toggleSort(before, column));
    this.fetchRows({ revertTo: before, column });
  }

  onPageChange(direction: 'next' | 'prev' | 'first' | 'last'): void {
    this.page.update((p) =>
      direction === 'next'  ? nextPage(p)  :
      direction === 'prev'  ? prevPage(p)  :
      direction === 'first' ? firstPage(p) : lastPage(p));
    this.fetchRows();
  }

  retryRows(): void {
    this.fetchRows();
  }

  private fetchRows(revert?: { revertTo: PageState; column: string }): void {
    const resource = this.resource();
    if (resource === null) return;
    const state = this.page();
    this.loadingRows.set(true);
    this.rowsError.set('');
    this.scData
      .getPage(resource, { pageSize: state.pageSize, pageIndex: state.pageIndex, sortBy: sortParam(state) })
      .subscribe({
        next: (result) => {
          this.loadingRows.set(false);
          this.rows.set(result.rows);
          this.page.update((p) => withResult(p, result.returnCount));
          if (this.columnsDerived()) this.deriveColumns();
        },
        error: (err: unknown) => {
          this.loadingRows.set(false);
          if (revert) {
            this.page.set(revert.revertTo);
            this.sortError.set(`Sorting by "${revert.column}" was rejected by the server; reverted.`);
            return;
          }
          this.rowsError.set(message(err));
        },
      });
  }

  private deriveColumns(): void {
    const seen: string[] = [];
    for (const row of this.rows()) {
      for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
    }
    this.columns.set(seen);
    this.columnsDerived.set(true);
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
