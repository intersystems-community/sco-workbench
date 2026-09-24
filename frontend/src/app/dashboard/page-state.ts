/**
 * Paging and sort arithmetic for the Dashboard — the functional core.
 *
 * Pure functions over plain data: no Angular, no interfaces to implement,
 * nothing injected. That is what makes it testable with no framework at all,
 * and it is why the Dashboard's component only holds signals and calls
 * services. Note this is a functional core / imperative shell split, NOT
 * ports-and-adapters: nothing here inverts a dependency. The backend's
 * `SqlQuerier` port is the real hexagon.
 */

/** Rows per page. scdata's own default is 100; 50 fits a screen without scroll-thrash. */
export const DEFAULT_PAGE_SIZE = 50;

export interface PageState {
  /** Zero-based, matching scdata's `pageIndex`. */
  pageIndex: number;
  pageSize: number;
  /** Column name with no direction prefix; null when unsorted. */
  sortBy: string | null;
  sortDir: 'asc' | 'desc';
  /** Rows the last fetch actually returned (scdata's `RETURNCOUNT`). */
  returnCount: number;
  /** Exact row total from the count route; null when unavailable. */
  total: number | null;
}

export function initialPageState(pageSize: number = DEFAULT_PAGE_SIZE): PageState {
  return { pageIndex: 0, pageSize, sortBy: null, sortDir: 'asc', returnCount: 0, total: null };
}

export function nextPage(s: PageState): PageState {
  return { ...s, pageIndex: s.pageIndex + 1 };
}

export function prevPage(s: PageState): PageState {
  return { ...s, pageIndex: Math.max(0, s.pageIndex - 1) };
}

/** Same column → flip direction; new column → start ascending. Either way, back to page 0. */
export function toggleSort(s: PageState, column: string): PageState {
  const sortDir = s.sortBy === column && s.sortDir === 'asc' ? 'desc' : 'asc';
  return { ...s, sortBy: column, sortDir, pageIndex: 0 };
}

/**
 * Exact bounds when the total is known; the `returnCount === pageSize` sentinel
 * only as a fallback. The distinction is not pedantry: sentinel-only paging
 * offers a next page whenever the row total is an exact multiple of `pageSize`
 * and then shows an empty one — `carriers` (3 rows) hits that at `pageSize=3`.
 */
export function hasMore(s: PageState): boolean {
  if (s.total !== null) return (s.pageIndex + 1) * s.pageSize < s.total;
  return s.returnCount === s.pageSize && s.returnCount > 0;
}

/** The `sortBy` query value: `-` prefix means DESC to scdata. Null → send nothing. */
export function sortParam(s: PageState): string | null {
  if (!s.sortBy) return null;
  return s.sortDir === 'desc' ? `-${s.sortBy}` : s.sortBy;
}

export function withResult(s: PageState, returnCount: number): PageState {
  return { ...s, returnCount };
}

export function withTotal(s: PageState, total: number | null): PageState {
  return { ...s, total };
}

/**
 * `"101–150 of 900"`, or `"1–50"` when the count is unavailable.
 * No `toLocaleString`: locale-dependent output makes the test environment-dependent.
 */
export function rangeLabel(s: PageState): string {
  if (s.returnCount === 0) return s.total !== null ? `0 of ${s.total}` : '0 rows';
  const first = s.pageIndex * s.pageSize + 1;
  const last = s.pageIndex * s.pageSize + s.returnCount;
  return s.total !== null ? `${first}–${last} of ${s.total}` : `${first}–${last}`;
}

/** Jump to the first page. */
export function firstPage(s: PageState): PageState {
  return { ...s, pageIndex: 0 };
}

/**
 * Jump to the last page — only computable when the exact total is known;
 * with `total === null` there is no last page to land on, so `s` is returned
 * unchanged (the caller keeps Last disabled in that case).
 */
export function lastPage(s: PageState): PageState {
  if (s.total === null) return s;
  return { ...s, pageIndex: Math.max(0, Math.ceil(s.total / s.pageSize) - 1) };
}

/**
 * `"2 / 18"` when the total is known (1-based page of the page count), or
 * `"page 2"` when it is not. The page count is clamped to at least 1 so an
 * empty table reads `"1 / 1"`, never `"1 / 0"` — mirroring `rangeLabel`'s
 * "0 of 0" handling on the range side.
 */
export function pageLabel(s: PageState): string {
  const page = s.pageIndex + 1;
  if (s.total === null) return `page ${page}`;
  const count = Math.max(1, Math.ceil(s.total / s.pageSize));
  return `${page} / ${count}`;
}
