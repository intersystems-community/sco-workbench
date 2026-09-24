import {
  DEFAULT_PAGE_SIZE, initialPageState, nextPage, prevPage, toggleSort,
  hasMore, sortParam, withResult, withTotal, rangeLabel,
  firstPage, lastPage, pageLabel, type PageState,
} from './page-state';

const state = (over: Partial<PageState> = {}): PageState => ({ ...initialPageState(), ...over });

describe('page-state', () => {
  it('starts at page 0 with the default size, unsorted and uncounted', () => {
    expect(initialPageState()).toEqual({
      pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE, sortBy: null,
      sortDir: 'asc', returnCount: 0, total: null,
    });
  });

  it('accepts an explicit page size', () => {
    expect(initialPageState(3).pageSize).toBe(3);
  });

  describe('hasMore with an exact total', () => {
    it('is false on the last exactly-full page — the carriers-at-pageSize-3 case', () => {
      // 3 rows, pageSize 3: a full page, so the returnCount sentinel alone
      // would say "more" and paging would land on an empty page.
      expect(hasMore(state({ pageSize: 3, pageIndex: 0, returnCount: 3, total: 3 }))).toBe(false);
    });

    it('is true when a further page exists', () => {
      expect(hasMore(state({ pageSize: 3, pageIndex: 0, returnCount: 3, total: 4 }))).toBe(true);
    });

    it('is false past the end', () => {
      expect(hasMore(state({ pageSize: 3, pageIndex: 1, returnCount: 0, total: 3 }))).toBe(false);
    });

    it('is false for an empty table', () => {
      expect(hasMore(state({ pageSize: 50, pageIndex: 0, returnCount: 0, total: 0 }))).toBe(false);
    });
  });

  describe('hasMore falling back to the sentinel when the count is unavailable', () => {
    it('treats a full page as possibly-more', () => {
      expect(hasMore(state({ pageSize: 50, returnCount: 50, total: null }))).toBe(true);
    });

    it('treats a short page as the last page', () => {
      expect(hasMore(state({ pageSize: 50, returnCount: 12, total: null }))).toBe(false);
    });

    it('treats an empty page as the last page', () => {
      expect(hasMore(state({ pageSize: 50, returnCount: 0, total: null }))).toBe(false);
    });
  });

  describe('paging', () => {
    it('advances one page', () => {
      expect(nextPage(state({ pageIndex: 2 })).pageIndex).toBe(3);
    });

    it('goes back one page', () => {
      expect(prevPage(state({ pageIndex: 2 })).pageIndex).toBe(1);
    });

    it('clamps prevPage at 0', () => {
      expect(prevPage(state({ pageIndex: 0 })).pageIndex).toBe(0);
    });

    it('does not mutate its input', () => {
      const before = state({ pageIndex: 1 });
      nextPage(before);
      expect(before.pageIndex).toBe(1);
    });
  });

  describe('toggleSort', () => {
    it('sorts ascending on a new column', () => {
      const s = toggleSort(state(), 'name');
      expect([s.sortBy, s.sortDir]).toEqual(['name', 'asc']);
    });

    it('flips asc → desc → asc on the same column', () => {
      const asc = toggleSort(state(), 'name');
      const desc = toggleSort(asc, 'name');
      const again = toggleSort(desc, 'name');
      expect([desc.sortBy, desc.sortDir]).toEqual(['name', 'desc']);
      expect([again.sortBy, again.sortDir]).toEqual(['name', 'asc']);
    });

    it('restarts ascending when the column changes', () => {
      const desc = toggleSort(toggleSort(state(), 'name'), 'name');
      const other = toggleSort(desc, 'uid');
      expect([other.sortBy, other.sortDir]).toEqual(['uid', 'asc']);
    });

    it('resets to page 0, because a re-sorted page 3 is meaningless', () => {
      expect(toggleSort(state({ pageIndex: 3 }), 'name').pageIndex).toBe(0);
    });
  });

  describe('sortParam', () => {
    it('is null when unsorted, so no sortBy is sent', () => {
      expect(sortParam(state())).toBeNull();
    });

    it('is the bare column name ascending', () => {
      expect(sortParam(state({ sortBy: 'name', sortDir: 'asc' }))).toBe('name');
    });

    it('prefixes a hyphen for descending', () => {
      expect(sortParam(state({ sortBy: 'name', sortDir: 'desc' }))).toBe('-name');
    });
  });

  describe('withResult / withTotal', () => {
    it('records the returnCount from a fetch', () => {
      expect(withResult(state(), 12).returnCount).toBe(12);
    });

    it('records a total', () => {
      expect(withTotal(state(), 900).total).toBe(900);
    });

    it('records an unavailable total as null', () => {
      expect(withTotal(state({ total: 900 }), null).total).toBeNull();
    });
  });

  describe('rangeLabel', () => {
    it('shows the absolute row range and the total', () => {
      expect(rangeLabel(state({ pageIndex: 2, pageSize: 50, returnCount: 50, total: 900 })))
        .toBe('101–150 of 900');
    });

    it('omits the total when it is unavailable', () => {
      expect(rangeLabel(state({ pageIndex: 0, pageSize: 50, returnCount: 50, total: null })))
        .toBe('1–50');
    });

    it('handles a short last page', () => {
      expect(rangeLabel(state({ pageIndex: 1, pageSize: 50, returnCount: 7, total: 57 })))
        .toBe('51–57 of 57');
    });

    it('handles an empty result', () => {
      expect(rangeLabel(state({ returnCount: 0, total: 0 }))).toBe('0 of 0');
      expect(rangeLabel(state({ returnCount: 0, total: null }))).toBe('0 rows');
    });
  });

  describe('firstPage', () => {
    it('jumps to page 0 from any page', () => {
      expect(firstPage(state({ pageIndex: 5 })).pageIndex).toBe(0);
    });
    it('is a no-op on page 0', () => {
      expect(firstPage(state({ pageIndex: 0 })).pageIndex).toBe(0);
    });
    it('does not mutate its input', () => {
      const before = state({ pageIndex: 5 });
      firstPage(before);
      expect(before.pageIndex).toBe(5);
    });
  });

  describe('lastPage', () => {
    it('lands on the last page when the total is an exact multiple of pageSize', () => {
      // 100 rows, 50 per page → pages 0 and 1; last is index 1.
      expect(lastPage(state({ pageSize: 50, total: 100, pageIndex: 0 })).pageIndex).toBe(1);
    });
    it('lands on the last (partial) page when the total is not a multiple', () => {
      // 101 rows, 50 per page → pages 0,1,2; last is index 2.
      expect(lastPage(state({ pageSize: 50, total: 101, pageIndex: 0 })).pageIndex).toBe(2);
    });
    it('clamps to 0 for an empty table', () => {
      expect(lastPage(state({ pageSize: 50, total: 0, pageIndex: 0 })).pageIndex).toBe(0);
    });
    it('is unchanged when the total is unknown (no last page can be computed)', () => {
      const s = state({ pageSize: 50, total: null, pageIndex: 3 });
      expect(lastPage(s)).toEqual(s);
    });
    it('does not mutate its input', () => {
      const before = state({ pageSize: 50, total: 100, pageIndex: 0 });
      lastPage(before);
      expect(before.pageIndex).toBe(0);
    });
  });

  describe('pageLabel', () => {
    it('shows the 1-based page of the known page count', () => {
      expect(pageLabel(state({ pageIndex: 1, pageSize: 50, total: 900 }))).toBe('2 / 18');
    });
    it('shows the last page correctly', () => {
      expect(pageLabel(state({ pageIndex: 17, pageSize: 50, total: 900 }))).toBe('18 / 18');
    });
    it('clamps an empty table to one page (never "1 / 0")', () => {
      expect(pageLabel(state({ pageIndex: 0, pageSize: 50, returnCount: 0, total: 0 }))).toBe('1 / 1');
    });
    it('drops the count when the total is unknown', () => {
      expect(pageLabel(state({ pageIndex: 1, total: null }))).toBe('page 2');
    });
  });
});
