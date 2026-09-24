import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DataGridComponent } from './data-grid';
import { initialPageState, type PageState } from './page-state';

describe('DataGridComponent', () => {
  let fixture: ComponentFixture<DataGridComponent>;
  let el: HTMLElement;

  const page = (over: Partial<PageState> = {}): PageState => ({ ...initialPageState(3), ...over });

  async function render(inputs: {
    rows?: Array<Record<string, unknown>>;
    columns?: string[];
    page?: PageState;
    sortable?: boolean;
    loading?: boolean;
  }) {
    fixture = TestBed.createComponent(DataGridComponent);
    fixture.componentRef.setInput('rows', inputs.rows ?? []);
    fixture.componentRef.setInput('columns', inputs.columns ?? []);
    fixture.componentRef.setInput('page', inputs.page ?? page());
    fixture.componentRef.setInput('sortable', inputs.sortable ?? true);
    fixture.componentRef.setInput('loading', inputs.loading ?? false);
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [DataGridComponent] }));

  it('renders one header cell per column, in the order given', async () => {
    await render({ columns: ['uid', 'name', 'type'] });
    const heads = Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim());
    expect(heads).toEqual(['UID', 'Name', 'Type']);
  });

  it('renders one row per record and reads cells by column, not by key order', async () => {
    await render({
      columns: ['name', 'uid'],
      rows: [{ uid: 'C1', name: 'Acme' }, { uid: 'C2', name: 'Byrd' }],
      page: page({ returnCount: 2, total: 2 }),
    });
    const cells = Array.from(el.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim()),
    );
    expect(cells).toEqual([['Acme', 'C1'], ['Byrd', 'C2']]);
  });

  it('renders a blank cell for a column a row does not carry', async () => {
    await render({
      columns: ['name', 'trackingUrl'],
      rows: [{ name: 'Acme' }],
      page: page({ returnCount: 1, total: 1 }),
    });
    const cells = Array.from(el.querySelectorAll('tbody td')).map((td) => td.textContent?.trim());
    expect(cells).toEqual(['Acme', '']);
  });

  it('emits the bare column name on a header click, leaving direction to the parent', async () => {
    await render({ columns: ['uid', 'name'] });
    const emitted: string[] = [];
    fixture.componentInstance.sortChange.subscribe((c) => emitted.push(c));
    el.querySelectorAll<HTMLElement>('th button')[1]?.click();
    expect(emitted).toEqual(['name']);
  });

  it('offers no sort control at all when sortable is false', async () => {
    await render({ columns: ['uid', 'name'], sortable: false });
    expect(el.querySelectorAll('th button')).toHaveLength(0);
  });

  it('marks the sorted column with its direction', async () => {
    await render({ columns: ['uid', 'name'], page: page({ sortBy: 'name', sortDir: 'desc' }) });
    const marked = el.querySelector('th.is-sorted');
    expect(marked?.textContent).toContain('Name');
    expect(marked?.textContent).toContain('▾');
  });

  it('emits next and prev rather than computing page indexes', async () => {
    await render({
      columns: ['uid'],
      rows: [{ uid: 'C1' }, { uid: 'C2' }, { uid: 'C3' }],
      page: page({ pageIndex: 1, returnCount: 3, total: 99 }),
    });
    const emitted: Array<'next' | 'prev' | 'first' | 'last'> = [];
    fixture.componentInstance.pageChange.subscribe((d) => emitted.push(d));
    el.querySelector<HTMLElement>('[data-testid="prev"]')?.click();
    el.querySelector<HTMLElement>('[data-testid="next"]')?.click();
    expect(emitted).toEqual(['prev', 'next']);
  });

  it('disables prev on the first page and next on the last', async () => {
    await render({
      columns: ['uid'],
      rows: [{ uid: 'C1' }, { uid: 'C2' }, { uid: 'C3' }],
      page: page({ pageIndex: 0, pageSize: 3, returnCount: 3, total: 3 }),
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="prev"]')?.disabled).toBe(true);
    // total 3 with pageSize 3 on page 0: exactly one full page, so no next page.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="next"]')?.disabled).toBe(true);
  });

  it('shows the range label from the pure core', async () => {
    await render({
      columns: ['uid'],
      rows: [{ uid: 'C1' }],
      page: page({ pageIndex: 1, pageSize: 3, returnCount: 1, total: 4 }),
    });
    expect(el.querySelector('[data-testid="range"]')?.textContent?.trim()).toBe('4–4 of 4');
  });

  it('says so when there are no rows', async () => {
    await render({ columns: ['uid'], rows: [], page: page({ returnCount: 0, total: 0 }) });
    expect(el.textContent).toContain('No rows');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('shows a loading state without discarding the rows already on screen', async () => {
    await render({
      columns: ['uid'], rows: [{ uid: 'C1' }],
      page: page({ returnCount: 1, total: 1 }), loading: true,
    });
    expect(el.querySelector('[data-testid="loading"]')).not.toBeNull();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('renders humanized column headers but sorts by the raw column name (Change 5)', async () => {
    const fixture = TestBed.createComponent(DataGridComponent);
    const c = fixture.componentInstance;
    c.rows = [{ salesOrderId: 'SO-1', recordCreatedTime: '2026-08-20T19:57:18.757Z' }];
    c.columns = ['salesOrderId', 'recordCreatedTime'];
    c.sortable = true;
    fixture.detectChanges();

    const headers = [...fixture.nativeElement.querySelectorAll('th')].map((th: HTMLElement) => th.textContent!.trim());
    expect(headers[0]).toContain('Sales Order ID');
    expect(headers[1]).toContain('Record Created Time');

    const emitted: string[] = [];
    c.sortChange.subscribe((v: string) => emitted.push(v));
    (fixture.nativeElement.querySelector('.dg__sort') as HTMLButtonElement).click();
    expect(emitted).toEqual(['salesOrderId']); // RAW column name, not the humanized label
  });

  it('humanizes a strict-ISO timestamp cell but leaves an ID cell raw (Change 5)', async () => {
    const fixture = TestBed.createComponent(DataGridComponent);
    const c = fixture.componentInstance;
    c.rows = [{ uid: '34620997-abcd-10', recordCreatedTime: '2026-08-20T19:57:18.757Z' }];
    c.columns = ['uid', 'recordCreatedTime'];
    fixture.detectChanges();

    const cells = [...fixture.nativeElement.querySelectorAll('tbody td')].map((td: HTMLElement) => td.textContent!.trim());
    expect(cells[0]).toBe('34620997-abcd-10');            // ID stays raw
    expect(cells[1]).toBe('2026-08-20 19:57:18 UTC');     // timestamp humanized
  });

  describe('First / Last pager (B3)', () => {
    it('emits first and last, not computed page indexes', async () => {
      await render({
        columns: ['uid'],
        rows: [{ uid: 'C1' }, { uid: 'C2' }, { uid: 'C3' }],
        page: page({ pageIndex: 1, pageSize: 3, returnCount: 3, total: 99 }),
      });
      const emitted: Array<'next' | 'prev' | 'first' | 'last'> = [];
      fixture.componentInstance.pageChange.subscribe((d) => emitted.push(d));
      el.querySelector<HTMLElement>('[data-testid="first"]')?.click();
      el.querySelector<HTMLElement>('[data-testid="last"]')?.click();
      expect(emitted).toEqual(['first', 'last']);
    });

    it('disables First on the first page (same guard as Prev)', async () => {
      await render({ columns: ['uid'], page: page({ pageIndex: 0, pageSize: 3, returnCount: 3, total: 9 }) });
      expect(el.querySelector<HTMLButtonElement>('[data-testid="first"]')?.disabled).toBe(true);
    });

    it('disables Last when the total is unknown', async () => {
      await render({ columns: ['uid'], page: page({ pageIndex: 0, pageSize: 3, returnCount: 3, total: null }) });
      expect(el.querySelector<HTMLButtonElement>('[data-testid="last"]')?.disabled).toBe(true);
    });

    it('disables Last when already on the last page', async () => {
      // total 3, pageSize 3, page 0 → exactly one full page: no further page.
      await render({ columns: ['uid'], page: page({ pageIndex: 0, pageSize: 3, returnCount: 3, total: 3 }) });
      expect(el.querySelector<HTMLButtonElement>('[data-testid="last"]')?.disabled).toBe(true);
    });

    it('enables Last when the total is known and a further page exists', async () => {
      await render({ columns: ['uid'], page: page({ pageIndex: 0, pageSize: 3, returnCount: 3, total: 9 }) });
      expect(el.querySelector<HTMLButtonElement>('[data-testid="last"]')?.disabled).toBe(false);
    });

    it('shows "X / Y" only when the total is known', async () => {
      await render({ columns: ['uid'], page: page({ pageIndex: 1, pageSize: 3, returnCount: 3, total: 9 }) });
      expect(el.querySelector('[data-testid="page-label"]')?.textContent?.trim()).toBe('2 / 3');
    });

    it('shows "page N" when the total is unknown', async () => {
      await render({ columns: ['uid'], page: page({ pageIndex: 1, pageSize: 3, returnCount: 3, total: null }) });
      expect(el.querySelector('[data-testid="page-label"]')?.textContent?.trim()).toBe('page 2');
    });

    it('gives the symbol buttons aria-labels', async () => {
      await render({ columns: ['uid'], page: page({ pageIndex: 1, pageSize: 3, returnCount: 3, total: 9 }) });
      expect(el.querySelector('[data-testid="first"]')?.getAttribute('aria-label')).toBe('First page');
      expect(el.querySelector('[data-testid="prev"]')?.getAttribute('aria-label')).toBe('Previous page');
      expect(el.querySelector('[data-testid="next"]')?.getAttribute('aria-label')).toBe('Next page');
      expect(el.querySelector('[data-testid="last"]')?.getAttribute('aria-label')).toBe('Last page');
    });
  });
});
