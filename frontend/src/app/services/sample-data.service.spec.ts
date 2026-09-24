import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  SampleDataService,
  type SampleFoldersResult,
  type SampleLoadResult,
  type SamplePreviewResult,
} from './sample-data.service';

describe('SampleDataService', () => {
  let service: SampleDataService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SampleDataService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SampleDataService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs the folders endpoint', () => {
    service.listFolders().subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/sample-data/folders'));
    expect(req.request.method).toBe('GET');
    req.flush({ folders: [] });
  });

  it('passes the folder list through in the order the server sent it', () => {
    let result: SampleFoldersResult | undefined;
    service.listFolders().subscribe((r) => (result = r));
    // Deliberately NOT alphabetical: the backend owns the ordering, the client
    // must not silently re-sort it.
    http.expectOne((r) => r.url.includes('/folders')).flush({ folders: ['Test2', 'Test1'] });
    expect(result).toEqual({ ok: true, folders: ['Test2', 'Test1'] });
  });

  it('treats a body with no folders field as "none", not a failure', () => {
    let result: SampleFoldersResult | undefined;
    service.listFolders().subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/folders')).flush({});
    expect(result).toEqual({ ok: true, folders: [] });
  });

  it('treats a non-array folders field as "none" rather than handing it to the template', () => {
    let result: SampleFoldersResult | undefined;
    service.listFolders().subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/folders')).flush({ folders: 'Test1' });
    expect(result).toEqual({ ok: true, folders: [] });
  });

  it('surfaces the server message on a 500', () => {
    let result: SampleFoldersResult | undefined;
    service.listFolders().subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/folders')).flush(
      { error: 'EACCES: permission denied', code: 'INTERNAL' },
      { status: 500, statusText: 'Internal Server Error' },
    );
    expect(result).toEqual({ ok: false, error: 'EACCES: permission denied' });
  });

  it('falls back to a readable message when the error body is not our shape', () => {
    let result: SampleFoldersResult | undefined;
    service.listFolders().subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/folders'))
      .flush('<html>gateway timeout</html>', { status: 504, statusText: 'Gateway Timeout' });
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toContain('504');
  });

  it('never sends an error notification to the subscriber', () => {
    const seen: string[] = [];
    service.listFolders().subscribe({
      next: () => seen.push('next'),
      error: () => seen.push('error'),
      complete: () => seen.push('complete'),
    });
    http.expectOne((r) => r.url.includes('/folders'))
      .flush({ error: 'boom' }, { status: 502, statusText: 'Bad Gateway' });
    expect(seen).toEqual(['next', 'complete']);
  });

  // ---- previewFolder -------------------------------------------------------

  /** Subscribe to a preview and return a getter for its (single) result. */
  function startPreview(folder = 'Test1') {
    let result: SamplePreviewResult | undefined;
    service.previewFolder(folder).subscribe((r) => (result = r));
    return () => result;
  }
  const previewReq = () => http.expectOne((r) => r.url.endsWith('/api/sample-data/tables'));

  it('GETs the table list for one set, naming it as a query parameter', () => {
    startPreview('Test2');
    const req = previewReq();
    // A GET, because it changes nothing: the whole point is to say what a load WOULD do.
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('folder')).toBe('Test2');
    req.flush({ folder: 'Test2', schema: 'SC_Data', tables: [], verified: true });
  });

  it('passes the entries through in the order the server sent them', () => {
    const result = startPreview();
    // The load order, not alphabetical: re-sorting it here would misdescribe the load.
    const tables = [
      { file: 'location.csv', table: 'Location', willLoad: true },
      { file: 'customer.csv', table: 'Customer', willLoad: true },
      { file: 'notes.csv', table: 'notes', willLoad: false },
    ];
    previewReq().flush({ folder: 'Test1', schema: 'SC_Data', tables, verified: true });

    expect(result()).toEqual({
      ok: true,
      preview: { folder: 'Test1', schema: 'SC_Data', tables, verified: true },
    });
  });

  it('treats a body with no `verified` flag as UNVERIFIED', () => {
    // The caveat has to be the default: showing guessed table names as checked ones is
    // the one wrong answer here.
    const result = startPreview();
    previewReq().flush({
      folder: 'Test1',
      schema: 'SC_Data',
      tables: [{ file: 'product.csv', table: 'Product', willLoad: true }],
    });
    const value = result();
    if (!value?.ok) throw new Error('expected the preview to be delivered');
    expect(value.preview.verified).toBe(false);
    expect('reason' in value.preview).toBe(false);
  });

  it('keeps the unverified reason, and survives a body with no tables', () => {
    const result = startPreview();
    previewReq().flush({ verified: false, reason: 'SCO is unreachable at http://localhost:52773.' });
    expect(result()).toEqual({
      ok: true,
      preview: {
        folder: 'Test1',
        schema: '',
        tables: [],
        verified: false,
        reason: 'SCO is unreachable at http://localhost:52773.',
      },
    });
  });

  it('keeps the set\'s own description, line breaks and all', () => {
    const result = startPreview();
    previewReq().flush({
      folder: 'Test1',
      schema: 'SC_Data',
      // Trailing whitespace from the file, and a break the author meant.
      intro: '  Healthcare demo.\nLoads 17 files.  ',
      tables: [{ file: 'product.csv', table: 'Product', willLoad: true }],
      verified: true,
    });
    const value = result();
    if (!value?.ok) throw new Error('expected the preview to be delivered');
    expect(value.preview.intro).toBe('Healthcare demo.\nLoads 17 files.');
  });

  it('carries NO intro rather than an empty one when the set has nothing to say', () => {
    // A blank paragraph above the table list reads as a description that got lost, so
    // a missing, blank, or non-string intro all have to come through as absent.
    for (const intro of [undefined, '', '   \n\t ', 42, { text: 'x' }, null]) {
      const result = startPreview();
      previewReq().flush({ folder: 'Test1', schema: 'SC_Data', intro, tables: [], verified: true });
      const value = result();
      if (!value?.ok) throw new Error('expected the preview to be delivered');
      expect('intro' in value.preview, JSON.stringify(intro)).toBe(false);
    }
  });

  it('reads only an explicit `willLoad: false` as "will be skipped"', () => {
    // An entry that lost the flag is listed as loading — the load itself decides, and
    // omitting a table the load will write to is worse than listing one it may not.
    const result = startPreview();
    previewReq().flush({
      folder: 'Test1',
      schema: 'SC_Data',
      verified: true,
      tables: [
        { file: 'product.csv', table: 'Product' },
        { file: 'notes.csv', table: 'notes', willLoad: false },
      ],
    });
    const value = result();
    if (!value?.ok) throw new Error('expected the preview to be delivered');
    expect(value.preview.tables.map((t) => t.willLoad)).toEqual([true, false]);
  });

  it('prefers the server\'s message, and never errors the subscriber', () => {
    const seen: string[] = [];
    let result: SamplePreviewResult | undefined;
    service.previewFolder('Test1').subscribe({
      next: (r) => {
        result = r;
        seen.push('next');
      },
      error: () => seen.push('error'),
      complete: () => seen.push('complete'),
    });
    previewReq().flush(
      { error: 'Sample data set "Test1" was not found.', code: 'NOT_FOUND' },
      { status: 404, statusText: 'Not Found' },
    );

    expect(seen).toEqual(['next', 'complete']);
    expect(result).toEqual({ ok: false, error: 'Sample data set "Test1" was not found.' });
  });

  it('falls back to a PREVIEW-specific message when the body is not our shape', () => {
    const result = startPreview();
    previewReq().flush('<html>gateway timeout</html>', { status: 504, statusText: 'Gateway Timeout' });
    const value = result();
    expect(value?.ok).toBe(false);
    // Must not read like a failed load: nothing was loaded, and nothing was attempted.
    if (value && !value.ok) {
      expect(value.error).toContain('504');
      expect(value.error).toContain('list the tables');
      expect(value.error).not.toContain('Loading the sample data');
    }
  });

  // ---- loadFolder ----------------------------------------------------------

  /** Subscribe to a load and return a getter for its (single) result. */
  function startLoad(folder = 'Test1') {
    let result: SampleLoadResult | undefined;
    service.loadFolder(folder).subscribe((r) => (result = r));
    return () => result;
  }
  const loadReq = () => http.expectOne((r) => r.url.endsWith('/api/sample-data/load'));

  it('POSTs the folder name in the body', () => {
    startLoad('Test2');
    const req = loadReq();
    expect(req.request.method).toBe('POST');
    // The name goes in the BODY, not the URL — no encoding question, and nothing that
    // reads like a path.
    expect(req.request.body).toEqual({ folder: 'Test2' });
    expect(req.request.url).not.toContain('Test2');
    req.flush({ folder: 'Test2', schema: 'SC_Data', tables: [], totalRows: 0, totalSkippedRows: 0, ok: false });
  });

  it('passes the report through, per table', () => {
    const result = startLoad();
    // All three per-file outcomes at once: loaded, failed, and skipped-because-no-table.
    const tables = [
      { file: 'products.csv', table: 'Product', ok: true, columns: 6, rows: 5, skippedRows: 2 },
      { file: 'suppliers.csv', table: 'Supplier', ok: false, error: 'bad header' },
      { file: 'notes.csv', table: 'notes', ok: true, skipped: true, reason: 'No SC_Data table takes notes.csv, so it was skipped.' },
    ];
    loadReq().flush({ folder: 'Test1', schema: 'SC_Data', tables, totalRows: 5, totalSkippedRows: 2, ok: false });

    expect(result()).toEqual({
      ok: true, // the SERVER answered…
      // …but the load was partial: the union is handed on untouched, skip reason included.
      report: {
        folder: 'Test1',
        schema: 'SC_Data',
        tables,
        totalRows: 5,
        totalSkippedRows: 2,
        totalOrphanRows: 0,
        totalIgnoredHeaders: 0,
        ok: false,
      },
    });
  });

  it('does not call an EMPTY set a success', () => {
    // A set with no CSVs answers 200 with `ok: true`-looking totals; nothing loaded,
    // so the report must not be ok.
    const result = startLoad();
    loadReq().flush({ folder: 'Test1', schema: 'SC_Data', tables: [], totalRows: 0, totalSkippedRows: 0, ok: true });
    const value = result();
    expect(value?.ok).toBe(true);
    if (value?.ok) expect(value.report.ok).toBe(false);
  });

  it('survives a body that lost its tables instead of crashing the page', () => {
    const result = startLoad();
    loadReq().flush({ ok: true }); // an older backend, or a proxy that rewrote it
    const value = result();
    if (value?.ok) {
      expect(value.report).toEqual({
        folder: 'Test1',
        schema: '',
        tables: [],
        totalRows: 0,
        totalSkippedRows: 0,
        totalOrphanRows: 0,
        totalIgnoredHeaders: 0,
        ok: false,
      });
    } else {
      throw new Error('expected the malformed body to be tolerated');
    }
  });

  it('carries the columns that landed nowhere through, per file and in total', () => {
    // The page headlines this, and it is the only sign that a file has a column the
    // installed data model does not — so losing it in normalization would restore the
    // exact silence it exists to break.
    const result = startLoad();
    loadReq().flush({
      folder: 'Test1',
      schema: 'SC_Data',
      tables: [
        {
          file: 'products.csv',
          table: 'Product',
          ok: true,
          columns: 6,
          rows: 5,
          skippedRows: 0,
          orphanRows: 0,
          ignoredHeaders: ['ImageUrl'],
        },
      ],
      totalRows: 5,
      totalSkippedRows: 0,
      totalOrphanRows: 0,
      totalIgnoredHeaders: 1,
      ok: true,
    });

    const value = result();
    if (!value?.ok) throw new Error('expected the report to be delivered');
    expect(value.report.totalIgnoredHeaders).toBe(1);
    const table = value.report.tables[0];
    if (!table.ok || table.skipped) throw new Error('expected a loaded table');
    expect(table.ignoredHeaders).toEqual(['ImageUrl']);
    // A load with a dropped column is still a load: the rows are in.
    expect(value.report.ok).toBe(true);
  });

  it('carries the abort and the orphan counts through, and drops a non-string abort', () => {
    // Both are what the page leads its summary with, so neither may be lost in
    // normalization — and a body where `aborted` came back as something other than a
    // sentence must not render as "true" above the report.
    const result = startLoad();
    loadReq().flush({
      folder: 'Test1',
      schema: 'SC_Data',
      tables: [
        {
          file: 'customers.csv',
          table: 'Customer',
          ok: true,
          columns: 5,
          rows: 0,
          skippedRows: 0,
          orphanRows: 7,
          orphanReason: '7 row(s) name a SC_Data.Location that is not in this namespace',
        },
      ],
      totalRows: 0,
      totalSkippedRows: 0,
      totalOrphanRows: 7,
      aborted: 'Stopped at customers.csv: timed out',
      ok: false,
    });

    const value = result();
    if (!value?.ok) throw new Error('expected the report to be delivered');
    expect(value.report.totalOrphanRows).toBe(7);
    expect(value.report.aborted).toBe('Stopped at customers.csv: timed out');
    const table = value.report.tables[0];
    if (!table.ok || table.skipped) throw new Error('expected a loaded table');
    expect([table.orphanRows, table.orphanReason]).toEqual([
      7,
      '7 row(s) name a SC_Data.Location that is not in this namespace',
    ]);

    const second = startLoad();
    loadReq().flush({ folder: 'Test1', tables: [], totalRows: 0, aborted: true, ok: false });
    const other = second();
    if (other?.ok) expect('aborted' in other.report).toBe(false);
  });

  it('coerces nonsense totals to 0 rather than showing NaN', () => {
    const result = startLoad();
    loadReq().flush({
      folder: 'Test1',
      tables: [{ file: 'products.csv', table: 'Product', ok: true, columns: 1, rows: 1, skippedRows: 0 }],
      totalRows: 'lots',
      totalSkippedRows: null,
      ok: true,
    });
    const value = result();
    // Both totals reach the summary line, so either one arriving as NaN would be
    // rendered to the user.
    if (value?.ok) expect([value.report.totalRows, value.report.totalSkippedRows]).toEqual([0, 0]);
  });

  it('prefers the SERVER\'s message on a failure', () => {
    const result = startLoad();
    loadReq().flush(
      { error: 'Sample data set "Test1" was not found.', code: 'NOT_FOUND' },
      { status: 404, statusText: 'Not Found' },
    );
    expect(result()).toEqual({ ok: false, error: 'Sample data set "Test1" was not found.' });
  });

  it('falls back to a LOAD-specific message when the body is not our shape', () => {
    const result = startLoad();
    loadReq().flush('<html>gateway timeout</html>', { status: 504, statusText: 'Gateway Timeout' });
    const value = result();
    expect(value?.ok).toBe(false);
    // Must not read like the listing's failure — they are different problems.
    if (value && !value.ok) {
      expect(value.error).toContain('504');
      expect(value.error).toContain('Loading the sample data');
    }
  });

  it('never sends an error notification for a failed load either', () => {
    const seen: string[] = [];
    service.loadFolder('Test1').subscribe({
      next: () => seen.push('next'),
      error: () => seen.push('error'),
      complete: () => seen.push('complete'),
    });
    loadReq().flush({ error: 'SCO is unreachable.' }, { status: 502, statusText: 'Bad Gateway' });
    expect(seen).toEqual(['next', 'complete']);
  });

  it('waits for the server instead of giving up on a slow load', () => {
    // The shipped set is ~15,500 rows / ~17 s. Nothing may cut the request short:
    // an abandoned request would leave IRIS still applying the load while the page
    // claims it failed. So: no emission, and no cancellation, until the response.
    const seen: string[] = [];
    service.loadFolder('Test1').subscribe({
      next: () => seen.push('next'),
      complete: () => seen.push('complete'),
    });
    const req = loadReq();
    expect(seen).toEqual([]);
    expect(req.cancelled).toBe(false);

    req.flush({ folder: 'Test1', schema: 'SC_Data', tables: [], totalRows: 0, totalSkippedRows: 0, ok: false });
    expect(seen).toEqual(['next', 'complete']);
  });
});
