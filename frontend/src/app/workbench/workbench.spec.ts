// frontend/src/app/workbench/workbench.spec.ts
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { WorkbenchComponent } from './workbench';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

/**
 * The sidebar hierarchy: a "Getting Started" heading over Introduction and Load
 * sample data, the SCO feature pages under a "Features" heading, then Dashboard. A
 * heading is a LABEL, not a page and not a toggle: its children are permanently
 * listed and clicking it does nothing, so the highlight always sits on the row that
 * names the open page.
 */
describe('WorkbenchComponent — sidebar hierarchy', () => {
  // The shell always mounts the assistant dock, which lists chat sessions over raw
  // fetch on init. Nothing here cares about that call, but an unstubbed one is an
  // unhandled rejection in jsdom, so answer it with an empty list.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) } as unknown as Response)) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    TestBed.resetTestingModule();
  });

  /** Mount the shell, optionally with a `?view=` in the URL (read in ngOnInit). */
  function mount(view?: string) {
    TestBed.configureTestingModule({
      imports: [WorkbenchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // The real Router would try to resolve a route with no config/outlet; the
        // component only ever uses it to mirror the view into `?view=`.
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(view ? { view } : {}) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(WorkbenchComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, component: fixture.componentInstance };
  }

  /** Every sidebar row, in render order, as label + which tier it sits in. */
  function rows(el: HTMLElement) {
    return Array.from(el.querySelectorAll('.nav-list .nav-item')).map((li) => ({
      label: li.textContent?.trim(),
      tier: li.classList.contains('nav-item--parent') ? 'group'
        : li.classList.contains('nav-item--child') ? 'child'
        : 'top',
      active: li.classList.contains('nav-item--active'),
    }));
  }

  function click(el: HTMLElement, testId: string) {
    (el.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
  }

  it('renders the Getting Started group, the Features group, then Dashboard', () => {
    const { el } = mount();

    expect(rows(el).map((r) => [r.tier, r.label])).toEqual([
      ['group', 'Getting Started'],
      ['child', 'Introduction'],
      ['child', 'Load sample data'],
      ['group', 'Features'],
      ['child', 'Data Model'],
      ['child', 'Data Integration'],
      ['child', 'Analytics Cube'],
      ['child', 'Business KPI'],
      ['child', 'Issue Management'],
      ['child', 'Business Process'],
      ['child', 'Others'],
      ['top',   'Dashboard'],
    ]);
  });

  it('opens the Introduction page — the first entry under Getting Started', () => {
    // It is the DEFAULT page too, so this asserts what the sidebar opens on.
    const { el, fixture, component } = mount();
    expect(component.activeView).toBe('introduction');
    expect(el.querySelector('app-introduction')).not.toBeNull();

    click(el, 'nav-data-integration');
    fixture.detectChanges();
    click(el, 'nav-introduction');
    fixture.detectChanges();

    expect(component.activeView).toBe('introduction');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Introduction']);
    expect(el.querySelector('app-introduction')).not.toBeNull();
  });

  it('opens the Load sample data page from under Getting Started, after Introduction', () => {
    const { el, fixture, component } = mount();
    // Both pages sit under the Getting Started heading, in that order — no longer a
    // top-level row of its own.
    const labels = rows(el).map((r) => r.label);
    expect(labels.slice(0, 3)).toEqual(['Getting Started', 'Introduction', 'Load sample data']);
    expect(rows(el).filter((r) => r.tier === 'top').map((r) => r.label)).toEqual(['Dashboard']);

    click(el, 'nav-load-sample-data');
    fixture.detectChanges();

    expect(component.activeView).toBe('load-sample-data');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Load sample data']);
    expect(el.querySelector('app-load-sample-data')).not.toBeNull();
  });

  it('does nothing at all when EITHER heading is clicked', () => {
    const { el, fixture, component } = mount();
    click(el, 'nav-data-integration');
    fixture.detectChanges();

    click(el, 'nav-group-features');
    fixture.detectChanges();
    click(el, 'nav-group-getting-started');
    fixture.detectChanges();

    // No navigation (a heading owns no page), and nothing hides: the nine child
    // rows and the current highlight are exactly where they were.
    expect(component.activeView).toBe('data-integration');
    expect(rows(el).filter((r) => r.tier === 'child')).toHaveLength(9);
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Data Integration']);
  });

  it('renders the SCO Workbench brand banner at the top of the sidebar', () => {
    const { el } = mount();
    const brand = el.querySelector('[data-testid="sidebar-brand"]');
    expect(brand).not.toBeNull();
    expect(brand?.textContent?.trim()).toContain('SCO Workbench');
    // Wordmark only — no logo image alongside it.
    expect(brand?.querySelector('img')).toBeNull();
    const sidebar = el.querySelector('.sidebar');
    expect(sidebar?.firstElementChild).toBe(brand);
  });

  it('shows the version line and attribution at the bottom of the sidebar', () => {
    const { el } = mount();
    const footer = el.querySelector('[data-testid="sidebar-footer"]');
    expect(footer?.querySelector('[data-testid="sidebar-version"]')?.textContent?.trim())
      .toBe('Version: 1.0.0');
    expect(footer?.querySelector('[data-testid="sidebar-credit"]')?.textContent?.trim())
      .toBe('Originally built by InterSystems supply chain team');
    // The footer is the last child of the sidebar (pinned below the nav list).
    expect(el.querySelector('.sidebar')?.lastElementChild).toBe(footer);
  });

  it('renders no expand/collapse arrow', () => {
    const { el } = mount();

    expect(el.querySelector('.nav-arrow')).toBeNull();
    expect(el.querySelector('[data-testid="nav-group-features"]')?.textContent?.trim()).toBe('Features');
    expect(el.querySelector('[data-testid="nav-group-getting-started"]')?.textContent?.trim())
      .toBe('Getting Started');
  });

  it('switches to the page a child names, and highlights only that child', () => {
    const { el, fixture, component } = mount();

    click(el, 'nav-data-integration');
    fixture.detectChanges();

    expect(component.activeView).toBe('data-integration');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Data Integration']);
  });

  it('still navigates from the top-level entry below the groups', () => {
    const { el, fixture, component } = mount();

    click(el, 'nav-dashboard');
    fixture.detectChanges();
    expect(component.activeView).toBe('dashboard');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Dashboard']);

    // …and back up into the first group, which is where the default page lives now.
    click(el, 'nav-introduction');
    fixture.detectChanges();
    expect(component.activeView).toBe('introduction');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Introduction']);
  });

  it('never highlights a heading — the child that is the open page carries it', () => {
    const { el, fixture } = mount();

    // Including a page under the FIRST heading, whose own row used to be the page.
    for (const page of ['nav-kpi', 'nav-others', 'nav-data-model', 'nav-load-sample-data']) {
      click(el, page);
      fixture.detectChanges();
      expect(rows(el).filter((r) => r.tier === 'group').some((r) => r.active)).toBe(false);
      expect(rows(el).filter((r) => r.active)).toHaveLength(1);
    }
  });

  it('restores the page named by ?view= and highlights it inside the group', () => {
    const { el, component } = mount('business-process');

    expect(component.activeView).toBe('business-process');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Business Process']);
  });

  it('follows a navigation driven from outside the sidebar (guided mode)', () => {
    // Guided mode (and the agent) navigate through the bridge, not by clicking.
    const { el, fixture, component } = mount();

    TestBed.inject(WorkbenchBridgeService).setActiveView('others');
    fixture.detectChanges();

    expect(component.activeView).toBe('others');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Others']);
  });

  it('leaves the nav alone for a ?view= that names no entry', () => {
    const { el, component } = mount('not-a-page');

    expect(component.activeView).toBe('introduction');
    expect(rows(el).filter((r) => r.active).map((r) => r.label)).toEqual(['Introduction']);
  });

  it('marks the active nav item with aria-current="page"', () => {
    const { el } = mount();
    const active = el.querySelector('.nav-item--active');
    expect(active?.getAttribute('aria-current')).toBe('page');
    const inactive = el.querySelector('.nav-item:not(.nav-item--active)');
    expect(inactive?.hasAttribute('aria-current')).toBe(false);
  });

  /**
   * The assistant's page list comes from the sidebar the shell actually renders, so
   * a page added to or removed from the nav is one the assistant immediately knows
   * about. The expectation is DERIVED from the rendered rows on purpose: it must keep
   * holding as pages come and go, which is exactly what the hardcoded copies of this
   * list did not do.
   */
  it('publishes every rendered page — and only those — as the assistant`s page list', () => {
    const { el } = mount();
    const pages = TestBed.inject(WorkbenchBridgeService).pages();

    const rendered = rows(el).filter((r) => r.tier !== 'group').map((r) => r.label);
    expect(pages.map((p) => p.label)).toEqual(rendered);
    // Every page carries the key the assistant must pass to ui_navigate, and the
    // group heading it sits under (top-level entries have none).
    expect(pages.filter((p) => p.group === 'Getting Started').map((p) => p.key))
      .toEqual(['introduction', 'load-sample-data']);
    expect(pages.find((p) => p.key === 'dashboard')).toEqual({
      key: 'dashboard', label: 'Dashboard', assistantAvailable: false,
    });
    // Every other page keeps the assistant dock open.
    expect(pages.filter((p) => !p.assistantAvailable).map((p) => p.key)).toEqual(['dashboard']);
  });

  it('puts that page list in the UI context the assistant is sent each turn', () => {
    const { el } = mount();
    const snap = TestBed.inject(WorkbenchBridgeService).getContextSnapshot();

    expect(snap).toContain('availablePages');
    for (const row of rows(el).filter((r) => r.tier !== 'group')) {
      expect(snap, `the assistant must be told about ${row.label}`).toContain(`— ${row.label}`);
    }
  });
});
