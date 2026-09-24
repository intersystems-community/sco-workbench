// frontend/src/app/workbench/deep-link.spec.ts
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { WorkbenchComponent } from './workbench';
import {
  WorkbenchBridgeService,
  type FeatureKey,
  type GuidedFormController,
} from '../core/workbench-bridge.service';

/**
 * Refresh must come back to the ITEM the user had open, not the page's overview
 * (the reported bug: reload on a KPI/cube/pipeline detail dumped you on the intro).
 *
 * The shell mirrors the open item into `?item=` by READING it off the mounted
 * feature after every render — no feature pushes it — so these tests drive a fake
 * controller and assert on what the shell writes to the URL and asks to restore.
 */
describe('WorkbenchComponent — `?item=` deep link', () => {
  // The shell mounts the assistant dock, which lists sessions over raw fetch; an
  // unstubbed call is an unhandled rejection in jsdom.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) } as unknown as Response)) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    TestBed.resetTestingModule();
  });

  /** Mount the shell with the given query params, as a page load would supply them. */
  function mount(params: Record<string, string> = {}) {
    const navigate = vi.fn();
    TestBed.configureTestingModule({
      imports: [WorkbenchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Router, useValue: { navigate } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(params) } } },
      ],
    });
    const fixture = TestBed.createComponent(WorkbenchComponent);
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, navigate, bridge: TestBed.inject(WorkbenchBridgeService) };
  }

  /**
   * A stand-in feature page: reports whatever item it is "showing" and accepts (or
   * refuses) a restore, exactly as the real pages do through the same two hooks.
   */
  function fakePage(feature: FeatureKey, opts: { item?: string | null; restores?: boolean } = {}) {
    const controller: GuidedFormController & { item: string | null; restored: string[] } = {
      feature,
      item: opts.item ?? null,
      restored: [],
      openNewForm: () => {},
      setField: () => ({ applied: true }),
      highlight: () => {},
      snapshot: () => ({}),
      currentItem: () => controller.item,
      restoreItem: async (token: string) => {
        controller.restored.push(token);
        const ok = opts.restores ?? true;
        if (ok) controller.item = token;
        return ok;
      },
    };
    return controller;
  }

  /** The query params of the most recent router.navigate call. */
  function lastParams(navigate: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const call = navigate.mock.calls.at(-1);
    return (call?.[1] as { queryParams: Record<string, unknown> }).queryParams;
  }

  /**
   * Render, the way a real feature page does when its selection changes: it calls
   * markForCheck, which is what makes the tick actually render — and Angular runs
   * afterEveryRender hooks (so, the URL mirror) only on a tick that renders. A fake
   * controller has no view of its own, so we dirty the shell in its place.
   */
  function render(fixture: ReturnType<typeof mount>['fixture']): void {
    fixture.componentRef.changeDetectorRef.markForCheck();
    fixture.detectChanges();
  }

  it('asks the page named by ?view= to re-open the ?item= it was showing', async () => {
    const { bridge, component } = mount({ view: 'kpi', item: 'Fill Rate' });
    const page = fakePage('kpi', { item: null });
    bridge.register(page);

    await vi.waitFor(() => expect(page.restored).toEqual(['Fill Rate']));
    expect(component.activeView).toBe('kpi');
  });

  it('keeps the restored item in the URL — it never re-writes what is already there', async () => {
    const { bridge, fixture, navigate } = mount({ view: 'kpi', item: 'Fill Rate' });
    const page = fakePage('kpi');
    bridge.register(page);

    await vi.waitFor(() => expect(page.restored).toHaveLength(1));
    fixture.detectChanges();

    // The URL already said view=kpi&item=Fill Rate, so the mirror had nothing to do.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('drops an ?item= that no longer resolves, leaving the page on its overview', async () => {
    const { bridge, fixture, navigate } = mount({ view: 'kpi', item: 'DeletedKpi' });
    const page = fakePage('kpi', { restores: false });
    bridge.register(page);

    await vi.waitFor(() => expect(page.restored).toEqual(['DeletedKpi']));
    fixture.detectChanges();

    expect(lastParams(navigate)).toEqual({ view: 'kpi' });
  });

  it('ignores an ?item= when the ?view= names no page — the token is not ours to apply', async () => {
    const { bridge } = mount({ view: 'not-a-page', item: 'Fill Rate' });
    const page = fakePage('introduction');
    bridge.register(page);

    // Give the restore poll a window in which it would have fired.
    await new Promise((r) => setTimeout(r, 60));
    expect(page.restored).toEqual([]);
  });

  it('mirrors the item the page opens on its own into ?item=', () => {
    const { bridge, fixture, navigate } = mount({ view: 'bi-cubes' });
    const page = fakePage('bi-cubes');
    bridge.setActiveView('bi-cubes');
    bridge.register(page);
    render(fixture);

    // The user clicks a cube: the page now reports it, and the next render mirrors it.
    page.item = 'SalesOrderCube';
    render(fixture);

    expect(lastParams(navigate)).toEqual({ view: 'bi-cubes', item: 'SalesOrderCube' });
  });

  it('drops ?item= when the page goes back to its overview', () => {
    const { bridge, fixture, navigate } = mount({ view: 'bi-cubes' });
    const page = fakePage('bi-cubes', { item: 'SalesOrderCube' });
    bridge.setActiveView('bi-cubes');
    bridge.register(page);
    render(fixture);
    expect(lastParams(navigate)).toEqual({ view: 'bi-cubes', item: 'SalesOrderCube' });

    page.item = null;
    render(fixture);

    expect(lastParams(navigate)).toEqual({ view: 'bi-cubes' });
  });

  it('never carries one page`s item over to another — a view switch clears it', () => {
    const { bridge, component, fixture, navigate } = mount({ view: 'bi-cubes' });
    const page = fakePage('bi-cubes', { item: 'SalesOrderCube' });
    bridge.setActiveView('bi-cubes');
    bridge.register(page);
    render(fixture);

    // The outgoing page's controller stays registered until Angular destroys it, so
    // this is the window in which its item could leak under the new page's key.
    component.selectView('kpi');

    expect(lastParams(navigate)).toEqual({ view: 'kpi' });
    render(fixture);
    expect(lastParams(navigate)).toEqual({ view: 'kpi' });
  });
});

/**
 * The bridge side of the same contract: reading the open item is guarded, and
 * restoring is tolerant of every way a page can fail to produce the item.
 */
describe('WorkbenchBridgeService — item token plumbing', () => {
  function bridgeWith(controller?: GuidedFormController) {
    const bridge = new WorkbenchBridgeService();
    if (controller) bridge.register(controller);
    return bridge;
  }

  function stub(feature: FeatureKey, extra: Partial<GuidedFormController> = {}): GuidedFormController {
    return {
      feature,
      openNewForm: () => {},
      setField: () => ({ applied: true }),
      highlight: () => {},
      snapshot: () => ({}),
      ...extra,
    };
  }

  it('reads the mounted page`s item', () => {
    const bridge = bridgeWith(stub('kpi', { currentItem: () => 'Fill Rate' }));
    bridge.activeView.set('kpi');
    expect(bridge.currentItemToken()).toBe('Fill Rate');
  });

  it('reports no item for a page that has no item concept', () => {
    const bridge = bridgeWith(stub('dashboard'));
    bridge.activeView.set('dashboard');
    expect(bridge.currentItemToken()).toBeNull();
  });

  it('ignores a controller that is not the page on screen (a switch in flight)', () => {
    const bridge = bridgeWith(stub('bi-cubes', { currentItem: () => 'SalesOrderCube' }));
    bridge.activeView.set('kpi');
    expect(bridge.currentItemToken()).toBeNull();
  });

  it('treats an empty token as no item', () => {
    const bridge = bridgeWith(stub('kpi', { currentItem: () => '' }));
    bridge.activeView.set('kpi');
    expect(bridge.currentItemToken()).toBeNull();
  });

  it('restores through the page that owns the item', async () => {
    const seen: string[] = [];
    const bridge = bridgeWith(stub('kpi', { restoreItem: async (t) => { seen.push(t); return true; } }));
    await expect(bridge.restoreItem('kpi', ' Fill Rate ')).resolves.toBe(true);
    // Trimmed — a hand-edited URL shouldn't fail on whitespace.
    expect(seen).toEqual(['Fill Rate']);
  });

  it('fails cleanly for a page that cannot address items, a blank token, or a throw', async () => {
    const plain = bridgeWith(stub('business-process'));
    await expect(plain.restoreItem('business-process', 'anything')).resolves.toBe(false);
    await expect(plain.restoreItem('business-process', '   ')).resolves.toBe(false);

    const throws = bridgeWith(stub('kpi', { restoreItem: () => Promise.reject(new Error('boom')) }));
    await expect(throws.restoreItem('kpi', 'Fill Rate')).resolves.toBe(false);
  });

  it('gives up rather than hanging when the page never mounts', async () => {
    const bridge = bridgeWith();
    await expect(bridge.restoreItem('kpi', 'Fill Rate')).resolves.toBe(false);
  });
});
