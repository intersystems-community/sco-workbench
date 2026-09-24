import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';
import {
  isStateChanging,
  isUiTool,
  isOurTool,
  qualifiedToolName,
  ALL_TOOL_NAMES,
  ALLOWED_BUILTIN_TOOLS,
  CONTEXT_LOOKUP_TOOLS,
  isContextLookupTool,
  STATE_CHANGING_TOOLS,
  UI_TOOLS,
  createScoMcpServer,
} from '../../src/tools/index.js';
import { ConfirmationBroker } from '../../src/server/confirm.js';
import { cubeTools } from '../../src/tools/cube-tools.js';
import { kpiTools } from '../../src/tools/kpi-tools.js';
import { lookupTools } from '../../src/tools/lookup-tools.js';
import { uiTools } from '../../src/tools/ui-tools.js';
import type { CubeMember, CubeMemberReader } from '../../src/dashboard/chart-data.js';
import { AtelierClient } from '../../src/iris/atelier-client.js';
import { NativeClient, type ConnectionFactory } from '../../src/iris/native-client.js';
import { KpiRestClient } from '../../src/iris/kpi-rest-client.js';
import { ScbiKpiValueClient } from '../../src/iris/kpi-value-client.js';
import { IssueRestClient } from '../../src/iris/issue-rest-client.js';
import { ScModelRestClient } from '../../src/iris/scmodel-rest-client.js';
import type { IrisServices } from '../../src/iris/index.js';
import { QuestionBroker } from '../../src/server/question.js';
import { UiControlBroker, type UiDirective } from '../../src/server/ui-control.js';

function fakeServices(nativeImpl?: (cls: string, method: string, args: unknown[]) => unknown): IrisServices {
  const factory: ConnectionFactory = () => ({
    close: () => {},
    isClosed: () => false,
    createIris: () => ({
      classMethodValue: (cls, method, ...args) => nativeImpl?.(cls, method, args),
      classMethodVoid: () => {},
      classMethodObject: () => null,
    }),
  });
  return {
    atelier: new AtelierClient({ host: 'h', port: 52773, namespace: 'SC', user: 'u', password: 'p' }),
    native: new NativeClient({ host: 'h', port: 1972, namespace: 'SC', user: 'u', password: 'p' }, factory),
    deepsee: {} as unknown as IrisServices['deepsee'],
    kpi: new KpiRestClient({ host: 'h', port: 52773, namespace: 'SC', user: 'u', password: 'p' }),
    kpiValues: new ScbiKpiValueClient({ host: 'h', port: 52773, namespace: 'SC', user: 'u', password: 'p' }),
    issues: new IssueRestClient({ host: 'h', port: 52773, namespace: 'SC', user: 'u', password: 'p' }),
    scmodel: new ScModelRestClient({ host: 'h', port: 52773, namespace: 'SC', user: 'u', password: 'p' }),
    namespace: 'SC',
    close: () => {},
  };
}

describe('tool gating metadata', () => {
  it('marks the mutating tools as state-changing', () => {
    expect([...STATE_CHANGING_TOOLS].sort()).toEqual(
      [
        'sco_add_config_item',
        'sco_remove_config_item',
        'sco_build_cube',
        'sco_compile_class',
        'sco_create_kpi',
        'sco_delete_kpi',
        'sco_enable_config_item',
        'sco_import_class',
        'sco_update_kpi',
        'sco_update_production',
      ].sort(),
    );
  });

  it('treats read-only tools as not state-changing', () => {
    expect(isStateChanging('sco_cube_info')).toBe(false);
    expect(isStateChanging('sco_production_status')).toBe(false);
    expect(isStateChanging('sco_generate_cube_cls')).toBe(false);
    // schema introspection tools are read-only and must not be gated
    expect(isStateChanging('sco_resolve_class')).toBe(false);
    expect(isStateChanging('sco_list_methods')).toBe(false);
    expect(isStateChanging('sco_list_config_items')).toBe(false);
    expect(isStateChanging('sco_remove_config_item')).toBe(true);
    expect(isStateChanging('sco_list_properties')).toBe(false);
    expect(isStateChanging('sco_match_property')).toBe(false);
    // KPI read tools are read-only; only create/update/delete are gated
    expect(isStateChanging('sco_list_kpis')).toBe(false);
    expect(isStateChanging('sco_get_kpi')).toBe(false);
    expect(isStateChanging('sco_create_kpi')).toBe(true);
    expect(isStateChanging('sco_update_kpi')).toBe(true);
    expect(isStateChanging('sco_delete_kpi')).toBe(true);
    // ui_* directive tools change only the local UI, never IRIS state
    expect(isStateChanging('ui_set_field')).toBe(false);
    expect(isStateChanging('ui_report_status')).toBe(false);
  });

  it('classifies the four guided ui_* tools as UI tools; ui_report_status is NOT (it is agent-mode)', () => {
    expect([...UI_TOOLS].sort()).toEqual(
      ['ui_highlight', 'ui_navigate', 'ui_open_form', 'ui_set_field'].sort(),
    );
    expect(isUiTool('ui_navigate')).toBe(true);
    expect(isUiTool(qualifiedToolName('ui_set_field'))).toBe(true);
    expect(isUiTool('sco_build_cube')).toBe(false);
    // ui_report_status is an AGENT-mode tool — it must NOT be gated as a guided
    // UI tool, or the permission gate would deny it in Agent mode.
    expect(isUiTool('ui_report_status')).toBe(false);
    expect(isUiTool(qualifiedToolName('ui_report_status'))).toBe(false);
  });

  it('recognizes both bare and mcp-qualified names', () => {
    expect(isStateChanging('sco_build_cube')).toBe(true);
    expect(isStateChanging(qualifiedToolName('sco_build_cube'))).toBe(true);
  });

  it('qualifies names under the iris server', () => {
    expect(qualifiedToolName('sco_cube_info')).toBe('mcp__sco__sco_cube_info');
  });
});

describe('createScoMcpServer', () => {
  it('assembles a server exposing all declared tools', () => {
    const server = createScoMcpServer(
      fakeServices(),
      new QuestionBroker(() => {}),
      new UiControlBroker(() => {}),
      new ConfirmationBroker(() => {}),
    );
    expect(server.name).toBe('sco');
    // 17 SCO/ask (incl. sco_list_methods, sco_suggest_dimension_sources,
    // sco_list_config_items, sco_remove_config_item) + 6 discovery lookups
    // (sco_list_cubes, sco_cube_detail, sco_cube_members, sco_list_data_objects,
    // sco_get_data_object, sco_row_count) + 1 data-integration generator + 5 KPI
    // + 4 guided ui_* + 1 ui_report_status = 34.
    expect(ALL_TOOL_NAMES.length).toBe(34);
  });
});

/**
 * `sco_cube_members` — the fix for the "weird members" bug. When the assistant
 * writes a KPI condition `[dim].[hier].[level].&[key]`, the `&[key]` must be a
 * REAL member key read from the cube — not the level name humanized a few ways
 * (the fabrication the model fell into with no way to read the actual members).
 * This tool exposes the exact CubeMemberReader port the MDX-builder datalist uses,
 * so a looked-up member matches a builder-placed one byte-for-byte.
 */
describe('sco_cube_members lookup tool', () => {
  const MEMBERS: CubeMember[] = [
    { name: 'Apple', key: 'Apple' },
    { name: 'iPhone', key: 'iPhone' },
    { name: 'Apple Watch', key: 'Apple Watch' },
  ];
  function memberReader(calls: Array<{ cube: string; dimension: string; level?: string }>): CubeMemberReader {
    return {
      members: async (cube, dimension, level) => {
        calls.push({ cube, dimension, level });
        return MEMBERS;
      },
    };
  }

  it('returns the cube dimension\'s REAL members (name + key), read from the member reader', async () => {
    const calls: Array<{ cube: string; dimension: string; level?: string }> = [];
    const members = lookupTools(fakeServices(), memberReader(calls)).find((t) => t.name === 'sco_cube_members')!;
    const res = await members.handler(
      { cube: 'ProductInventoryCube', dimension: 'productBrand', level: '[productBrand].[H1].[brand]' } as never,
      undefined,
    );
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // The keys the model must drop into `&[...]` — the real ones, not humanized guesses.
    expect(payload.members).toEqual(MEMBERS);
    expect(payload.count).toBe(3);
    // The optional level spec is forwarded so a multi-level dimension targets the right level.
    expect(calls).toEqual([{ cube: 'ProductInventoryCube', dimension: 'productBrand', level: '[productBrand].[H1].[brand]' }]);
  });

  it('forwards an absent level as undefined (reader picks the dimension\'s first level)', async () => {
    const calls: Array<{ cube: string; dimension: string; level?: string }> = [];
    const members = lookupTools(fakeServices(), memberReader(calls)).find((t) => t.name === 'sco_cube_members')!;
    await members.handler({ cube: 'C', dimension: 'productBrand' } as never, undefined);
    expect(calls).toEqual([{ cube: 'C', dimension: 'productBrand', level: undefined }]);
  });

  it('is a read-only lookup tool available in Guided mode, and never state-changing', () => {
    expect(ALL_TOOL_NAMES).toContain('sco_cube_members');
    expect(isContextLookupTool('sco_cube_members')).toBe(true);
    expect(isContextLookupTool(qualifiedToolName('sco_cube_members'))).toBe(true);
    expect(isStateChanging('sco_cube_members')).toBe(false);
  });
});

describe('ui_* directive tools', () => {
  it('emit a directive through the UiControlBroker and return ok once acked', async () => {
    const sent: UiDirective[] = [];
    // Fake frontend: ack each directive as soon as it's emitted, so the awaiting
    // handler resolves (mirrors the real POST /api/agent/ui-ack round-trip).
    const broker = new UiControlBroker((req) => {
      sent.push({ action: req.action, target: req.target, value: req.value });
      queueMicrotask(() => broker.ack(req.directiveId, { applied: true }));
    });
    const [navigate, openForm, setField, highlight] = uiTools(broker);

    await navigate!.handler({ feature: 'bi-cubes' } as never, undefined as never);
    await openForm!.handler({ feature: 'kpi' } as never, undefined as never);
    await setField!.handler({ path: 'name', value: 'SalesCube' } as never, undefined as never);
    await highlight!.handler({ target: 'build-button' } as never, undefined as never);

    expect(sent).toEqual([
      { action: 'navigate', target: 'bi-cubes', value: undefined },
      { action: 'open_form', target: 'kpi', value: undefined },
      { action: 'set_field', target: 'name', value: 'SalesCube' },
      { action: 'highlight', target: 'build-button', value: undefined },
    ]);
  });

  it('ui_report_status emits a report_status directive carrying the phase + outcome', async () => {
    const sent: UiDirective[] = [];
    const broker = new UiControlBroker((req) => {
      sent.push({ action: req.action, target: req.target, value: req.value });
      queueMicrotask(() => broker.ack(req.directiveId, { applied: true }));
    });
    const reportStatus = uiTools(broker).find((t) => t.name === 'ui_report_status')!;

    const res = await reportStatus.handler(
      { target: 'job-42', phase: 'created', ok: true } as never,
      undefined as never,
    );
    expect(sent).toEqual([
      { action: 'report_status', target: 'job-42', value: { phase: 'created', ok: true, detail: undefined } },
    ]);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      reported: 'job-42',
      phase: 'created',
    });
  });

  it('ui_open_form with `entity` emits open_entity, defaulting mode to "view"', async () => {
    const sent: UiDirective[] = [];
    const broker = new UiControlBroker((req) => {
      sent.push({ action: req.action, target: req.target, value: req.value });
      queueMicrotask(() => broker.ack(req.directiveId, { applied: true }));
    });
    const openForm = uiTools(broker).find((t) => t.name === 'ui_open_form')!;

    // data-model: select an existing object and open its attribute form (edit).
    await openForm.handler({ feature: 'data-model', formKind: 'attribute', entity: 'Employee', mode: 'edit' } as never, undefined as never);
    // kpi: view an existing KPI (no mode → defaults to "view").
    await openForm.handler({ feature: 'kpi', entity: 'RevenueKpi' } as never, undefined as never);
    // bi-cubes: reopen a saved draft in edit mode.
    await openForm.handler({ feature: 'bi-cubes', entity: 'SalesCube', mode: 'edit' } as never, undefined as never);

    expect(sent).toEqual([
      { action: 'open_entity', target: 'data-model', value: { name: 'Employee', mode: 'edit', formKind: 'attribute' } },
      { action: 'open_entity', target: 'kpi', value: { name: 'RevenueKpi', mode: 'view' } },
      { action: 'open_entity', target: 'bi-cubes', value: { name: 'SalesCube', mode: 'edit' } },
    ]);
  });

  it('ui_open_form reports a tool failure when the frontend cannot open the entity', async () => {
    const broker = new UiControlBroker((req) => {
      // The frontend acks applied:false — e.g. no saved draft by that name.
      queueMicrotask(() => broker.ack(req.directiveId, { applied: false, detail: 'No KPI named "Ghost" was found.' }));
    });
    const openForm = uiTools(broker).find((t) => t.name === 'ui_open_form')!;

    const res = await openForm.handler({ feature: 'kpi', entity: 'Ghost' } as never, undefined as never);
    expect(res.isError).toBe(true);
    // The failure text is JSON with the frontend's detail relayed in `error`.
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ ok: false, applied: false });
    expect(payload.error).toMatch(/No KPI named .*Ghost/);
  });

  it('drives the data-model page: navigate, open the form, set fields, highlight its ids', async () => {
    const sent: UiDirective[] = [];
    const broker = new UiControlBroker((req) => {
      sent.push({ action: req.action, target: req.target, value: req.value });
      queueMicrotask(() => broker.ack(req.directiveId, { applied: true }));
    });
    const [navigate, openForm, setField, highlight] = uiTools(broker);

    await navigate!.handler({ feature: 'data-model' } as never, undefined as never);
    await openForm!.handler({ feature: 'data-model' } as never, undefined as never);
    await setField!.handler({ path: 'objectName', value: 'Supplier' } as never, undefined as never);
    await setField!.handler({ path: 'attributes.0.dataType', value: 'String' } as never, undefined as never);
    // Each data-model highlight id is accepted by the enum-backed target schema.
    for (const target of [
      'add-object-button', 'add-attribute-button', 'objectName',
      'save-object-button', 'cancel-object-button', 'save-attribute-button', 'cancel-attribute-button',
    ]) {
      await highlight!.handler({ target } as never, undefined as never);
    }

    expect(sent.slice(0, 4)).toEqual([
      { action: 'navigate', target: 'data-model', value: undefined },
      { action: 'open_form', target: 'data-model', value: undefined },
      { action: 'set_field', target: 'objectName', value: 'Supplier' },
      { action: 'set_field', target: 'attributes.0.dataType', value: 'String' },
    ]);
    expect(sent.filter((d) => d.action === 'highlight').map((d) => d.target)).toEqual([
      'add-object-button', 'add-attribute-button', 'objectName',
      'save-object-button', 'cancel-object-button', 'save-attribute-button', 'cancel-attribute-button',
    ]);
  });

  it('blocks the handler until the frontend acks the directive', async () => {
    let pendingId = '';
    const broker = new UiControlBroker((req) => { pendingId = req.directiveId; });
    const [navigate] = uiTools(broker);

    let resolved = false;
    const p = navigate!.handler({ feature: 'bi-cubes' } as never, undefined as never).then((r) => {
      resolved = true;
      return r;
    });
    // Not resolved yet — no ack has arrived.
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Ack → the handler resolves with ok.
    expect(broker.ack(pendingId, { applied: true })).toBe(true);
    const res = await p;
    expect(resolved).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ ok: true, navigated: 'bi-cubes' });
  });

  it('ui_set_field returns a failure result when the frontend never acks (a lost ack is not a silent success)', async () => {
    vi.useFakeTimers();
    const broker = new UiControlBroker(() => { /* never acks */ });
    const setField = uiTools(broker).find((t) => t.name === 'ui_set_field')!;
    const p = setField.handler({ path: 'name', value: 'x' } as never, undefined as never);
    await vi.advanceTimersByTimeAsync(8000);
    const res = await p;
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ ok: false, applied: false });
    vi.useRealTimers();
  });

  // The page list is the frontend's to report (UI CONTEXT `availablePages`), so the
  // `feature` schema must not re-declare it: the enum that used to live here went
  // stale — it offered "sam" (gone) and rejected pages that exist ("issue-management",
  // "others", "dashboard"), so the assistant could neither reach them nor describe
  // them truthfully. Any non-empty key must pass the schema; the frontend validates.
  it('ui_navigate / ui_open_form accept any page key the frontend reports, not a fixed list', () => {
    const tools = uiTools(new UiControlBroker(() => {}));
    for (const name of ['ui_navigate', 'ui_open_form']) {
      // The union over every ui_* tool's shape needs narrowing to the one under test.
      const shape = tools.find((t) => t.name === name)!.inputSchema as { feature: z.ZodTypeAny };
      const feature = shape.feature;
      for (const key of ['issue-management', 'others', 'dashboard', 'load-sample-data', 'a-page-added-tomorrow']) {
        expect(feature.safeParse(key).success, `${name} must accept "${key}"`).toBe(true);
      }
      // An empty/non-string key is still nonsense — it names no page at all.
      expect(feature.safeParse('').success).toBe(false);
      expect(feature.safeParse(undefined).success).toBe(false);
    }
  });

  it('ui_navigate reports the frontend`s applied flag, so a refused page key is not read as a success', async () => {
    const broker = new UiControlBroker((req) => {
      // The frontend rejects a key that is not in its live page list, and answers
      // with the real pages.
      broker.ack(req.directiveId, { applied: false, detail: 'There is no workbench page with the key "sam". The pages that exist right now are: others ("Others")' });
    });
    const navigate = uiTools(broker).find((t) => t.name === 'ui_navigate')!;
    const res = await navigate.handler({ feature: 'sam' } as never, undefined as never);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      applied: false,
      context: expect.stringContaining('others ("Others")') as unknown as string,
    });
  });

  it('ui_navigate still returns ok on a lost ack (Piece 1 does not fail tools that ignore applied)', async () => {
    vi.useFakeTimers();
    const broker = new UiControlBroker(() => { /* never acks */ });
    const navigate = uiTools(broker).find((t) => t.name === 'ui_navigate')!;
    const p = navigate.handler({ feature: 'bi-cubes' } as never, undefined as never);
    await vi.advanceTimersByTimeAsync(8000);
    const res = await p;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ ok: true, navigated: 'bi-cubes' });
    vi.useRealTimers();
  });
});

describe('isOurTool surface check', () => {
  it('recognizes our catalog and the two offered built-ins', () => {
    for (const bare of ALL_TOOL_NAMES) expect(isOurTool(qualifiedToolName(bare))).toBe(true);
    for (const builtin of ALLOWED_BUILTIN_TOOLS) expect(isOurTool(builtin)).toBe(true);
  });

  it('rejects built-ins outside that list, foreign MCP tools, and unqualified names', () => {
    for (const foreign of ['Bash', 'Write', 'WebFetch', 'mcp__other__sco_compile_class']) {
      expect(isOurTool(foreign)).toBe(false);
    }
    // A bare catalog name is NOT what the SDK passes — the qualified form is. Accepting
    // the bare form would widen the check for no reason.
    expect(isOurTool('sco_compile_class')).toBe(false);
    // A name that merely starts with our prefix but is not a real tool.
    expect(isOurTool('mcp__sco__sco_drop_everything')).toBe(false);
  });
});

describe('sco_generate_cube_cls handler', () => {
  it('returns generated .cls source for a valid definition (no IRIS calls)', async () => {
    const [generate] = cubeTools(fakeServices());
    const res = await generate!.handler(
      {
        definition: {
          cubeName: 'WorkbenchTestSource',
          sourceClass: 'Workbench.Test.Source',
          measures: [
            { name: 'Total', sourceProperty: 'Amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 2 },
          ],
        },
      } as never,
      undefined,
    );
    const text = (res.content[0] as { text: string }).text;
    const payload = JSON.parse(text);
    expect(payload.ok).toBe(true);
    expect(payload.className).toBe('SC.Workbench.Cube.WorkbenchTestSource');
    expect(payload.source).toContain('Extends %DeepSee.CubeDefinition');
  });

  it('returns an error result for a duplicate LEVEL factNumber', async () => {
    const [generate] = cubeTools(fakeServices());
    const res = await generate!.handler(
      {
        definition: {
          cubeName: 'C',
          sourceClass: 'X',
          dimensions: [
            {
              name: 'D',
              type: 'data',
              hierarchies: [
                {
                  name: 'H1',
                  levels: [
                    { name: 'L', factNumber: 2 },
                    { name: 'L2', factNumber: 2 }, // clash
                  ],
                },
              ],
            },
          ],
          measures: [{ name: 'M', factName: 'MxM', aggregate: 'SUM', type: 'number', factNumber: 3 }],
        },
      } as never,
      undefined,
    );
    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Duplicate factNumber/);
  });
});

describe('KPI tools', () => {
  const validKpi = {
    name: 'MyKpi',
    type: 'DeepSee',
    deepseeKpiSpec: { cube: 'SalesOrderCube', valueType: 'raw', kpiConditions: ['[a].[H1].[x].&[Open]'] },
  };

  it('sco_create_kpi rejects an incomplete DeepSee definition before any REST call', async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    try {
      const create = kpiTools(fakeServices()).find((t) => t.name === 'sco_create_kpi')!;
      // Missing kpiConditions → must fail locally without hitting IRIS.
      const res = await create.handler(
        { definition: { name: 'X', type: 'DeepSee', deepseeKpiSpec: { cube: 'C', valueType: 'raw' } } } as never,
        undefined,
      );
      expect(res.isError).toBe(true);
      const payload = JSON.parse((res.content[0] as { text: string }).text);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/kpiConditions/);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sco_create_kpi POSTs a valid definition to the SCO KPI REST API', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify(validKpi), { status: 200 });
    }) as typeof fetch;
    try {
      const create = kpiTools(fakeServices()).find((t) => t.name === 'sco_create_kpi')!;
      const res = await create.handler({ definition: validKpi } as never, undefined);
      const payload = JSON.parse((res.content[0] as { text: string }).text);
      expect(payload.ok).toBe(true);
      expect(payload.name).toBe('MyKpi');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.url).toContain('/api/SC/scbi/v1/kpi/definitions');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sco_list_kpis returns a compact summary from the REST list', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([validKpi]), { status: 200 })) as typeof fetch;
    try {
      const list = kpiTools(fakeServices()).find((t) => t.name === 'sco_list_kpis')!;
      const res = await list.handler({} as never, undefined);
      const payload = JSON.parse((res.content[0] as { text: string }).text);
      expect(payload.ok).toBe(true);
      expect(payload.count).toBe(1);
      expect(payload.kpis[0]).toMatchObject({ name: 'MyKpi', cube: 'SalesOrderCube', valueType: 'raw' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('sco_build_cube handler', () => {
  it('builds via the native client and reports fact count', async () => {
    const services = fakeServices((_cls, method) => {
      if (method === '%BuildCube') return 1;
      if (method === '%GetCubeFactCount') return 12;
      return undefined;
    });
    const { productionTools } = await import('../../src/tools/production-tools.js');
    void productionTools; // ensure module import side-effect free
    const { cubeTools: ct } = await import('../../src/tools/cube-tools.js');
    const tools = ct(services);
    const build = tools.find((t) => t.name === 'sco_build_cube')!;
    const res = await build.handler({ cubeName: 'WorkbenchTestSource' } as never, undefined);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.factCount).toBe(12);
  });
});

/**
 * The read-only lookup set is what Guided mode is allowed to call, so its membership is
 * a security boundary, not a convenience list. These invariants are what stop it from
 * quietly becoming a write path.
 */
describe('CONTEXT_LOOKUP_TOOLS', () => {
  it('contains ONLY tools this server actually exposes', () => {
    for (const t of CONTEXT_LOOKUP_TOOLS) {
      expect(ALL_TOOL_NAMES, t).toContain(t);
    }
  });

  it('is disjoint from the state-changing set — a lookup must never mutate', () => {
    for (const t of CONTEXT_LOOKUP_TOOLS) {
      expect(isStateChanging(t), t).toBe(false);
    }
  });

  it('excludes the generators: read-only w.r.t. IRIS, but not Guided mode’s job', () => {
    expect(CONTEXT_LOOKUP_TOOLS.has('sco_generate_cube_cls')).toBe(false);
    expect(CONTEXT_LOOKUP_TOOLS.has('sco_generate_integration_classes')).toBe(false);
  });

  it('covers the DISCOVERY questions — "what exists?" as well as "what is X?"', () => {
    // Without these the assistant can only answer about something it was already given
    // the name of, which is the gap that made it blind to any page but the current one.
    for (const t of [
      'sco_list_cubes',
      'sco_cube_detail',
      'sco_cube_members',
      'sco_list_data_objects',
      'sco_get_data_object',
      'sco_list_kpis',
      'sco_get_kpi',
      'sco_row_count',
    ]) {
      expect(isContextLookupTool(t), t).toBe(true);
    }
  });

  it('recognizes both bare and mcp-qualified names', () => {
    expect(isContextLookupTool(qualifiedToolName('sco_list_cubes'))).toBe(true);
    expect(isContextLookupTool('sco_build_cube')).toBe(false);
    expect(isContextLookupTool(qualifiedToolName('sco_build_cube'))).toBe(false);
  });
});
