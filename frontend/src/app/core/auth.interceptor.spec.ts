import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { authInterceptor } from './auth.interceptor';
import { setApiToken } from './api';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    ctrl.verify();
    setApiToken('');
  });

  it('adds the bearer header to a backend /api request when a token is set', () => {
    setApiToken('tok');
    http.get('/api/scdata/v1/carriers').subscribe();
    const req = ctrl.expectOne('/api/scdata/v1/carriers');
    expect(req.request.headers.get('Authorization')).toBe('Bearer tok');
    req.flush({});
  });

  it('adds no Authorization header when no token is set', () => {
    setApiToken('');
    http.get('/api/scdata/v1/carriers').subscribe();
    const req = ctrl.expectOne('/api/scdata/v1/carriers');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
  });

  it('does NOT add the bearer to a non-API asset request (audience exclusion)', () => {
    // introduction.ts fetches /use-cases/*.txt via HttpClient; in a split
    // deployment these are served by the frontend web server, not our backend,
    // so the API token must not ride along.
    setApiToken('tok');
    http.get('/use-cases/uc1-overview.txt', { responseType: 'text' }).subscribe();
    const req = ctrl.expectOne('/use-cases/uc1-overview.txt');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush('');
  });
});
