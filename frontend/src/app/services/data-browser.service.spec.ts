import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DataBrowserService, type CountResult } from './data-browser.service';

describe('DataBrowserService', () => {
  let service: DataBrowserService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [DataBrowserService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DataBrowserService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('builds the count URL from the className, dots intact', () => {
    service.getCount('SC.Data.BOM').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/data-browser/SC.Data.BOM/count'));
    expect(req.request.method).toBe('GET');
    req.flush({ className: 'SC.Data.BOM', sqlTableName: 'SC_Data.BOM', total: 12 });
  });

  it('maps 200 to an ok result carrying the total', () => {
    let result: CountResult | undefined;
    service.getCount('SC.Data.BOM').subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/count'))
      .flush({ className: 'SC.Data.BOM', sqlTableName: 'SC_Data.BOM', total: 12 });
    expect(result).toEqual({
      ok: true, total: 12, className: 'SC.Data.BOM', sqlTableName: 'SC_Data.BOM',
    });
  });

  it('surfaces the 404 message and its candidates instead of collapsing to null', () => {
    let result: CountResult | undefined;
    service.getCount('SC.Data.BOMM').subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/count')).flush(
      { error: 'Class "SC.Data.BOMM" not found.', candidates: ['SC.Data.BOM'] },
      { status: 404, statusText: 'Not Found' },
    );
    expect(result).toEqual({
      ok: false, error: 'Class "SC.Data.BOMM" not found.', candidates: ['SC.Data.BOM'],
    });
  });

  it('surfaces the upstream message on 502', () => {
    let result: CountResult | undefined;
    service.getCount('SC.Data.BOM').subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/count')).flush(
      { error: 'ECONNREFUSED 127.0.0.1:52773' },
      { status: 502, statusText: 'Bad Gateway' },
    );
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED 127.0.0.1:52773', candidates: [] });
  });

  it('falls back to a readable message when the error body is not our shape', () => {
    let result: CountResult | undefined;
    service.getCount('SC.Data.BOM').subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/count'))
      .flush('<html>gateway timeout</html>', { status: 504, statusText: 'Gateway Timeout' });
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('504');
      expect(result.candidates).toEqual([]);
    }
  });

  it('never sends an error notification to the subscriber', () => {
    const seen: string[] = [];
    service.getCount('SC.Data.BOM').subscribe({
      next: () => seen.push('next'),
      error: () => seen.push('error'),
      complete: () => seen.push('complete'),
    });
    http.expectOne((r) => r.url.includes('/count'))
      .flush({ error: 'boom' }, { status: 502, statusText: 'Bad Gateway' });
    expect(seen).toEqual(['next', 'complete']);
  });
});

describe('DataBrowserService.getCounts', () => {
  let service: DataBrowserService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [DataBrowserService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DataBrowserService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('POSTs the classNames and maps the counts, backfilling className from the key', () => {
    let result: Record<string, CountResult> | undefined;
    service.getCounts(['SC.Data.BOM', 'SC.Data.Nope']).subscribe((r) => (result = r));
    const req = http.expectOne((r) => r.url.endsWith('/api/data-browser/counts'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ classNames: ['SC.Data.BOM', 'SC.Data.Nope'] });
    req.flush({
      counts: {
        'SC.Data.BOM': { ok: true, total: 42, sqlTableName: 'SC_Data.BOM' },
        'SC.Data.Nope': { ok: false, error: 'Class "SC.Data.Nope" not found.' },
      },
    });
    expect(result!['SC.Data.BOM']).toEqual({
      ok: true, total: 42, className: 'SC.Data.BOM', sqlTableName: 'SC_Data.BOM',
    });
    expect(result!['SC.Data.Nope']).toEqual({
      ok: false, error: 'Class "SC.Data.Nope" not found.', candidates: [],
    });
  });

  it('resolves to an empty map on a transport error (never throws)', () => {
    let result: Record<string, CountResult> | undefined;
    const seen: string[] = [];
    service.getCounts(['SC.Data.BOM']).subscribe({
      next: (r) => { result = r; seen.push('next'); },
      error: () => seen.push('error'),
      complete: () => seen.push('complete'),
    });
    http.expectOne((r) => r.url.endsWith('/counts'))
      .flush({ error: 'boom' }, { status: 502, statusText: 'Bad Gateway' });
    expect(result).toEqual({});
    expect(seen).toEqual(['next', 'complete']);
  });
});
