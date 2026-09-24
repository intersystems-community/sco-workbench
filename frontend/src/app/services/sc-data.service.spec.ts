import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ScDataService, type ScDataPage } from './sc-data.service';

describe('ScDataService.getPage', () => {
  let service: ScDataService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ScDataService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const headers = {
    ORDERBY: 'name ASC', PAGEINDEX: '0', PAGESIZE: '2', RETURNCOUNT: '2', WHERECLAUSE: '',
  };

  it('sends exact camelCase params, because %request.Data is case-sensitive', () => {
    service.getPage('carriers', { pageSize: 2, pageIndex: 0 }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/scdata/v1/carriers'));
    expect(req.request.params.get('pageSize')).toBe('2');
    expect(req.request.params.get('pageIndex')).toBe('0');
    req.flush([], { headers });
  });

  it('never sends the _size param that the removed getCount() relied on', () => {
    service.getPage('carriers', { pageSize: 2, pageIndex: 0 }).subscribe();
    const req = http.expectOne((r) => r.url.includes('/carriers'));
    expect(req.request.params.get('_size')).toBeNull();
    expect(req.request.params.get('pagesize')).toBeNull();
    req.flush([], { headers });
  });

  it('omits sortBy entirely when unsorted', () => {
    service.getPage('carriers', { pageSize: 2, pageIndex: 0, sortBy: null }).subscribe();
    const req = http.expectOne((r) => r.url.includes('/carriers'));
    expect(req.request.params.has('sortBy')).toBe(false);
    req.flush([], { headers });
  });

  it('passes sortBy through verbatim, hyphen prefix included', () => {
    service.getPage('carriers', { pageSize: 2, pageIndex: 0, sortBy: '-name' }).subscribe();
    const req = http.expectOne((r) => r.url.includes('/carriers'));
    expect(req.request.params.get('sortBy')).toBe('-name');
    req.flush([], { headers });
  });

  it('decodes rows and the four headers we use', () => {
    let page: ScDataPage | undefined;
    service.getPage('carriers', { pageSize: 2, pageIndex: 0 }).subscribe((p) => (page = p));
    http.expectOne((r) => r.url.includes('/carriers')).flush(
      [{ uid: 'C1', name: 'Acme' }, { uid: 'C2', name: 'Byrd' }],
      { headers: { ...headers, ORDERBY: 'name ASC', PAGEINDEX: '0', RETURNCOUNT: '2' } },
    );
    expect(page).toEqual({
      rows: [{ uid: 'C1', name: 'Acme' }, { uid: 'C2', name: 'Byrd' }],
      pageIndex: 0, pageSize: 2, returnCount: 2, orderBy: 'name ASC',
    });
  });

  it('reads headers case-insensitively, as HttpHeaders does', () => {
    let page: ScDataPage | undefined;
    service.getPage('carriers', { pageSize: 3, pageIndex: 1 }).subscribe((p) => (page = p));
    http.expectOne((r) => r.url.includes('/carriers')).flush([], {
      headers: { returncount: '0', pageindex: '1', pagesize: '3', orderby: 'name ASC' },
    });
    expect(page).toMatchObject({ returnCount: 0, pageIndex: 1, pageSize: 3 });
  });

  it('falls back to the requested values and the row count when headers are absent', () => {
    let page: ScDataPage | undefined;
    service.getPage('carriers', { pageSize: 50, pageIndex: 2 }).subscribe((p) => (page = p));
    http.expectOne((r) => r.url.includes('/carriers')).flush([{ uid: 'C1' }]);
    expect(page).toEqual({
      rows: [{ uid: 'C1' }], pageIndex: 2, pageSize: 50, returnCount: 1, orderBy: '',
    });
  });

  it('treats a null body as no rows', () => {
    let page: ScDataPage | undefined;
    service.getPage('carriers', { pageSize: 50, pageIndex: 0 }).subscribe((p) => (page = p));
    http.expectOne((r) => r.url.includes('/carriers')).flush(null, { headers });
    expect(page?.rows).toEqual([]);
  });
});
