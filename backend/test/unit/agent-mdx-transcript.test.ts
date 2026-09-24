/**
 * C18 / SC-2715 — Option 1 (agent scenario A1): the golden `deepseeKpiSpec` a
 * competent agent would emit for "create a KPI counting Open issues" clears the
 * `sco_create_kpi` create-gate (`validateForCreate`, kpi-tools.ts:157) and reaches
 * the REST create. Driven through the PUBLIC tool handler — no test-only production
 * surface — exactly as kpi-validate.test.ts:23-40 does. A GUARD case (empty
 * kpiConditions) proves the accept is not vacuous: it is rejected before REST.
 *
 * The scenario table is the shared JSON single source of truth, read as data by
 * this backend test, the frontend guided spec, and the live Option 2 eval; imported
 * as code by none (byte-mirror cross-workspace discipline, spec §3).
 */
import { describe, it, expect } from 'vitest';
import scenarios from '../../../test/fixtures/agent-mdx-scenarios.json' with { type: 'json' };
import { kpiTools } from '../../src/tools/kpi-tools.js';
import type { IrisServices } from '../../src/iris/index.js';

interface Scenario {
  id: string;
  mode: 'guided' | 'agent';
  userPrompt: string;
  cube: string;
  expected: {
    toolPath: string;
    conditionMdx?: string;
    resolvesTo?: string;
    landing: 'applied' | 'rejected';
    deepseeKpiSpec?: {
      cube: string;
      valueType: 'raw' | 'percentage';
      kpiMeasure?: string;
      kpiConditions?: string[];
      baseConditions?: string[];
    };
  };
}

const A1 = (scenarios as Scenario[]).find((s) => s.id === 'A1')!;

// An IRIS fake whose kpi.create ECHOES the definition back (a valid create response
// carries a name). The create-gate (validateForCreate, kpi-tools.ts:157) runs BEFORE
// kpi.create; a rejected spec never reaches it. `createCalls` records whether create
// was reached, so the GUARD case can prove the reject fired pre-REST. Same public-handler
// approach kpi-validate.test.ts uses (kpi-validate.test.ts:12,23-40); the fake replaces
// the whole `kpi` service, so no global `fetch` is involved.
function fakeServices(calls: { create: number }): IrisServices {
  return {
    kpi: {
      create: async (def: { name: string }) => {
        calls.create++;
        return def;
      },
    },
    namespace: 'SC',
  } as unknown as IrisServices;
}

// Drive sco_create_kpi through its PUBLIC handler (no test-only production surface).
async function create(
  def: unknown,
): Promise<{ payload: { ok: boolean; error?: string }; createCalls: number }> {
  const calls = { create: 0 };
  const tool = kpiTools(fakeServices(calls)).find((t) => t.name === 'sco_create_kpi')!;
  const res = await tool.handler({ definition: def } as never, undefined as never);
  return {
    payload: JSON.parse((res.content[0] as { text: string }).text),
    createCalls: calls.create,
  };
}

describe('C18 Option 1 (agent A1): golden sco_create_kpi spec clears the create-gate', () => {
  it('the fixture carries A1 as an agent-mode sco_create_kpi scenario', () => {
    expect(A1).toBeDefined();
    expect(A1.mode).toBe('agent');
    expect(A1.expected.toolPath).toBe('sco_create_kpi');
    expect(A1.expected.landing).toBe('applied');
    expect(A1.expected.deepseeKpiSpec).toBeDefined();
  });

  it('accepts A1 golden deepseeKpiSpec (create-gate passes; create reached, no validation error)', async () => {
    const { payload, createCalls } = await create({
      name: 'C18_A1_OpenIssues',
      type: 'DeepSee',
      deepseeKpiSpec: A1.expected.deepseeKpiSpec,
    });
    expect(payload.ok).toBe(true);
    expect(payload.error).toBeUndefined();
    expect(createCalls).toBe(1); // gate passed → the create call was reached
  });

  it('GUARD: A1 with empty kpiConditions is REJECTED before REST (proves the accept is not vacuous)', async () => {
    const spec = { ...A1.expected.deepseeKpiSpec!, kpiConditions: [] };
    const { payload, createCalls } = await create({
      name: 'C18_A1_Bad',
      type: 'DeepSee',
      deepseeKpiSpec: spec,
    });
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/kpiConditions/);
    expect(createCalls).toBe(0); // rejected pre-REST — create never reached
  });
});
