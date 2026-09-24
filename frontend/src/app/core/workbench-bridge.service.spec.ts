import { TestBed } from '@angular/core/testing';
import { WorkbenchBridgeService, FEATURE_LABELS, type GuidedFormController } from './workbench-bridge.service';

describe('FEATURE_LABELS', () => {
  // The FeatureKey union is erased at runtime and cannot be enumerated here; the
  // exhaustiveness guarantee against the union is the compile-time
  // Record<FeatureKey, string>. This guards against an empty/whitespace value.
  it('maps every present key to a non-empty, trimmed label', () => {
    const entries = Object.entries(FEATURE_LABELS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, label] of entries) {
      expect(label, `label for ${key}`).toBe(label.trim());
      expect(label.length, `label for ${key}`).toBeGreaterThan(0);
    }
  });

  it('uses the agreed friendly labels for the renamed views', () => {
    expect(FEATURE_LABELS['bi-cubes']).toBe('Analytics Cube');
    expect(FEATURE_LABELS['kpi']).toBe('Business KPI');
    expect(FEATURE_LABELS['others']).toBe('Others');
    expect(FEATURE_LABELS['data-model']).toBe('Data Model');
  });
});

describe('WorkbenchBridgeService.activeViewLabel', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  it('reflects the default active view', () => {
    // Default activeView is 'introduction' — the first page under Getting Started.
    expect(bridge.activeViewLabel()).toBe('Introduction');
  });

  it('updates when the view changes via setActiveView (the guided/agent path)', () => {
    bridge.setActiveView('kpi');
    expect(bridge.activeViewLabel()).toBe('Business KPI');
    bridge.setActiveView('others');
    expect(bridge.activeViewLabel()).toBe('Others');
  });

  it('does not reset the chat session when the view changes (no-reset invariant)', () => {
    bridge.currentSessionId.set('sess-123');
    bridge.setActiveView('kpi');
    expect(bridge.currentSessionId()).toBe('sess-123');

    bridge.currentSessionId.set(null);
    bridge.setActiveView('bi-cubes');
    expect(bridge.currentSessionId()).toBeNull();
  });
});

describe('WorkbenchBridgeService.applyDirective — open_entity', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  type OpenEntityOpts = { formKind?: string; mode?: 'view' | 'edit' };
  /** A minimal controller for `feature` that records openEntity calls. */
  function fakeController(feature: GuidedFormController['feature'], withOpenEntity = true): {
    controller: GuidedFormController;
    calls: Array<{ name: string; opts?: OpenEntityOpts }>;
  } {
    const calls: Array<{ name: string; opts?: OpenEntityOpts }> = [];
    const controller: GuidedFormController = {
      feature,
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({}),
      ...(withOpenEntity
        ? { openEntity: async (name: string, opts?: OpenEntityOpts) => { calls.push({ name, opts }); return { applied: true, detail: `opened ${name}` }; } }
        : {}),
    };
    return { controller, calls };
  }

  it('routes to controller.openEntity, switches the view, and defaults mode to "view"', async () => {
    const { controller, calls } = fakeController('data-model');
    bridge.register(controller); // already mounted → waitForController resolves immediately
    const res = await bridge.applyDirective({
      action: 'open_entity',
      target: 'data-model',
      value: { name: 'Employee', formKind: 'attribute' }, // no mode → view
    });
    expect(res.applied).toBe(true);
    expect(bridge.activeViewLabel()).toBe('Data Model');
    expect(calls).toEqual([{ name: 'Employee', opts: { mode: 'view', formKind: 'attribute' } }]);
  });

  it('passes an explicit mode:"edit" through to openEntity', async () => {
    const { controller, calls } = fakeController('kpi');
    bridge.register(controller);
    await bridge.applyDirective({ action: 'open_entity', target: 'kpi', value: { name: 'RevenueKpi', mode: 'edit' } });
    expect(calls).toEqual([{ name: 'RevenueKpi', opts: { mode: 'edit' } }]);
  });

  it('blocks navigation when the mounted feature has unsaved edits', async () => {
    // A DIFFERENT feature is mounted with unsaved edits → the leave dialog would
    // block the switch, so the directive must fail with a "save a draft first" hint
    // instead of firing a navigate that hangs.
    const controller: GuidedFormController = {
      feature: 'kpi',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({}),
      hasUnsavedEdits: () => true,
    };
    bridge.setActiveView('kpi'); // the user is on (and editing) the KPI page
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'open_entity', target: 'bi-cubes', value: { name: 'AnyCube' } });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/unsaved changes/i);
    // The block tells the assistant to ask (save vs discard) and retry with
    // onUnsaved — it resolves the edits itself, never punting to a dialog click.
    expect(res.detail).toMatch(/save/i);
    expect(res.detail).toMatch(/discard/i);
    expect(res.detail).toMatch(/onUnsaved/);
    // The view must NOT have switched.
    expect(bridge.activeViewLabel()).toBe('Business KPI');
  });

  it('fails when the entity name is blank', async () => {
    const { controller } = fakeController('kpi');
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'open_entity', target: 'kpi', value: { name: '   ' } });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/requires an entity name/i);
  });

  it('fails clearly when the mounted feature has no openEntity support', async () => {
    const { controller } = fakeController('kpi', /* withOpenEntity */ false);
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'open_entity', target: 'kpi', value: { name: 'X' } });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/cannot open a specific entity/i);
  });

  it('D: an open_entity directive TO issue-management reaches the page openEntity via the generic case', async () => {
    // Proves the assistant deep-link needs NO special routing — the generic
    // open_entity case (unchanged) lands on the page seam once the page adds it.
    const { controller, calls } = fakeController('issue-management');
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'open_entity', target: 'issue-management', value: { name: 'WBInventoryRecords' } });
    expect(calls).toEqual([{ name: 'WBInventoryRecords', opts: { mode: 'view' } }]);
    expect(res.applied).toBe(true);
  });

  it('E (D-PLAN-01): an open_entity TO issue-management from a dirty source is still blocked by the handshake', async () => {
    // A DIFFERENT, editable page is mounted with unsaved edits. The unsaved-edits
    // guard inspects the SOURCE controller, so the deep-link to issue-management must
    // still refuse-and-ask — the generic case must NOT be short-circuited for this target.
    const dirty: GuidedFormController = {
      feature: 'kpi',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({}),
      hasUnsavedEdits: () => true,
    };
    bridge.setActiveView('kpi');
    bridge.register(dirty);
    const res = await bridge.applyDirective({ action: 'open_entity', target: 'issue-management', value: { name: 'WBTotalQuantity' } });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/unsaved changes/i);
    expect(bridge.activeViewLabel()).toBe('Business KPI'); // view did NOT switch
  });
});

describe('WorkbenchBridgeService.openIssuesForKpi', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  function issueController(): { controller: GuidedFormController; calls: string[] } {
    const calls: string[] = [];
    const controller: GuidedFormController = {
      feature: 'issue-management',
      openNewForm: () => undefined,
      setField: () => ({ applied: false }),
      highlight: () => undefined,
      snapshot: () => ({}),
      openEntity: async (name: string) => { calls.push(name); return { applied: true, detail: `opened ${name}` }; },
    };
    return { controller, calls };
  }

  it('switches to issue-management and calls the controller openEntity with the KPI name', async () => {
    const { controller, calls } = issueController();
    bridge.register(controller); // already mounted → waitForController resolves immediately
    const res = await bridge.openIssuesForKpi('WBTotalQuantity');
    expect(bridge.activeView()).toBe('issue-management');
    expect(calls).toEqual(['WBTotalQuantity']);
    expect(res).toEqual({ applied: true, detail: 'opened WBTotalQuantity' });
  });

  it('resolves applied:false (no throw) when no issue-management controller registers', async () => {
    vi.useFakeTimers();
    try {
      const pending = bridge.openIssuesForKpi('WBTotalQuantity'); // none registered → waitForController times out
      await vi.advanceTimersByTimeAsync(2500);
      const res = await pending;
      expect(res.applied).toBe(false);
      expect(bridge.activeView()).toBe('issue-management'); // the view still switched
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkbenchBridgeService.applyDirective — open_form opens the create form', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  /** A cube controller that records openNewForm calls. */
  function fakeCubeController(): { controller: GuidedFormController; opened: Array<{ formKind?: string } | undefined> } {
    const opened: Array<{ formKind?: string } | undefined> = [];
    const controller: GuidedFormController = {
      feature: 'bi-cubes',
      openNewForm: (opts) => { opened.push(opts); },
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({ mode: 'creating new cube', name: '(empty)' }),
    };
    return { controller, opened };
  }

  it('clicks New for the user (calls openNewForm) and returns the open form snapshot', async () => {
    const { controller, opened } = fakeCubeController();
    bridge.register(controller); // already mounted → waitForController resolves immediately
    const res = await bridge.applyDirective({ action: 'open_form', target: 'bi-cubes' });
    expect(res.applied).toBe(true);
    // The form was actually opened by the bridge — NOT deferred to a user click.
    expect(opened).toHaveLength(1);
    // The result carries the now-open form's context + a directive not to ask the
    // user to click New, so the assistant fills fields this turn.
    expect(res.detail).toContain('creating new cube');
    expect(res.detail).toMatch(/do not ask the user to click New/i);
    expect(bridge.activeViewLabel()).toBe('Analytics Cube');
  });

  it('passes formKind through to openNewForm (data-model object vs attribute)', async () => {
    const opened: Array<{ formKind?: string } | undefined> = [];
    const controller: GuidedFormController = {
      feature: 'data-model',
      openNewForm: (opts) => { opened.push(opts); },
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({ mode: 'creating new custom object' }),
    };
    bridge.register(controller);
    await bridge.applyDirective({ action: 'open_form', target: 'data-model', value: { formKind: 'object' } });
    expect(opened).toEqual([{ formKind: 'object' }]);
  });

  it('blocks opening a form when the current feature has unsaved edits', async () => {
    const editing: GuidedFormController = {
      feature: 'kpi',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({}),
      hasUnsavedEdits: () => true,
    };
    bridge.setActiveView('kpi');
    bridge.register(editing);
    const res = await bridge.applyDirective({ action: 'open_form', target: 'bi-cubes' });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/unsaved changes/i);
  });
});

describe('WorkbenchBridgeService.applyDirective — navigate returns the destination context', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  it('waits for the list to load and returns the page snapshot in the tool result', async () => {
    // A kpi controller whose list is ready and whose snapshot names two KPIs.
    const controller: GuidedFormController = {
      feature: 'kpi',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({ mode: 'KPI list (no KPI selected)', kpiCount: 2, kpis: ['A', 'B'] }),
      whenListReady: () => Promise.resolve(),
    };
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'navigate', target: 'kpi' });
    expect(res.applied).toBe(true);
    // The result carries the destination page's context so the agent can act this turn.
    expect(res.detail).toContain('Business KPI');
    expect(res.detail).toContain('KPI list (no KPI selected)');
    expect(res.detail).toContain('kpiCount: 2');
    expect(bridge.activeViewLabel()).toBe('Business KPI');
  });

  it('still blocks a navigate when the current feature has unsaved edits', async () => {
    const editing: GuidedFormController = {
      feature: 'kpi',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({}),
      hasUnsavedEdits: () => true,
    };
    bridge.setActiveView('kpi');
    bridge.register(editing);
    const res = await bridge.applyDirective({ action: 'navigate', target: 'bi-cubes' });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/unsaved changes/i);
    // The block tells the assistant to ask + retry with onUnsaved (not to make the
    // user click a dialog).
    expect(res.detail).toMatch(/onUnsaved/);
    expect(bridge.activeViewLabel()).toBe('Business KPI'); // did not switch
  });
});

describe('WorkbenchBridgeService.applyDirective — resolves unsaved edits for the user (onUnsaved)', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  /** An editing controller that records how its unsaved edits were resolved. */
  function editingController(resolve: (d: 'save' | 'discard') => Promise<{ applied: boolean; detail?: string }>): {
    controller: GuidedFormController;
    dirty: { value: boolean };
    resolved: Array<'save' | 'discard'>;
  } {
    const dirty = { value: true };
    const resolved: Array<'save' | 'discard'> = [];
    const controller: GuidedFormController = {
      feature: 'kpi',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({}),
      hasUnsavedEdits: () => dirty.value,
      resolveUnsaved: (d) => { resolved.push(d); return resolve(d); },
      whenListReady: () => Promise.resolve(),
    };
    return { controller, dirty, resolved };
  }

  it('discards the edits and proceeds when navigate is retried with onUnsaved:"discard"', async () => {
    const { controller, dirty, resolved } = editingController(async () => { dirty.value = false; return { applied: true }; });
    bridge.setActiveView('kpi');
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'navigate', target: 'bi-cubes', value: { onUnsaved: 'discard' } });
    expect(resolved).toEqual(['discard']);
    expect(res.applied).toBe(true);
    expect(bridge.activeViewLabel()).toBe('Analytics Cube'); // switched
  });

  it('saves the draft and proceeds when open_form is retried with onUnsaved:"save"', async () => {
    const { controller, dirty, resolved } = editingController(async () => { dirty.value = false; return { applied: true }; });
    bridge.setActiveView('kpi');
    bridge.register(controller);
    // open_form waits for the TARGET feature's controller (mounted after the view
    // switch in the real app) — mirror that: register a bi-cubes controller the
    // moment the switch is requested, so openNewForm has something to run on.
    const opened: Array<{ formKind?: string } | undefined> = [];
    bridge.navRequests$.subscribe((view) => {
      if (view === 'bi-cubes') {
        bridge.register({
          feature: 'bi-cubes',
          openNewForm: (opts) => { opened.push(opts); },
          setField: () => ({ applied: true }),
          highlight: () => undefined,
          snapshot: () => ({ mode: 'creating new cube' }),
        });
      }
    });
    const res = await bridge.applyDirective({ action: 'open_form', target: 'bi-cubes', value: { onUnsaved: 'save' } });
    expect(resolved).toEqual(['save']); // the KPI edits were saved for the user
    expect(res.applied).toBe(true);
    expect(opened).toHaveLength(1); // and the cube form actually opened
  });

  it('does NOT navigate when the save fails — reports the reason instead', async () => {
    const { controller } = editingController(async () => ({ applied: false, detail: 'The KPI has no name yet.' }));
    bridge.setActiveView('kpi');
    bridge.register(controller);
    const res = await bridge.applyDirective({ action: 'navigate', target: 'bi-cubes', value: { onUnsaved: 'save' } });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/no name/i);
    expect(bridge.activeViewLabel()).toBe('Business KPI'); // stayed put
  });
});

/**
 * How the assistant learns which pages exist. Nothing may hardcode that list — the
 * shell publishes the sidebar it renders (`setPages`), the assistant reads it out of
 * the per-turn UI CONTEXT, and a key that isn't in it is refused. Weighted to the
 * cases that made the assistant lie before: a page it didn't know about, and a page
 * key it remembered that no longer exists.
 */
describe('WorkbenchBridgeService — the assistant`s page catalog', () => {
  let bridge: WorkbenchBridgeService;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    bridge = TestBed.inject(WorkbenchBridgeService);
  });

  it('lists the registered pages — key, label and group — in the UI context', () => {
    bridge.setPages([
      { key: 'introduction', label: 'Introduction', group: 'Getting Started', assistantAvailable: true },
      { key: 'issue-management', label: 'Issue Management', group: 'Features', assistantAvailable: true },
      { key: 'dashboard', label: 'Dashboard', assistantAvailable: false },
    ]);
    const snap = bridge.getContextSnapshot();
    expect(snap).toContain('availablePages');
    expect(snap).toContain('- introduction — Introduction (under "Getting Started")');
    expect(snap).toContain('- issue-management — Issue Management (under "Features")');
    // The Dashboard closes the dock, so the assistant is told before it navigates there.
    expect(snap).toContain('- dashboard — Dashboard (the assistant panel closes on this page)');
    // Only the registered pages — a page the shell does not render is not offered.
    expect(snap).not.toContain('- kpi —');
  });

  it('falls back to every page the app can render before the shell registers its nav', () => {
    // A turn that lands before ngOnInit must not be told the workbench has no pages.
    const snap = bridge.getContextSnapshot();
    for (const [key, label] of Object.entries(FEATURE_LABELS)) {
      expect(snap, `catalog must list ${key}`).toContain(`- ${key} — ${label}`);
    }
  });

  it('navigates to a page the shell registered that no fixed list knew about', async () => {
    bridge.setPages([{ key: 'issue-management', label: 'Issue Management', assistantAvailable: true }]);
    // Registered up front so the navigate doesn't sit out the controller poll.
    bridge.register({
      feature: 'issue-management',
      openNewForm: () => undefined,
      setField: () => ({ applied: true }),
      highlight: () => undefined,
      snapshot: () => ({ totalIssues: 3 }),
    });
    const res = await bridge.applyDirective({ action: 'navigate', target: 'issue-management' });
    expect(res.applied).toBe(true);
    expect(bridge.activeView()).toBe('issue-management');
  });

  it('refuses a page key that is not in the live list, and answers with the real pages', async () => {
    bridge.setPages([
      { key: 'others', label: 'Others', group: 'Features', assistantAvailable: true },
      { key: 'kpi', label: 'Business KPI', group: 'Features', assistantAvailable: true },
    ]);
    // 'sam' is exactly the stale key the old hardcoded enum offered.
    for (const action of ['navigate', 'open_form'] as const) {
      const res = await bridge.applyDirective({ action, target: 'sam' });
      expect(res.applied, `${action} must refuse an unknown page`).toBe(false);
      expect(res.detail).toContain('no workbench page with the key "sam"');
      expect(res.detail).toContain('others ("Others")');
      expect(res.detail).toContain('kpi ("Business KPI")');
    }
    const opened = await bridge.applyDirective({ action: 'open_entity', target: 'sam', value: { name: 'X' } });
    expect(opened.applied).toBe(false);
    expect(opened.detail).toContain('no workbench page with the key "sam"');
    // And the refusal did NOT move the user off the page they were on.
    expect(bridge.activeView()).toBe('introduction');
  });
});
