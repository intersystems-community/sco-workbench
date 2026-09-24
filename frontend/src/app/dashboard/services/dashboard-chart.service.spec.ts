// frontend/src/app/dashboard/services/dashboard-chart.service.spec.ts
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { DashboardChartService } from './dashboard-chart.service';

describe('DashboardChartService', () => {
  let svc: DashboardChartService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [DashboardChartService, provideHttpClient(), provideHttpClientTesting()] });
    svc = TestBed.inject(DashboardChartService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('getChartableCubes GETs /api/dashboard/chartable-cubes and returns the cube list', () => {
    let result: any;
    svc.getChartableCubes().subscribe((r) => (result = r));
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/chartable-cubes'));
    expect(req.request.method).toBe('GET');
    req.flush({ cubes: [{ cubeName: 'SalesOrderCube', className: 'SC.Cube.SalesOrder', editable: false, measureCount: 4, dimensionCount: 8 }] });
    expect(result.cubes[0].cubeName).toBe('SalesOrderCube');
    expect(result.cubes[0].measureCount).toBe(4);
  });

  it('getCubeShape GETs /api/dashboard/cube-shape/:cube', () => {
    svc.getCubeShape('SalesCube').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/cube-shape/SalesCube'));
    expect(req.request.method).toBe('GET');
    req.flush({ cube: 'SalesCube', measures: [], dimensions: [] });
  });

  it('getCubeMembers GETs /cube-members/:cube/:dimension and forwards the level (B-CUBE-15)', () => {
    svc.getCubeMembers('SalesCube', 'RegionD', '[RegionD].[H1].[Region]').subscribe();
    // The level is built into the URL query string (not an HttpParams option), so match/assert
    // on urlWithParams — robust whether or not Angular splits the embedded query.
    const req = http.expectOne((r) => r.urlWithParams.includes('/api/dashboard/cube-members/SalesCube/RegionD'));
    expect(req.request.method).toBe('GET');
    expect(req.request.urlWithParams).toContain(`level=${encodeURIComponent('[RegionD].[H1].[Region]')}`);
    req.flush({ members: [{ name: 'North' }, { name: 'South' }] });
  });

  it('getCubeMembers omits the level query param when no level is given', () => {
    svc.getCubeMembers('SalesCube', 'RegionD').subscribe();
    const req = http.expectOne((r) => r.urlWithParams.endsWith('/api/dashboard/cube-members/SalesCube/RegionD'));
    expect(req.request.urlWithParams).not.toContain('level=');
    req.flush({ members: [] });
  });

  it('getChartData POSTs the domain terms to /chart-data', () => {
    svc.getChartData({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/chart-data'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body.measures).toEqual(['Revenue']);
    expect(req.request.body.dimensions).toEqual([{ name: 'region', role: 'category' }]);
    req.flush({ categories: [], series: [], meta: { truncated: false, shown: 0, dimensionKind: 'categorical' } });
  });

  it('getChartSpec POSTs chartData to /chart-spec', () => {
    svc.getChartSpec({ chartData: { categories: [], series: [], meta: { truncated: false, shown: 0, dimensionKind: 'categorical' } } }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/chart-spec'));
    expect(req.request.method).toBe('POST');
    req.flush({ spec: {}, type: 'bar', layer: '1b' });
  });

  it('a 422 surfaces the error/code (not collapsed to null)', () => {
    let caught: any;
    svc.getChartData({ source: 'cube', cube: 'C', measures: ['x'] }).subscribe({ error: (e: any) => (caught = e) });
    http.expectOne((r) => r.url.endsWith('/api/dashboard/chart-data')).flush({ error: 'bad', code: 'QUERY_FAILED' }, { status: 422, statusText: 'Unprocessable' });
    expect(caught.error.code).toBe('QUERY_FAILED');
  });

  it('getKpis GETs /api/dashboard/kpis', () => {
    let result: any;
    svc.getKpis().subscribe((r) => (result = r));
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/kpis'));
    expect(req.request.method).toBe('GET');
    req.flush({ kpis: [{ name: 'OnHand', label: 'On-Hand', dimensions: [] }] });
    expect(result.kpis[0].name).toBe('OnHand');
  });

  it('getChartData posts a KPI source body with kpi + expandDimension', () => {
    svc.getChartData({ source: 'kpi', kpi: 'OnHand', expandDimension: 'quantityStatus' }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/chart-data'));
    expect(req.request.body).toEqual({ source: 'kpi', kpi: 'OnHand', expandDimension: 'quantityStatus' });
    req.flush({ categories: ['AboveMaximum'], series: [{ name: 'On-Hand', data: [11] }], meta: { truncated: false, shown: 1, dimensionKind: 'categorical' } });
  });

  it('getLayout GETs /api/dashboard/layout', () => {
    let got: any;
    svc.getLayout().subscribe((r) => (got = r));
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/layout') && r.method === 'GET');
    req.flush({ config: { schemaVersion: 1, tiles: [] } });
    expect(got.config.tiles).toEqual([]);
  });

  it('saveLayout PUTs the config', () => {
    const config = { schemaVersion: 1, tiles: [] };
    let ok: any;
    svc.saveLayout(config as any).subscribe((r) => (ok = r));
    const req = http.expectOne((r) => r.url.endsWith('/api/dashboard/layout') && r.method === 'PUT');
    expect(req.request.body).toEqual({ config });
    req.flush({ ok: true, updatedAt: '2026-08-25T00:00:00Z' });
    expect(ok.ok).toBe(true);
  });
});
