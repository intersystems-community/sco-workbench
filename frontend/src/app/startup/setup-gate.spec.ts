import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SetupGateComponent } from './setup-gate';
import { guidanceFor, ALL_PREFLIGHT_REASONS } from './setup-guidance';
import { scoReadyGuard, setupOnlyWhenBlockedGuard } from './setup.guard';
import {
  setPreflightResult,
  resetPreflightResult,
  scoReady,
  preflightResult,
  runPreflight,
  type PreflightReason,
  type PreflightResult,
} from '../core/preflight';

/**
 * The startup gate. Its job is to be UNBYPASSABLE and INFORMATIVE, and the two
 * failure modes are opposite: a gate that lets a broken install through buries the
 * real cause under a dozen failing panels, and a gate that blocks a healthy install
 * locks the user out entirely. Both directions are pinned here.
 *
 * The fail-closed default gets its own test because it is the one that protects
 * against a bug elsewhere: if the bootstrap initializer is ever removed or throws
 * before storing a verdict, the gate must still be shut.
 */
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

describe('preflight state (fail closed)', () => {
  afterEach(() => resetPreflightResult());

  it('starts SHUT before the check has run', () => {
    resetPreflightResult();
    // The default must not read as "all clear" — a skipped initializer is a bug,
    // and this is what stops that bug becoming an unguarded Workbench.
    expect(scoReady()).toBe(false);
    expect(preflightResult().reason).toBe('preflight-failed');
  });

  it('opens only on an explicit ok:true', () => {
    setPreflightResult(verdict({ ok: true, reason: undefined, version: '1.7.3' }));
    expect(scoReady()).toBe(true);
    setPreflightResult(verdict({ ok: false, reason: 'version-too-old' }));
    expect(scoReady()).toBe(false);
  });

  it('keeps the gate shut when the backend body is unreadable', async () => {
    // A 200 with a body that is not a verdict must not be trusted.
    const fetchMock = vi.fn(async () => new Response('not json at all', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await runPreflight();
    expect(res.ok).toBe(false);
    expect(scoReady()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('keeps the gate shut when the preflight request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const res = await runPreflight();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('preflight-failed');
    expect(res.detail).toContain('Failed to fetch');
    vi.unstubAllGlobals();
  });

  it('accepts a well-formed ok verdict from the backend', async () => {
    const body = verdict({ ok: true, reason: undefined, version: '1.7.3' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = await runPreflight();
    expect(res.ok).toBe(true);
    expect(res.version).toBe('1.7.3');
    vi.unstubAllGlobals();
  });
});

describe('setup guards', () => {
  afterEach(() => { resetPreflightResult(); TestBed.resetTestingModule(); });

  /**
   * A guard calls `inject(Router)`, so it must RUN inside the injection context —
   * returning a closure to call later throws NG0203.
   */
  function guards() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const run = (g: typeof scoReadyGuard) =>
      TestBed.runInInjectionContext(() => g({} as never, {} as never));
    return {
      workbench: () => run(scoReadyGuard),
      setup: () => run(setupOnlyWhenBlockedGuard),
    };
  }

  it('redirects the Workbench route to /setup when SCO is not confirmed', () => {
    setPreflightResult(verdict());
    const g = guards();
    expect(String(g.workbench())).toBe('/setup');
  });

  it('allows the Workbench route once SCO is confirmed', () => {
    setPreflightResult(verdict({ ok: true, reason: undefined }));
    const g = guards();
    expect(g.workbench()).toBe(true);
  });

  it('blocks the Workbench even before the check has run (fail closed)', () => {
    resetPreflightResult();
    const g = guards();
    expect(String(g.workbench())).toBe('/setup');
  });

  it('sends /setup back to the Workbench on a healthy install, so nobody is stranded', () => {
    setPreflightResult(verdict({ ok: true, reason: undefined }));
    const g = guards();
    expect(String(g.setup())).toBe('/workbench');
  });

  it('keeps /setup available while blocked', () => {
    setPreflightResult(verdict({ reason: 'unauthenticated' }));
    const g = guards();
    expect(g.setup()).toBe(true);
  });
});

describe('setup guidance', () => {
  it('has distinct, non-empty guidance for EVERY reason the backend can send', () => {
    // A new backend reason must not fall through to an empty screen. Titles must
    // also differ, or two different problems would read identically.
    const titles = new Set<string>();
    for (const reason of ALL_PREFLIGHT_REASONS) {
      const g = guidanceFor(verdict({ reason }));
      expect(g.title.length, `${reason} needs a title`).toBeGreaterThan(0);
      expect(g.explanation.length, `${reason} needs an explanation`).toBeGreaterThan(0);
      expect(g.steps.length, `${reason} needs at least two steps`).toBeGreaterThanOrEqual(2);
      titles.add(g.title);
    }
    expect(titles.size).toBe(ALL_PREFLIGHT_REASONS.length);
  });

  it('names the failed prerequisite so the user is oriented before reading prose', () => {
    expect(guidanceFor(verdict({ reason: 'unreachable' })).prerequisite).toBe('Connection');
    expect(guidanceFor(verdict({ reason: 'unauthenticated' })).prerequisite).toBe('Authentication');
    expect(guidanceFor(verdict({ reason: 'version-too-old' })).prerequisite).toBe('Version');
    expect(guidanceFor(verdict({ reason: 'preflight-failed' })).prerequisite).toBe('Workbench server');
  });

  it('interpolates the ACTUAL configured values, not generic placeholders', () => {
    const authed = guidanceFor(verdict({ reason: 'unauthenticated', user: 'scoadmin' }));
    expect(`${authed.explanation} ${authed.steps.join(' ')}`).toContain('scoadmin');

    const ns = guidanceFor(verdict({ reason: 'api-not-found', namespace: 'SCPROD' }));
    expect(ns.steps.join(' ')).toContain('SCPROD');

    const old = guidanceFor(verdict({ reason: 'version-too-old', version: '1.6.2', minimumVersion: '1.7.3' }));
    expect(old.explanation).toContain('1.6.2');
    expect(old.explanation).toContain('1.7.3');
  });

  it('falls back to the Workbench-server guidance for an unknown reason', () => {
    const g = guidanceFor(verdict({ reason: 'something-new' as PreflightReason }));
    expect(g.prerequisite).toBe('Workbench server');
    expect(g.steps.length).toBeGreaterThan(0);
  });
});

describe('SetupGateComponent', () => {
  afterEach(() => { resetPreflightResult(); TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

  function mount(over: Partial<PreflightResult> = {}): { fixture: ComponentFixture<SetupGateComponent>; el: HTMLElement } {
    setPreflightResult(verdict(over));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [SetupGateComponent], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(SetupGateComponent);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const text = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

  it('renders the title, explanation and steps for the reason', () => {
    const { el } = mount({ reason: 'unauthenticated' });
    expect(text(el, 'gate-title')).toContain('rejected the credentials');
    expect(text(el, 'gate-prerequisite')).toContain('Authentication');
    expect(el.querySelectorAll('[data-testid="gate-steps"] li').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the endpoint and configured values as technical detail, never a password', () => {
    const { el } = mount({ reason: 'unreachable', detail: 'fetch failed' });
    const detail = text(el, 'gate-detail');
    expect(detail).toContain('http://localhost:52773/api/SC/scdata/v1/backend-version');
    expect(detail).toContain('superuser');
    expect(detail).toContain('fetch failed');
    // The verdict carries no password field at all, so none can leak here.
    expect(detail.toLowerCase()).not.toContain('password');
  });

  /**
   * The checklist does the first half of the diagnosis: a version failure PROVES the
   * connection and credentials are fine, so showing those as passed narrows the
   * search without the user reading a word.
   */
  it('marks earlier prerequisites as passed when a later one is what failed', () => {
    const { el } = mount({ reason: 'version-too-old', version: '1.6.0' });
    const rows = Array.from(el.querySelectorAll('[data-testid="gate-checks"] .gate-check'));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.className).toContain('gate-check--pass'); // instance up
    expect(rows[1]!.className).toContain('gate-check--pass'); // credentials ok
    expect(rows[2]!.className).toContain('gate-check--fail'); // version too old
  });

  it('marks the connection failed and the rest unproven when nothing answered', () => {
    const { el } = mount({ reason: 'unreachable' });
    const rows = Array.from(el.querySelectorAll('[data-testid="gate-checks"] .gate-check'));
    expect(rows[0]!.className).toContain('gate-check--fail');
    // We learned nothing about credentials or version — claiming either would mislead.
    expect(rows[1]!.className).toContain('gate-check--unknown');
    expect(rows[2]!.className).toContain('gate-check--unknown');
  });

  it('marks credentials failed but the connection passed on a 401', () => {
    const { el } = mount({ reason: 'unauthenticated' });
    const rows = Array.from(el.querySelectorAll('[data-testid="gate-checks"] .gate-check'));
    expect(rows[0]!.className).toContain('gate-check--pass');
    expect(rows[1]!.className).toContain('gate-check--fail');
  });

  it('re-checks on Retry and navigates into the Workbench once it passes', async () => {
    const { fixture, el } = mount({ reason: 'unreachable' });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const body = verdict({ ok: true, reason: undefined, version: '1.7.3' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));

    el.querySelector<HTMLButtonElement>('[data-testid="gate-retry"]')!.click();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith(['/workbench']);
  });

  it('stays on the gate and shows the NEW reason when Retry still fails', async () => {
    const { fixture, el } = mount({ reason: 'unreachable' });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    // The user started SCO, so it is reachable now — but the password is still wrong.
    const body = verdict({ reason: 'unauthenticated' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));

    el.querySelector<HTMLButtonElement>('[data-testid="gate-retry"]')!.click();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
    // The screen must move on to the new problem, not keep showing the old one.
    expect(text(el, 'gate-title')).toContain('rejected the credentials');
  });
});
