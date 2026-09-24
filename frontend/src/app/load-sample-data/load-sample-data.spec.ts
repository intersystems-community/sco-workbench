// frontend/src/app/load-sample-data/load-sample-data.spec.ts
//
// The "Load sample data" page: a dropdown of the server's sample-data folder
// names, and the Load that ingests one set into IRIS. The interesting cases are the
// ones that are NOT a happy path — no sets at all, a failed listing, a set that
// disappears between two loads, a load where SOME files fail, a second click while
// one is already running — because each of those otherwise renders as the same
// silent empty dropdown or the same misleading "done".
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LoadSampleDataComponent } from './load-sample-data';

describe('LoadSampleDataComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LoadSampleDataComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // verify() in a try/finally: it THROWS on an unexpected request (an extra POST
    // from a click that should have been blocked), and without the finally that throw
    // would skip the reset and fail every later test as collateral.
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function mount() {
    const fixture = TestBed.createComponent(LoadSampleDataComponent);
    fixture.detectChanges(); // ngOnInit fires the listing request
    return { fixture, el: fixture.nativeElement as HTMLElement, component: fixture.componentInstance };
  }

  /** Answer the pending /folders request and re-render. */
  function respond(
    fixture: ReturnType<typeof mount>['fixture'],
    body: Record<string, unknown>,
    opts?: { status: number; statusText: string },
  ) {
    http.expectOne((r) => r.url.endsWith('/api/sample-data/folders')).flush(body, opts);
    fixture.detectChanges();
  }

  function select(el: HTMLElement): HTMLSelectElement | null {
    return el.querySelector('[data-testid="sample-data-select"]');
  }
  function loadButton(el: HTMLElement): HTMLButtonElement | null {
    return el.querySelector('[data-testid="sample-data-load"]');
  }
  /** The pending GET of a set's table list, so a test can assert or answer it itself. */
  function pendingPreview() {
    return http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/sample-data/tables'));
  }
  /** A server preview of one set: which table each of its CSVs would go into. */
  function preview(
    folder: string,
    tables: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) {
    return { folder, schema: 'SC_Data', tables, verified: true, ...extra };
  }
  /** One CSV whose table this namespace has. */
  const willLoad = (file: string, table = file.replace(/\.csv$/, '')) => ({
    file,
    table,
    willLoad: true,
  });
  /**
   * Pick a folder through the real control, the way the user does — which also asks the
   * server which tables that set would populate. That request is ANSWERED here (with
   * `body`/`opts` when a test cares what it says), because `http.verify()` counts an
   * unanswered one as a failure and every test that picks a set makes it.
   */
  function pick(
    fixture: ReturnType<typeof mount>['fixture'],
    el: HTMLElement,
    folder: string,
    body: Record<string, unknown> = preview(folder, [willLoad('products.csv', 'Product')]),
    opts?: { status: number; statusText: string },
  ) {
    const sel = select(el)!;
    sel.value = folder;
    sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    pendingPreview().flush(body, opts);
    fixture.detectChanges();
  }
  function optionLabels(el: HTMLElement): string[] {
    return Array.from(select(el)?.options ?? []).map((o) => o.textContent?.trim() ?? '');
  }
  /** The pending POST /load, so its body can be asserted before it is answered. */
  function pendingLoad() {
    return http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/sample-data/load'));
  }
  /** Answer the pending load and re-render. */
  function respondLoad(
    fixture: ReturnType<typeof mount>['fixture'],
    body: Record<string, unknown>,
    opts?: { status: number; statusText: string },
  ) {
    pendingLoad().flush(body, opts);
    fixture.detectChanges();
  }
  function reportRows(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll('[data-testid="sample-data-report-row"]'));
  }
  function text(el: HTMLElement, testid: string): string | null {
    return el.querySelector(`[data-testid="${testid}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  }
  /**
   * A server report for `folder`, one entry per CSV, with the totals it implies.
   * `extra` carries the report-level fields a test is about (`aborted`), and overrides
   * the derived `ok` when it names it.
   */
  function report(folder: string, tables: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
    const sum = (key: string) =>
      tables.reduce((total, t) => total + (typeof t[key] === 'number' ? (t[key] as number) : 0), 0);
    return {
      folder,
      schema: 'SC_Data',
      tables,
      totalRows: sum('rows'),
      totalSkippedRows: sum('skippedRows'),
      totalOrphanRows: sum('orphanRows'),
      totalIgnoredHeaders: tables.reduce(
        (total, t) => total + (Array.isArray(t['ignoredHeaders']) ? t['ignoredHeaders'].length : 0),
        0,
      ),
      ok: tables.length > 0 && tables.every((t) => t['ok'] === true),
      ...extra,
    };
  }
  /** One CSV whose rows landed in its SC_Data table. */
  const loaded = (file: string, rows: number, extra: Record<string, unknown> = {}) => ({
    file,
    table: file.replace(/\.csv$/, ''),
    ok: true,
    columns: 4,
    rows,
    skippedRows: 0,
    ...extra,
  });
  /** One CSV nothing in SC_Data takes: reported, not loaded, and not a failure. */
  const skipped = (file: string, reason: string) => ({
    file,
    table: file.replace(/\.csv$/, ''),
    ok: true,
    skipped: true,
    reason,
  });

  it('shows a loading line first — no empty dropdown before the answer arrives', () => {
    const { el, fixture } = mount();

    expect(el.querySelector('[data-testid="sample-data-loading"]')).not.toBeNull();
    expect(select(el)).toBeNull();

    respond(fixture, { folders: ['Test1'] });
    expect(el.querySelector('[data-testid="sample-data-loading"]')).toBeNull();
  });

  it('lists every folder name from the server as an option, in the order received', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });

    // The placeholder first, then one option per folder.
    expect(optionLabels(el)).toEqual(['Select a sample data set…', 'Test1', 'Test2']);
    expect(Array.from(select(el)!.options).map((o) => o.value)).toEqual(['', 'Test1', 'Test2']);
    expect(select(el)!.disabled).toBe(false);
  });

  it('records the pick when the user chooses a set', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });

    pick(fixture, el, 'Test2');

    expect(component.selected()).toBe('Test2');
    expect(select(el)!.value).toBe('Test2');
  });

  it('starts with NOTHING chosen — the placeholder, not the first folder', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });

    expect(component.selected()).toBeNull();
    expect(select(el)!.value).toBe('');
    // The placeholder can't be re-picked as if it were a data set.
    expect(select(el)!.options[0].disabled).toBe(true);
  });

  it('explains an EMPTY server folder instead of showing a blank dropdown', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: [] });

    expect(el.querySelector('[data-testid="sample-data-empty"]')?.textContent).toContain('SampleData');
    expect(optionLabels(el)).toEqual(['No sample data sets available']);
    // Nothing to choose, so the control is disabled rather than invitingly empty.
    expect(select(el)!.disabled).toBe(true);
    expect(el.querySelector('[data-testid="sample-data-error"]')).toBeNull();
  });

  it('shows the failure (with a retry) rather than pretending there are no data sets', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { error: 'EACCES: permission denied' }, { status: 500, statusText: 'Internal Server Error' });

    expect(el.querySelector('[data-testid="sample-data-error"]')?.textContent).toContain('EACCES');
    // The distinction that matters: a failure is NOT the empty state, and offers no
    // dropdown at all.
    expect(el.querySelector('[data-testid="sample-data-empty"]')).toBeNull();
    expect(select(el)).toBeNull();
    expect(component.folders()).toEqual([]);
  });

  it('retries on demand and recovers, clearing the error', () => {
    const { el, fixture } = mount();
    respond(fixture, { error: 'boom' }, { status: 502, statusText: 'Bad Gateway' });

    (el.querySelector('[data-testid="sample-data-retry"]') as HTMLElement).click();
    fixture.detectChanges();
    respond(fixture, { folders: ['Test1'] });

    expect(el.querySelector('[data-testid="sample-data-error"]')).toBeNull();
    expect(optionLabels(el)).toEqual(['Select a sample data set…', 'Test1']);
  });

  it('drops a selection whose folder is gone after a reload', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test2');
    expect(component.selected()).toBe('Test2');

    // Someone deleted Test2 on the server between loads.
    component.reload();
    fixture.detectChanges();
    respond(fixture, { folders: ['Test1'] });

    expect(component.selected()).toBeNull();
    expect(select(el)!.value).toBe('');
    expect(optionLabels(el)).toEqual(['Select a sample data set…', 'Test1']);
  });

  it('keeps a selection that survives a reload', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test1');

    component.reload();
    fixture.detectChanges();
    respond(fixture, { folders: ['Test1', 'Test2'] });

    expect(component.selected()).toBe('Test1');
    expect(select(el)!.value).toBe('Test1');
  });

  it('forgets a selection when a later load FAILS (it can no longer be trusted)', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');

    component.reload();
    fixture.detectChanges();
    respond(fixture, { error: 'boom' }, { status: 502, statusText: 'Bad Gateway' });

    expect(component.selected()).toBeNull();
  });

  // ---- The Load button ------------------------------------------------------

  it('shows Load DISABLED until a set is selected, then enables it', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });

    const button = loadButton(el)!;
    expect(button.textContent?.trim()).toBe('Load');
    expect(button.disabled).toBe(true);
    // Disabled has to explain itself without a click.
    expect(button.getAttribute('title')).toContain('Select a sample data set');

    pick(fixture, el, 'Test2');

    expect(loadButton(el)!.disabled).toBe(false);
    expect(loadButton(el)!.getAttribute('title')).toContain('Test2');
  });

  it('frames the page as OPTIONAL, beside bringing your own data in', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });

    // The first thing to settle is whether this page has to be used at all: a user with
    // their own data in IRIS should read that they can skip it, and where the other
    // route lives — not be left assuming sample data is a required first step.
    const intro = text(el, 'sample-data-intro');
    expect(intro).toContain('optional');
    expect(intro).toContain('Data Integration');
    expect(intro).toContain('skip it');
  });

  it('promises up front, without jargon, that loading cannot harm data you already have', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });

    // What Load does to data the user already has must be readable BEFORE the click, not
    // only in the result — and it has to be readable by someone who has never heard of a
    // CSV column or an SC_Data table (the old wording said all of that, and said the
    // opposite too: "dropped and recreated").
    const note = text(el, 'sample-data-note');
    expect(note).toContain('added alongside');
    expect(note).toContain('nothing of yours is changed, emptied or overwritten');
    // Pressing Load twice is safe, and the page must say so rather than imply doubling.
    expect(note).toContain('does not duplicate it');
    // Part of a set can fail to fit — the outcome that otherwise reads as an
    // unexplained short load — and the report afterwards is where that is spelled out.
    expect(note).toContain('left out');
    expect(note).toContain('what went in and what did not');
    for (const jargon of ['SC_Data', 'UID', 'CSV', 'column', 'namespace', 'dropped', 'SQLUser']) {
      expect(note).not.toContain(jargon);
    }
  });

  it('posts the SELECTED set to the load endpoint on a click', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test2');

    loadButton(el)!.click();
    fixture.detectChanges();

    // The body carries the folder name — the server resolves it, the client never
    // sends a path.
    const posted = pendingLoad();
    expect(posted.request.body).toEqual({ folder: 'Test2' });
    posted.flush(report('Test2', [loaded('products.csv', 12)]));
    fixture.detectChanges();
  });

  it('stays busy for the whole round-trip and refuses a second click', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();

    // Mid-flight: the label reports progress, and both controls are inert so the
    // ~17 s load cannot be restarted or re-pointed underneath itself.
    expect(loadButton(el)!.textContent?.trim()).toBe('Loading…');
    expect(loadButton(el)!.disabled).toBe(true);
    expect(select(el)!.disabled).toBe(true);
    expect(text(el, 'sample-data-load-progress')).toContain('Test1');

    loadButton(el)!.click(); // ignored: disabled, and load() re-checks busy()
    fixture.detectChanges();

    // expectOne would fail outright if the click had queued a second POST.
    respondLoad(fixture, report('Test1', [loaded('products.csv', 12)]));

    expect(loadButton(el)!.textContent?.trim()).toBe('Load');
    expect(loadButton(el)!.disabled).toBe(false);
    expect(el.querySelector('[data-testid="sample-data-load-progress"]')).toBeNull();
  });

  it('reports the per-table outcome, including the rows that were already there', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        loaded('products.csv', 1445, { columns: 9 }),
        loaded('locations.csv', 1, { skippedRows: 3 }),
      ]),
    );

    expect(text(el, 'sample-data-summary')).toBe(
      'Added 1,446 rows to 2 tables in the SC_Data schema. Skipped 3 rows that were already there.',
    );
    const rows = reportRows(el);
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('products');
    expect(rows[0].textContent).toContain('1,445 rows added, 9 columns');
    // Singular row, and the rows this file brought that the table already had.
    expect(rows[1].textContent).toContain('1 row added, 4 columns — 3 rows already there');
    expect(rows[1].classList).not.toContain('sd-table-bad');
    expect(rows[1].classList).not.toContain('sd-table-skipped');
    expect(el.querySelector('[data-testid="sample-data-load-error"]')).toBeNull();
  });

  it('says NOTHING NEW when a second load finds every row already there', () => {
    // The normal result of pressing Load twice — the user's rule is "if a UID exists
    // ignore that row". "Added 0 rows to 7 tables" would read like a failure.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        loaded('products.csv', 0, { skippedRows: 1445 }),
        loaded('locations.csv', 0, { skippedRows: 4 }),
      ]),
    );

    expect(text(el, 'sample-data-summary')).toBe(
      'Nothing new to add: all 1,449 rows in this set are already in the SC_Data tables.',
    );
    // Skipping known rows is a success: nothing here is red.
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).not.toContain('sd-summary-bad');
    expect(reportRows(el)[0].textContent).toContain('0 rows added, 4 columns — 1,445 rows already there');
  });

  it('reports a CSV no SC_Data table takes as SKIPPED, not as a failure', () => {
    // The user's rule: "if it does not exist then skip that csv and report it". A skip
    // must not be styled or counted like the malformed-file case.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        loaded('products.csv', 2),
        skipped('notes.csv', 'No SC_Data table takes notes.csv, so it was skipped.'),
      ]),
    );

    expect(text(el, 'sample-data-summary')).toBe(
      'Added 2 rows to 1 table in the SC_Data schema. 1 file was skipped.',
    );
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).not.toContain('sd-summary-bad');
    const row = reportRows(el)[1];
    // The reason, verbatim from the server — and no invented row count.
    expect(row.textContent).toContain('No SC_Data table takes notes.csv');
    expect(row.textContent).not.toContain('0 rows');
    expect(row.classList).toContain('sd-table-skipped');
    expect(row.classList).not.toContain('sd-table-bad');
  });

  it('leads with the FAILURES when only some files loaded', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        loaded('products.csv', 10),
        { file: 'broken.csv', table: 'broken', ok: false, error: '"broken.csv" data row 3 has 2 field(s) but the header has 4.' },
      ]),
    );

    // A user who reads only the first sentence must not walk away thinking the whole
    // set landed.
    expect(text(el, 'sample-data-summary')).toBe(
      '1 file could not be loaded. Added 10 rows to 1 table in the SC_Data schema.',
    );
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).toContain('sd-summary-bad');
    const bad = reportRows(el)[1];
    expect(bad.classList).toContain('sd-table-bad');
    expect(bad.textContent).toContain('data row 3 has 2 field(s)');
  });

  it('does not claim a table when NOTHING loaded at all', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        { file: 'broken.csv', table: 'Carrier', ok: false, error: 'broken.csv is empty.' },
        skipped('notes.csv', 'No SC_Data table takes notes.csv, so it was skipped.'),
      ]),
    );

    // No "0 rows into 0 tables", and no schema name implying something was written.
    expect(text(el, 'sample-data-summary')).toBe(
      '1 file could not be loaded. No rows were added. 1 file was skipped.',
    );
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).toContain('sd-summary-bad');
  });

  it('reports the rows LEFT OUT for want of the data they point at, and why', () => {
    // The set that produced the bug report: no locations.csv, so every customer names a
    // location this namespace does not have. "1,019 rows added" would be a lie and a
    // bare "0 rows added" would be a mystery.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        loaded('carriers.csv', 3),
        loaded('customers.csv', 0, {
          orphanRows: 1019,
          orphanReason:
            '1,019 row(s) name a SC_Data.Location that is not in this namespace ' +
            '(primaryLocationId "LOC-1"), so primaryLocationIdFK would reject them',
        }),
      ]),
    );

    // Headlined, not buried: the set is missing data, which is a different problem from
    // a file that failed.
    expect(text(el, 'sample-data-summary')).toBe(
      'Added 3 rows to 2 tables in the SC_Data schema. Left out 1,019 rows that reference ' +
        'something this namespace does not have — see the files below.',
    );
    const row = reportRows(el)[1];
    expect(row.textContent).toContain('0 rows added');
    expect(row.textContent).toContain('1,019 rows left out');
    // The server's own reason names the table to load first.
    expect(row.textContent).toContain('SC_Data.Location');
  });

  it('says nothing about orphans when there are none', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test1', [loaded('carriers.csv', 3, { orphanRows: 0 })]));

    expect(text(el, 'sample-data-summary')).toBe('Added 3 rows to 1 table in the SC_Data schema.');
    expect(reportRows(el)[0].textContent).not.toContain('left out');
  });

  it('NAMES the columns that landed nowhere, on a load that otherwise succeeded', () => {
    // The silent failure this exists to end: products.csv really carries an `ImageUrl`
    // SC_Data has no column for. The rows load, that column's values do not, and a green
    // "Added 5 rows" alone would tell the user everything went in.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report('Test1', [
        loaded('products.csv', 5, { table: 'Product', ignoredHeaders: ['ImageUrl'] }),
        loaded('salesOrders.csv', 2, { table: 'SalesOrder', ignoredHeaders: ['Type'] }),
      ]),
    );

    expect(text(el, 'sample-data-summary')).toBe(
      'Added 7 rows to 2 tables in the SC_Data schema. 2 columns in this set are not in ' +
        'the SC_Data tables, so their values were not loaded — see the files below.',
    );
    // Named per file, because the name is what tells you which column to look at.
    expect(reportRows(el)[0].textContent).toContain('1 column Product does not have: ImageUrl');
    expect(reportRows(el)[1].textContent).toContain('1 column SalesOrder does not have: Type');
    // Still a success: the rows are in.
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).not.toContain(
      'sd-summary-bad',
    );
  });

  it('counts the rest rather than printing a whole foreign header row', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    respondLoad(fixture, report('Test1', [loaded('carriers.csv', 1, { ignoredHeaders: many })]));

    expect(reportRows(el)[0].textContent).toContain(
      '8 columns carriers does not have: a, b, c, d, e, f and 2 more',
    );
    expect(text(el, 'sample-data-summary')).toContain('8 columns in this set are not in');
  });

  it('says nothing about columns when every header found one', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test1', [loaded('carriers.csv', 3)]));

    expect(text(el, 'sample-data-summary')).toBe('Added 3 rows to 1 table in the SC_Data schema.');
    expect(reportRows(el)[0].textContent).not.toContain('does not have');
  });

  it('LEADS with where a load stopped, and still shows what landed before it did', () => {
    // A connection failure part way through: the server answers 200 with the partial
    // report rather than throwing away the tables that already have their rows.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      report(
        'Test1',
        [
          loaded('locations.csv', 27),
          { file: 'customers.csv', table: 'Customer', ok: false, error: 'Atelier request: request timed out after 30000ms' },
        ],
        { aborted: 'Stopped at customers.csv: Atelier request: request timed out after 30000ms', ok: false },
      ),
    );

    // The abort comes FIRST: everything after it has to be read as a partial result.
    expect(text(el, 'sample-data-summary')).toBe(
      'Stopped at customers.csv: Atelier request: request timed out after 30000ms. ' +
        '1 file could not be loaded. Added 27 rows to 1 table in the SC_Data schema.',
    );
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).toContain('sd-summary-bad');
    // Not an error page: the report is there, with the rows that did land.
    expect(el.querySelector('[data-testid="sample-data-load-error"]')).toBeNull();
    expect(reportRows(el)[0].textContent).toContain('27 rows added');
    expect(reportRows(el)[1].classList).toContain('sd-table-bad');
  });

  it('shows the SERVER\'s message when the load could not run, and re-enables Load', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      { error: 'SCO is unreachable at http://localhost:52773.', code: 'SCO_UNREACHABLE' },
      { status: 502, statusText: 'Bad Gateway' },
    );

    expect(text(el, 'sample-data-load-error')).toBe('SCO is unreachable at http://localhost:52773.');
    // No half-report to misread, and the user can try again immediately.
    expect(el.querySelector('[data-testid="sample-data-report"]')).toBeNull();
    expect(component.report()).toBeNull();
    expect(loadButton(el)!.disabled).toBe(false);
  });

  it('does not claim success for a set with NO CSV files', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test2');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test2', [])); // an empty folder: 200, but nothing loaded

    expect(text(el, 'sample-data-summary')).toBe('"Test2" has no CSV files, so nothing was loaded.');
    expect(el.querySelector('[data-testid="sample-data-summary"]')!.classList).toContain('sd-summary-bad');
    expect(reportRows(el).length).toBe(0);
  });

  it('survives a body that lost its tables instead of crashing the page', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    // An older backend or a proxy that rewrote the envelope.
    respondLoad(fixture, { ok: true });

    expect(text(el, 'sample-data-summary')).toContain('no CSV files');
    expect(loadButton(el)!.disabled).toBe(false);
  });

  it('requests nothing when Load is invoked with nothing selected', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1'] });

    // The button is disabled, so this is the programmatic route in — the guard inside
    // load() is what is under test. http.verify() in afterEach asserts no POST went out.
    component.load();
    fixture.detectChanges();

    expect(component.busy()).toBe(false);
    expect(el.querySelector('[data-testid="sample-data-load-progress"]')).toBeNull();
    expect(el.querySelector('[data-testid="sample-data-report"]')).toBeNull();
  });

  it('leaves an earlier report ALONE when Load is invoked with nothing selected', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test1', [loaded('products.csv', 10)]));

    // Something else cleared the selection (a guided directive, a future reset).
    // A no-op Load must not erase the report of a load that really happened.
    component.selected.set(null);
    component.load();
    fixture.detectChanges();

    expect(text(el, 'sample-data-summary')).toContain('Added 10 rows');
  });

  it('stays disabled when there are no sets to load at all', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: [] });

    expect(loadButton(el)!.disabled).toBe(true);
  });

  it('offers no Load button while listing or after a listing failure', () => {
    const { el, fixture } = mount();
    expect(loadButton(el)).toBeNull(); // still fetching the list

    respond(fixture, { error: 'boom' }, { status: 502, statusText: 'Bad Gateway' });
    expect(loadButton(el)).toBeNull();
  });

  it('retires a previous report when the user picks a different set', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test1', [loaded('products.csv', 10)]));
    expect(el.querySelector('[data-testid="sample-data-report"]')).not.toBeNull();

    pick(fixture, el, 'Test2');

    // Test1's result sitting under a Test2 selection reads as Test2's.
    expect(el.querySelector('[data-testid="sample-data-report"]')).toBeNull();
    expect(loadButton(el)!.disabled).toBe(false);
  });

  it('retires a load FAILURE when the user picks a different set', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test1');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, { error: 'SCO is unreachable.' }, { status: 502, statusText: 'Bad Gateway' });
    expect(el.querySelector('[data-testid="sample-data-load-error"]')).not.toBeNull();

    pick(fixture, el, 'Test2');

    expect(el.querySelector('[data-testid="sample-data-load-error"]')).toBeNull();
  });

  it('re-disables Load, and drops the report, when the selected set disappears from a reload', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test2');
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test2', [loaded('products.csv', 10)]));

    component.reload();
    fixture.detectChanges();
    respond(fixture, { folders: ['Test1'] }); // Test2 deleted on the server

    expect(loadButton(el)!.disabled).toBe(true);
    // A report for a set that no longer exists must not linger.
    expect(el.querySelector('[data-testid="sample-data-report"]')).toBeNull();
  });

  // ---- The tables a set will populate, listed before any load --------------------

  function previewRows(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll('[data-testid="sample-data-preview-row"]'));
  }
  /**
   * The set's own description, WITHOUT collapsing whitespace the way `text()` does: the
   * line breaks in it are the intro author's, and this feature is partly about keeping them.
   */
  function introText(el: HTMLElement): string | null {
    return el.querySelector('[data-testid="sample-data-preview-intro"]')?.textContent?.trim() ?? null;
  }
  /**
   * Is `first` ABOVE `second` on the page? Document order over the test ids, so it holds
   * whichever container each of them ends up in — which is the point of the assertions
   * that use it: the intro stays above the plan and above the report as those change.
   */
  function before(el: HTMLElement, first: string, second: string): boolean {
    const ids = Array.from(el.querySelectorAll('[data-testid]')).map((n) => n.getAttribute('data-testid'));
    return ids.indexOf(first) >= 0 && ids.indexOf(second) > ids.indexOf(first);
  }
  /** Each listed row as "Table file.csv" (the spans separately — the DOM has no space). */
  function previewList(el: HTMLElement): string[] {
    return previewRows(el).map((row) =>
      [
        row.querySelector('.sd-preview-name')?.textContent?.trim(),
        row.querySelector('.sd-table-file')?.textContent?.trim(),
      ].join(' '),
    );
  }

  it('lists the tables the chosen set will populate, in the order they load', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });

    const sel = select(el)!;
    sel.value = 'Test1';
    sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // Asked for the set that was picked, and by NAME — the client never sends a path.
    const asked = pendingPreview();
    expect(asked.request.params.get('folder')).toBe('Test1');
    asked.flush(
      preview('Test1', [
        willLoad('location.csv', 'Location'),
        willLoad('customer.csv', 'Customer'),
        willLoad('salesOrder.csv', 'SalesOrder'),
      ]),
    );
    fixture.detectChanges();

    expect(text(el, 'sample-data-preview-summary')).toBe(
      'Load will add rows to 3 SC_Data tables, in this order:',
    );
    // The server's order is kept: the tables fill in the order they reference each other,
    // so re-sorting them here (alphabetically, say) would misdescribe the load.
    expect(previewList(el)).toEqual([
      'Location location.csv',
      'Customer customer.csv',
      'SalesOrder salesOrder.csv',
    ]);
    // Nothing has been loaded — this is a plan, not a result.
    expect(el.querySelector('[data-testid="sample-data-report"]')).toBeNull();
  });

  it('shows NO table list until a set is picked', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });

    // http.verify() also asserts that no preview was requested with nothing selected.
    expect(el.querySelector('[data-testid="sample-data-preview"]')).toBeNull();
  });

  it('names the files that will be SKIPPED rather than leaving them off the list', () => {
    // A file no installed table takes is not in the list above, and silently omitting it
    // would read as "this set loads everything".
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(
      fixture,
      el,
      'Test1',
      preview('Test1', [
        willLoad('product.csv', 'Product'),
        { file: 'notes.csv', table: 'notes', willLoad: false },
        { file: 'mfgOrder.csv', table: 'mfgOrder', willLoad: false },
      ]),
    );

    expect(text(el, 'sample-data-preview-summary')).toBe(
      'Load will add rows to 1 SC_Data table, in this order:',
    );
    expect(previewRows(el).length).toBe(1);
    expect(text(el, 'sample-data-preview-skipped')).toBe(
      '2 files in this set are not named after any SC_Data table in this namespace, so they ' +
        'will be skipped: notes.csv, mfgOrder.csv.',
    );
  });

  it('says so when the set would populate NOTHING at all', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [{ file: 'notes.csv', table: 'notes', willLoad: false }]));

    expect(text(el, 'sample-data-preview-summary')).toBe(
      'Nothing in "Test1" matches a table in the SC_Data schema, so a Load would add no rows.',
    );
    expect(previewRows(el).length).toBe(0);
    // Still offered: the user may be about to install SCO, and the server decides.
    expect(loadButton(el)!.disabled).toBe(false);
  });

  it('says the list is UNCHECKED when the server could not read the namespace', () => {
    // IRIS down: the file names still say which tables the set is for, and that is worth
    // showing — but not as if the tables were known to be there.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(
      fixture,
      el,
      'Test1',
      preview('Test1', [willLoad('location.csv', 'location'), willLoad('customer.csv', 'customer')], {
        verified: false,
        reason: 'SCO is unreachable at http://localhost:52773.',
      }),
    );

    expect(text(el, 'sample-data-preview-summary')).toBe(
      '"Test1" has 2 CSV files, for these SC_Data tables. Which of them this namespace has ' +
        'could not be checked:',
    );
    expect(previewRows(el).length).toBe(2);
    // The server's own reason, so the user knows what to fix.
    expect(text(el, 'sample-data-preview-unverified')).toBe(
      'SCO is unreachable at http://localhost:52773.',
    );
  });

  it('treats a body that lost `verified` as unchecked, not as checked', () => {
    // An older backend or a proxy that rewrote the envelope. Presenting guessed names as
    // confirmed ones is the failure to avoid.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', { folder: 'Test1', schema: 'SC_Data', tables: [willLoad('product.csv', 'Product')] });

    expect(text(el, 'sample-data-preview-summary')).toContain('could not be checked');
  });

  it('keeps the Load button working when the table list cannot be fetched', () => {
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', { error: 'Sample data set "Test1" was not found.' }, {
      status: 404,
      statusText: 'Not Found',
    });

    // A note, not an error banner — nothing was attempted and the user can still load.
    expect(text(el, 'sample-data-preview-error')).toBe('Sample data set "Test1" was not found.');
    expect(previewRows(el).length).toBe(0);
    expect(loadButton(el)!.disabled).toBe(false);
    expect(component.preview()).toBeNull();
  });

  it('shows a checking line while the table list is in flight', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    const sel = select(el)!;
    sel.value = 'Test1';
    sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(text(el, 'sample-data-preview-loading')).toContain('Test1');
    expect(previewRows(el).length).toBe(0);

    pendingPreview().flush(preview('Test1', [willLoad('product.csv', 'Product')]));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="sample-data-preview-loading"]')).toBeNull();
  });

  it('shows what the set SAYS ABOUT ITSELF, above the tables', () => {
    // The order is the requirement: what this data IS, then what it would populate.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(
      fixture,
      el,
      'Test1',
      preview('Test1', [willLoad('product.csv', 'Product')], {
        intro: 'Healthcare demo generator output.\nThis will load 17 files.',
      }),
    );

    // Rendered verbatim, the author's line break included (the stylesheet keeps it).
    expect(introText(el)).toBe('Healthcare demo generator output.\nThis will load 17 files.');
    expect(before(el, 'sample-data-preview-intro', 'sample-data-preview')).toBe(true);
    expect(previewList(el)).toEqual(['Product product.csv']);
  });

  it('shows no description paragraph at all for a set without one', () => {
    // An empty paragraph above the list would read as a description that went missing.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));

    expect(el.querySelector('[data-testid="sample-data-preview-intro"]')).toBeNull();
    expect(text(el, 'sample-data-preview-summary')).toContain('Load will add rows to 1');
  });

  it('LABELS the description AND the table list as the set\'s, not the page\'s own copy', () => {
    // Without the label the set's words continue the page's introduction: a set calling
    // itself "development data" would read as the workbench saying that about itself. The
    // tables it would fill are the same kind of fact, so they sit under the one label.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(
      fixture,
      el,
      'Test1',
      preview('Test1', [willLoad('product.csv', 'Product')], { intro: 'Development data set.' }),
    );

    expect(text(el, 'sample-data-about-title')).toBe('About this data set');
    expect(before(el, 'sample-data-about-title', 'sample-data-preview-intro')).toBe(true);
    // Below the picker it labels, not above it — otherwise it titles the choosing.
    expect(before(el, 'sample-data-select', 'sample-data-about-title')).toBe(true);
    // INSIDE the block, not merely under it: the label has to cover the list to title it.
    const about = el.querySelector('.sd-about')!;
    expect(about.querySelector('[data-testid="sample-data-preview-intro"]')).not.toBeNull();
    expect(about.querySelector('[data-testid="sample-data-preview"]')).not.toBeNull();
  });

  it('still labels the tables for a set that says nothing about itself', () => {
    // No description, but the list of tables is still a statement about this set.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));

    expect(text(el, 'sample-data-about-title')).toBe('About this data set');
    expect(before(el, 'sample-data-about-title', 'sample-data-preview-summary')).toBe(true);
  });

  it('keeps the load\'s row counts UNDER the label, and the failure outside it', () => {
    // What went into each table is still a statement about this set — how much of it the
    // instance now holds. A load that never ran is not: it describes the attempt.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test1', [loaded('product.csv', 10, { table: 'Product' })]));

    const about = el.querySelector('.sd-about')!;
    expect(about.querySelector('[data-testid="sample-data-report"]')).not.toBeNull();
    expect(text(el, 'sample-data-about-title')).toBe('About this data set');

    // The failing load's message is a sibling of the block, not a member of it.
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      { error: 'SCO is unreachable at http://localhost:52773.', code: 'SCO_UNREACHABLE' },
      { status: 502, statusText: 'Bad Gateway' },
    );

    expect(text(el, 'sample-data-load-error')).toContain('unreachable');
    expect(
      el.querySelector('.sd-about [data-testid="sample-data-load-error"]'),
    ).toBeNull();
  });

  it('has nothing to label before a set is picked', () => {
    // A heading over empty space reads as a description that failed to load.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });

    expect(el.querySelector('[data-testid="sample-data-about-title"]')).toBeNull();
  });

  it('still describes the set when its tables could NOT be checked', () => {
    // The description comes from the set's own file, so the branch where the table names
    // are guesses is exactly the one where saying what the data is matters most.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(
      fixture,
      el,
      'Test1',
      preview('Test1', [willLoad('product.csv', 'product')], {
        intro: 'Development data set.',
        verified: false,
        reason: 'SCO is unreachable at http://localhost:52773.',
      }),
    );

    expect(introText(el)).toBe('Development data set.');
    expect(text(el, 'sample-data-preview-unverified')).toContain('unreachable');
  });

  it('never leaves one set\'s description under another set\'s selection', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')], {
      intro: 'The first set.',
    }));
    expect(introText(el)).toBe('The first set.');

    // Replaced by the next set's own words…
    pick(fixture, el, 'Test2', preview('Test2', [willLoad('carrier.csv', 'Carrier')], {
      intro: 'The second set.',
    }));
    expect(introText(el)).toBe('The second set.');

    // …and GONE when the set picked after it has nothing to say.
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));
    expect(el.querySelector('[data-testid="sample-data-preview-intro"]')).toBeNull();
  });

  it('replaces the list when a different set is picked', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));
    expect(previewList(el)).toEqual(['Product product.csv']);

    pick(fixture, el, 'Test2', preview('Test2', [willLoad('carrier.csv', 'Carrier')]));

    expect(previewList(el)).toEqual(['Carrier carrier.csv']);
  });

  it('IGNORES the answer for a set the user has already moved on from', () => {
    // Two quick picks: the first answer arrives last. Rendered, it would list Test1's
    // tables under a Test2 selection — the reason the response is matched to the pick.
    const { el, fixture, component } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });

    const sel = select(el)!;
    sel.value = 'Test1';
    sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const first = pendingPreview();

    sel.value = 'Test2';
    sel.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const second = pendingPreview();

    // Out of order: Test2's answer, then the stale Test1 one.
    second.flush(preview('Test2', [willLoad('carrier.csv', 'Carrier')]));
    first.flush(preview('Test1', [willLoad('product.csv', 'Product')]));
    fixture.detectChanges();

    expect(component.preview()?.folder).toBe('Test2');
    expect(previewList(el)).toEqual(['Carrier carrier.csv']);
  });

  it('DROPS the plan once the load has reported — the report replaces it', () => {
    // Two lists of the same tables, one of them describing what was about to happen and
    // now describing the past, is the confusing part: the report is the current answer.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));
    expect(previewRows(el).length).toBe(1);

    loadButton(el)!.click();
    fixture.detectChanges();
    // Still up WHILE the load runs: nothing has happened yet, so it is still the plan.
    expect(previewRows(el).length).toBe(1);

    respondLoad(fixture, report('Test1', [loaded('product.csv', 10, { table: 'Product' })]));

    expect(el.querySelector('[data-testid="sample-data-preview"]')).toBeNull();
    expect(previewRows(el).length).toBe(0);
    expect(reportRows(el).length).toBe(1);
    expect(text(el, 'sample-data-summary')).toContain('Added 10 rows');
  });

  it('keeps the DESCRIPTION at the top through a load, above the report', () => {
    // It describes the set, not the outcome: it belongs above everything Load produces
    // and must not be swept away with the plan.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')], {
      intro: 'This is a dataset for development purpose.',
    }));

    loadButton(el)!.click();
    fixture.detectChanges();
    expect(introText(el)).toBe('This is a dataset for development purpose.');
    expect(before(el, 'sample-data-preview-intro', 'sample-data-load-progress')).toBe(true);

    respondLoad(fixture, report('Test1', [loaded('product.csv', 10, { table: 'Product' })]));

    expect(introText(el)).toBe('This is a dataset for development purpose.');
    expect(before(el, 'sample-data-preview-intro', 'sample-data-report')).toBe(true);
  });

  it('brings the plan BACK when a different set is picked after a load', () => {
    // The report is retired with the selection that produced it, so the next set is
    // described by its plan again rather than by the previous set's result.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1', 'Test2'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')]));
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(fixture, report('Test1', [loaded('product.csv', 10, { table: 'Product' })]));
    expect(el.querySelector('[data-testid="sample-data-preview"]')).toBeNull();

    pick(fixture, el, 'Test2', preview('Test2', [willLoad('carrier.csv', 'Carrier')]));

    expect(previewList(el)).toEqual(['Carrier carrier.csv']);
    expect(el.querySelector('[data-testid="sample-data-report"]')).toBeNull();
  });

  it('leaves the plan up when the load could not run at all', () => {
    // No report means nothing replaced it, and the user is about to try again: taking the
    // list away would leave a bare error with no sign of what was being loaded.
    const { el, fixture } = mount();
    respond(fixture, { folders: ['Test1'] });
    pick(fixture, el, 'Test1', preview('Test1', [willLoad('product.csv', 'Product')], {
      intro: 'Development data.',
    }));
    loadButton(el)!.click();
    fixture.detectChanges();
    respondLoad(
      fixture,
      { error: 'SCO is unreachable at http://localhost:52773.', code: 'SCO_UNREACHABLE' },
      { status: 502, statusText: 'Bad Gateway' },
    );

    expect(text(el, 'sample-data-load-error')).toContain('unreachable');
    expect(previewList(el)).toEqual(['Product product.csv']);
    expect(introText(el)).toBe('Development data.');
  });

  it('renders unusual folder names verbatim (no re-labelling, no HTML injection)', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: ['apple pie', 'Éclair', 'set-2 (copy)', '<b>bold</b>'] });

    expect(optionLabels(el)).toEqual([
      'Select a sample data set…', 'apple pie', 'Éclair', 'set-2 (copy)', '<b>bold</b>',
    ]);
    // The angle brackets are TEXT in the option, not markup.
    expect(select(el)!.querySelector('b')).toBeNull();
  });

  it('renders app-page-header and no bespoke idiom', () => {
    const { el, fixture } = mount();
    respond(fixture, { folders: [] });
    expect(el.querySelector('app-page-header')).not.toBeNull();
    expect(el.querySelector('.sd-eyebrow')).toBeNull();
    expect(el.querySelector('.sd-title')).toBeNull();
  });

  it('uses the shared .page--reading shell', () => {
    const { fixture } = mount();
    expect((fixture.nativeElement as HTMLElement).querySelector('.sd-page.page--reading')).not.toBeNull();
    // Clean up the pending request
    http.expectOne((r) => r.url.endsWith('/api/sample-data/folders')).flush({ folders: [] });
  });
});
