import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { KpiComponent } from './kpi';
import { WorkbenchBridgeService, type SetFieldResult } from '../core/workbench-bridge.service';
import { KpiApiService } from '../services/kpi.service';
import { CubeService } from '../services/cube.service';
import { KpiGroupService, UNGROUPED } from '../services/kpi-group.service';
import { ToastService } from '../core/toast.service';
import { KpiHealthService } from '../dashboard/services/kpi-health.service';
import { DashboardChartService, type CubeShape } from '../dashboard/services/dashboard-chart.service';
import { composeCondition } from '../cube/condition-mdx';
import type { MemberRefInput } from '../cube/member-ref';
import scenarios from '../../../../test/fixtures/agent-mdx-scenarios.json' with { type: 'json' };

/**
 * C18 / SC-2715 — Option 1 (guided scenarios G1–G4): the golden MDX a competent
 * agent would emit lands (or correctly rejects) through the REAL runtime seam a
 * `ui_set_field` tool call takes — `WorkbenchBridgeService.applyDirective` →
 * `guidedSetField` (kpi.ts:438). No `runAgentTurn`, no fake stream: this is the
 * deterministic regression net bound to the named C18 scenario set (spec §4).
 *
 * The scenario table is the shared JSON single source of truth, read as data here,
 * by the backend A1 test, and by the live Option 2 eval; imported as code by none.
 */
interface Scenario {
  id: string;
  mode: 'guided' | 'agent';
  userPrompt: string;
  cube: string;
  expected: { toolPath: string; conditionMdx?: string; resolvesTo?: string; landing: 'applied' | 'rejected' };
}
const byId = (id: string) => (scenarios as Scenario[]).find((s) => s.id === id)!;

// Scenario cube: status (G1) + productCategory (G2 multi-member set) single-level dims for the
// condition goldens, customer/country (G3 resolve). Level specs mirror the LIVE ProductInventoryCube
// shape verified against the running SCO instance, so the goldens the composer emits here are the
// same members the live Option 2 eval encounters ([productCategory].[H1].[Category] carries clean
// Battery/CPU members with data; the synthetic [region] dim the earlier draft used does not exist
// on the live cube). No [warehouse].[H1].[bin] level exists — G4's member is valid MDX but
// unenumerated → reject.
const CUBE_SHAPE: CubeShape = {
  cube: 'ProductInventoryCube',
  measures: [{ name: 'AvailableQuantity', caption: 'Available Quantity' }],
  dimensions: [
    { name: 'status', kind: 'categorical', levels: [{ name: 'status', spec: '[status].[H1].[status]' }] },
    { name: 'productCategory', kind: 'categorical', levels: [{ name: 'Category', caption: 'Category', spec: '[productCategory].[H1].[Category]' }] },
    { name: 'customer', kind: 'categorical', levels: [{ name: 'country', caption: 'Country', spec: '[customer].[H1].[country]' }] },
  ],
};

function setup() {
  TestBed.resetTestingModule();
  const kpiApi = {
    getKpiDefinitions: vi.fn(() => of([])),
    listKpiDrafts: vi.fn(() => of({ drafts: [] })),
    listKpiBaseObjects: vi.fn(() => of({ baseObjects: ['Inventory'] })),
    saveKpiDraft: vi.fn(() => of({})),
    createKpiDefinition: vi.fn(() => of({})),
    updateKpiDefinition: vi.fn(() => of({})),
    deleteKpiDefinition: vi.fn(() => of({})),
    deleteKpiDraft: vi.fn(() => of({})),
    getKpiData: vi.fn(() => of({ values: [] })),
    getKpiListing: vi.fn(() => of([])),
  };
  const dashboardChart = {
    getCubeShape: vi.fn(() => of(CUBE_SHAPE)),
    getCubeMembers: vi.fn(() => of({ members: [] as Array<{ name: string; key?: string; caption?: string }> })),
  };
  const cubeSvc = {
    list: vi.fn(() => of({ cubes: [{ cubeName: 'ProductInventoryCube', sourceClass: 'SC.Data.Inventory', state: 'built' }] })),
  };
  const kpiGroups = {
    groupOf: vi.fn(() => UNGROUPED),
    groupNames: vi.fn(() => [] as string[]),
    assign: vi.fn(), createGroup: vi.fn(() => true), deleteGroup: vi.fn(), forget: vi.fn(), renameKpi: vi.fn(),
  };
  const toasts = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  TestBed.configureTestingModule({
    imports: [KpiComponent],
    providers: [
      { provide: KpiApiService, useValue: kpiApi },
      { provide: DashboardChartService, useValue: dashboardChart },
      { provide: CubeService, useValue: cubeSvc },
      { provide: KpiGroupService, useValue: kpiGroups },
      { provide: ToastService, useValue: toasts },
      { provide: KpiHealthService, useValue: { getKpiHealth: vi.fn(() => of(null)) } },
    ],
  });
  const fixture: ComponentFixture<KpiComponent> = TestBed.createComponent(KpiComponent);
  const bridge = TestBed.inject(WorkbenchBridgeService);
  fixture.detectChanges(); // ngOnInit → registers the guided controller, loads cubes + base objects
  return { fixture, bridge, component: fixture.componentInstance };
}

/** Drive a set_field directive the way a ui_set_field tool call would at runtime. */
const setField = (bridge: WorkbenchBridgeService, path: string, value: string | number | boolean): Promise<SetFieldResult> =>
  bridge.applyDirective({ action: 'set_field', target: path, value });

// Select the cube so the metadata load (formCubeDimensions / formCubeMeasures) resolves before dimension pins.
async function selectCube(bridge: WorkbenchBridgeService, component: KpiComponent) {
  await setField(bridge, 'cube', 'ProductInventoryCube');
  await (component as unknown as { cubeMetaLoading: Promise<void> | null }).cubeMetaLoading;
}

describe('C18 Option 1 (guided G1–G4): golden MDX lands through the real ui_set_field seam', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('G1: "is" simple member composes the golden MDX and lands', async () => {
    const { bridge, component } = setup();
    const sel: MemberRefInput = { dim: 'status', levelSpec: '[status].[H1].[status]', member: 'Open', key: 'Open' };
    const composed = composeCondition(sel, 'is');
    expect(composed).toBe(byId('G1').expected.conditionMdx); // composer == golden
    const res = await setField(bridge, byId('G1').expected.toolPath, composed);
    expect(res.applied).toBe(true);
    expect(component.form.kpiConditions[0]).toBe(byId('G1').expected.conditionMdx);
  });

  it('G2: "isOneOf" multi-member set composes the golden MDX and lands', async () => {
    const { bridge, component } = setup();
    const a: MemberRefInput = { dim: 'productCategory', levelSpec: '[productCategory].[H1].[Category]', member: 'Battery', key: 'Battery' };
    const b: MemberRefInput = { dim: 'productCategory', levelSpec: '[productCategory].[H1].[Category]', member: 'CPU', key: 'CPU' };
    const composed = composeCondition([a, b], 'isOneOf');
    expect(composed).toBe(byId('G2').expected.conditionMdx);
    const res = await setField(bridge, byId('G2').expected.toolPath, composed);
    expect(res.applied).toBe(true);
    expect(component.form.kpiConditions[0]).toBe(byId('G2').expected.conditionMdx);
  });

  it('G3: a plain dimension term ("country") fuzzy-resolves to the canonical MDX member and lands', async () => {
    const { bridge, component } = setup();
    await selectCube(bridge, component);
    const res = await setField(bridge, byId('G3').expected.toolPath, 'country');
    expect(res.applied).toBe(true);
    expect(component.form.dimensions[0]!.cubeDimension).toBe(byId('G3').expected.resolvesTo);
  });

  it('G4 (residual-risk): a valid-MDX member the cube does NOT enumerate is REJECTED, not blind-written', async () => {
    const { bridge, component } = setup();
    await selectCube(bridge, component);
    const res = await setField(bridge, byId('G4').expected.toolPath, '[warehouse].[H1].[bin]');
    expect(res.applied).toBe(false);
    expect(res.detail).toContain('not a dimension');
    expect(component.form.dimensions[0]!.cubeDimension).not.toBe('[warehouse].[H1].[bin]');
  });
});
