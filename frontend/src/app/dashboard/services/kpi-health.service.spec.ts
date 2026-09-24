import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { KpiHealthService } from './kpi-health.service';

describe('KpiHealthService', () => {
  let svc: KpiHealthService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [KpiHealthService, provideHttpClient(), provideHttpClientTesting()] });
    svc = TestBed.inject(KpiHealthService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('GETs /api/dashboard/kpi-health/:name (name-encoded) and returns the envelope', () => {
    let got: any;
    svc.getKpiHealth('On Hand').subscribe((h) => (got = h));
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/kpi-health/On%20Hand'));
    expect(req.request.method).toBe('GET');
    req.flush({ name: 'On Hand', label: 'On Hand', value: 7, threshold: null, issues: null });
    expect(got.value).toBe(7);
  });

  it('propagates a 404 (missing KPI) rather than collapsing to null', () => {
    let caught: any;
    svc.getKpiHealth('Ghost').subscribe({ error: (e) => (caught = e) });
    http.expectOne((r) => r.url.endsWith('/api/dashboard/kpi-health/Ghost')).flush({ error: 'nope', code: 'NOT_FOUND' }, { status: 404, statusText: 'Not Found' });
    expect(caught.error.code).toBe('NOT_FOUND');
  });

  const envelope = (over: any = {}) => ({ name: 'On Hand', label: 'On Hand', value: 7, threshold: null, issues: null, ...over });
  const url = (n: string) => (r: any) => r.url.endsWith(`/api/dashboard/kpi-health/${n}`);

  it('prefetch issues the GET immediately; getKpiHealthShared replays it with NO second request (single-use)', () => {
    svc.prefetch('On Hand');
    http.expectOne(url('On%20Hand')).flush(envelope({ value: 7 })); // the eager fetch fired on prefetch
    let got: any;
    svc.getKpiHealthShared('On Hand').subscribe((h) => (got = h));  // replayed from the slot
    http.expectNone(url('On%20Hand'));                              // NOT re-fetched
    expect(got.value).toBe(7);
    // single-use: the slot is now empty, so a second shared read for the same name fetches fresh
    svc.getKpiHealthShared('On Hand').subscribe();
    http.expectOne(url('On%20Hand')).flush(envelope({ value: 1 }));
  });

  it('getKpiHealthShared for a name that was NOT prefetched fetches fresh', () => {
    svc.prefetch('On Hand');
    http.expectOne(url('On%20Hand')).flush(envelope());
    let got: any;
    svc.getKpiHealthShared('Fill Rate').subscribe((h) => (got = h)); // no matching slot → fresh GET
    http.expectOne(url('Fill%20Rate')).flush(envelope({ name: 'Fill Rate', value: 5 }));
    expect(got.value).toBe(5);
  });
});
