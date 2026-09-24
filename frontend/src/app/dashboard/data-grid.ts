import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { hasMore, pageLabel, rangeLabel, type PageState } from './page-state';
import { humanizeField, humanizeTimestamp, timestampColumns } from './humanize';

/**
 * A paged, sortable table of raw rows. Purely presentational: no services, no
 * HTTP, no arithmetic — it emits intent (`sortChange`, `pageChange`) and the
 * parent applies `page-state.ts`. Having no injected dependencies is also the
 * seam D2/D3 need: a chart can be mounted beside the same fetch result without
 * touching this component.
 *
 *   <app-data-grid
 *     [rows]="rows()" [columns]="columns()" [page]="page()"
 *     [sortable]="!columnsAreDerived()" [loading]="loadingRows()"
 *     (sortChange)="onSortChange($event)"
 *     (pageChange)="onPageChange($event)">
 *   </app-data-grid>
 */
@Component({
  selector: 'app-data-grid',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dg">
      <div class="dg__bar">
        <span class="dg__range" data-testid="range">{{ label }}</span>
        @if (loading) {
          <span class="dg__loading" data-testid="loading">Loading…</span>
        }
        <span class="dg__spacer"></span>
        <button class="dg__nav" data-testid="first" aria-label="First page"
                [disabled]="page.pageIndex === 0" (click)="pageChange.emit('first')">⏮</button>
        <button class="dg__nav" data-testid="prev" aria-label="Previous page"
                [disabled]="page.pageIndex === 0" (click)="pageChange.emit('prev')">‹</button>
        <span class="dg__page" data-testid="page-label">{{ pageLabelText }}</span>
        <button class="dg__nav" data-testid="next" aria-label="Next page"
                [disabled]="!canGoNext" (click)="pageChange.emit('next')">›</button>
        <button class="dg__nav" data-testid="last" aria-label="Last page"
                [disabled]="!canGoLast" (click)="pageChange.emit('last')">⏭</button>
      </div>

      <div class="dg__scroll">
        <table class="dg__table">
          <thead>
            <tr>
              @for (col of columns; track col) {
                <th [class.is-sorted]="page.sortBy === col">
                  @if (sortable) {
                    <button class="dg__sort" type="button" (click)="sortChange.emit(col)">
                      {{ headerLabel(col) }}<span class="dg__arrow">{{ arrowFor(col) }}</span>
                    </button>
                  } @else {
                    {{ headerLabel(col) }}
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows; track $index) {
              <tr>
                @for (col of columns; track col) {
                  <td>{{ cell(row, col) }}</td>
                }
              </tr>
            }
          </tbody>
        </table>

        @if (rows.length === 0 && !loading) {
          <p class="dg__empty">No rows.</p>
        }
      </div>
    </div>
  `,
  styleUrl: './data-grid.css',
})
export class DataGridComponent {
  @Input() rows: Array<Record<string, unknown>> = [];
  /** Column names, in display order. From scmodel when available. */
  @Input() columns: string[] = [];
  @Input() page: PageState = { pageIndex: 0, pageSize: 0, sortBy: null, sortDir: 'asc', returnCount: 0, total: null };
  /**
   * False when `columns` were derived from row keys rather than reported by
   * scmodel: `GetOrderByClause` rejects unknown columns with HTTP 500, so an
   * unverified column must not be offered as sortable.
   */
  @Input() sortable = true;
  @Input() loading = false;

  /** The bare column name; the parent decides the direction via `toggleSort`. */
  @Output() sortChange = new EventEmitter<string>();
  /** Intent only — the parent applies `nextPage`/`prevPage`/`firstPage`/`lastPage`. */
  @Output() pageChange = new EventEmitter<'next' | 'prev' | 'first' | 'last'>();

  get label(): string {
    return rangeLabel(this.page);
  }

  get canGoNext(): boolean {
    return hasMore(this.page);
  }

  /** Last is a computed jump, so it needs the exact total: enabled only when the
   *  count is known AND a further page exists (an unknown total keeps Last dark,
   *  even though Next stays live off the returnCount sentinel). */
  get canGoLast(): boolean {
    return this.page.total !== null && hasMore(this.page);
  }

  /** "X / Y" when the total is known, "page X" when it is not (from the pure core). */
  get pageLabelText(): string {
    return pageLabel(this.page);
  }

  private _tsRowsRef: unknown = null;
  private _tsCols = new Set<string>();
  /** The columns to render as humanized timestamps — decided column-consistently
   *  (D2-SPEC-15), memoized on the current rows array identity. */
  private timestampCols(): Set<string> {
    if (this._tsRowsRef !== this.rows) {
      this._tsRowsRef = this.rows;
      this._tsCols = timestampColumns(this.rows, this.columns);
    }
    return this._tsCols;
  }

  /** Display label for a column header — humanized (display only; sort uses `col`). */
  headerLabel(col: string): string { return humanizeField(col); }

  arrowFor(col: string): string {
    if (this.page.sortBy !== col) return '';
    return this.page.sortDir === 'asc' ? ' ▴' : ' ▾';
  }

  /** Rendered text for one cell. Timestamp columns (column-consistent, D2-SPEC-15)
   *  render a readable UTC form; every other value is unchanged (IDs stay raw). A
   *  row may omit a column whose value is empty. */
  cell(row: Record<string, unknown>, col: string): string {
    const value = row[col];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' && this.timestampCols().has(col)) return humanizeTimestamp(value);
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}
