import { TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { routes } from '../app.routes';
import { SetupGateComponent } from './setup-gate';
import { WorkbenchComponent } from '../workbench/workbench';
import { setPreflightResult, resetPreflightResult, type PreflightResult } from '../core/preflight';

/**
 * The gate through the REAL router and the REAL route table.
 *
 * The component and guard specs test the pieces; this tests the thing that actually
 * protects the user: that no URL reaches the Workbench while a prerequisite is
 * unmet. It navigates the app's own `routes` rather than a hand-built table, so a
 * future route added without `scoReadyGuard` — the easy mistake — fails here.
 */
@Component({ selector: 'app-host', standalone: true, imports: [RouterOutlet], template: '<router-outlet />' })
class HostComponent {}

function verdict(over: Partial<PreflightResult> = {}): PreflightResult {
  return {
    ok: false,
    reason: 'unreachable',
    minimumVersion: '1.7.3',
    endpoint: 'http://localhost:52773/api/SC/scdata/v1/backend-version',
    namespace: 'SC',
    user: 'superuser',
    ...over,
  };
}

function setup(result: PreflightResult) {
  setPreflightResult(result);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
  });
  return { router: TestBed.inject(Router) };
}

describe('startup routing — the Workbench is unreachable until SCO is confirmed', () => {
  afterEach(() => { resetPreflightResult(); TestBed.resetTestingModule(); });

  /** Every entry point a user can actually hit. */
  const entryPoints = ['/workbench', '/', '/dashboard', '/anything-else'];

  for (const path of entryPoints) {
    it(`sends ${path} to /setup while blocked`, async () => {
      const { router } = setup(verdict());
      await router.navigateByUrl(path);
      expect(router.url).toBe('/setup');
    });
  }

  for (const path of entryPoints) {
    it(`lets ${path} through to the Workbench once confirmed`, async () => {
      const { router } = setup(verdict({ ok: true, reason: undefined, version: '1.7.3' }));
      await router.navigateByUrl(path);
      expect(router.url).toBe('/workbench');
    });
  }

  it('blocks when the verdict has not been established at all (fail closed)', async () => {
    resetPreflightResult();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/workbench');
    expect(router.url).toBe('/setup');
  });

  it('resolves /setup to the gate component, and /workbench to the Workbench', async () => {
    // Guards decide the URL; this pins that each URL renders the intended component,
    // so a reshuffle of the route table cannot silently swap them.
    const blocked = setup(verdict());
    await blocked.router.navigateByUrl('/workbench');
    expect(blocked.router.routerState.snapshot.root.firstChild?.component).toBe(SetupGateComponent);

    const okd = setup(verdict({ ok: true, reason: undefined }));
    await okd.router.navigateByUrl('/setup');
    expect(okd.router.routerState.snapshot.root.firstChild?.component).toBe(WorkbenchComponent);
  });

  it('keeps every Workbench-bearing route behind the guard', () => {
    // The structural guarantee, independent of navigation: if a route renders the
    // Workbench, it must carry scoReadyGuard.
    for (const route of routes) {
      if (route.component === WorkbenchComponent) {
        expect(route.canActivate?.length, `route '${route.path}' must be guarded`).toBeGreaterThan(0);
      }
    }
  });
});
