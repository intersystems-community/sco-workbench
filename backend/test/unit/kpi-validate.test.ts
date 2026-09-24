/**
 * KPI validate-before-create matrix (KI1–KI6): every `validateForCreate` branch
 * exercised through the `sco_create_kpi` tool handler, asserting it fails with
 * the exact message BEFORE any REST call. Complements the live kpi-invalid.it
 * suite (MDX/runtime/duplicate cases that only IRIS can produce).
 */
import { describe, it, expect } from 'vitest';
import { kpiTools } from '../../src/tools/kpi-tools.js';
import type { IrisServices } from '../../src/iris/index.js';

/** A KpiRestClient-only fake; validation must trip before it's ever used. */
function fakeServices(): IrisServices {
  return {
    kpi: {
      create: async () => {
        throw new Error('REST create should not be reached when validation fails');
      },
    },
    namespace: 'SC',
  } as unknown as IrisServices;
}

/** Invoke sco_create_kpi and return the parsed tool payload. */
async function create(def: unknown): Promise<{ ok: boolean; error?: string }> {
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response('{}');
  }) as typeof fetch;
  try {
    const tool = kpiTools(fakeServices()).find((t) => t.name === 'sco_create_kpi')!;
    const res = await tool.handler({ definition: def } as never, undefined as never);
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    // No REST call may happen for a validation failure.
    if (!payload.ok) expect(fetched).toBe(false);
    return payload;
  } finally {
    globalThis.fetch = original;
  }
}

describe('validateForCreate matrix (via sco_create_kpi)', () => {
  it('KI1: blank name', async () => {
    const p = await create({ name: '', type: 'DeepSee', deepseeKpiSpec: { cube: 'C', valueType: 'raw', kpiConditions: ['x'] } });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/`name` is required/);
  });

  it('KI2: DeepSee with no deepseeKpiSpec', async () => {
    const p = await create({ name: 'K', type: 'DeepSee' });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/requires a `deepseeKpiSpec`/);
  });

  it('KI3: blank cube', async () => {
    const p = await create({ name: 'K', type: 'DeepSee', deepseeKpiSpec: { cube: '', valueType: 'raw', kpiConditions: ['x'] } });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/`deepseeKpiSpec\.cube` is required/);
  });

  it('KI4: missing valueType', async () => {
    const p = await create({ name: 'K', type: 'DeepSee', deepseeKpiSpec: { cube: 'C', kpiConditions: ['x'] } });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/`deepseeKpiSpec\.valueType` is required/);
  });

  it('KI5: empty kpiConditions', async () => {
    const p = await create({ name: 'K', type: 'DeepSee', deepseeKpiSpec: { cube: 'C', valueType: 'raw' } });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/at least one `deepseeKpiSpec\.kpiConditions`/);
  });

  it('KI6: percentage with no baseConditions', async () => {
    const p = await create({
      name: 'K',
      type: 'DeepSee',
      deepseeKpiSpec: { cube: 'C', valueType: 'percentage', kpiConditions: ['x'] },
    });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/percentage KPI needs at least one `deepseeKpiSpec\.baseConditions`/);
  });
});
