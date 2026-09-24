// backend/test/unit/chart-spec-advisor.test.ts
import { describe, it, expect } from 'vitest';
import { LlmAuditAdvisor } from '../../src/dashboard/chart-spec-advisor.js';
import { CAPABILITY_TYPES } from '../../src/dashboard/chart-type-advisor.js';
import { capabilityFor } from '../../src/dashboard/chart-plan.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';
import type { Env } from '../../src/config/env.js';

const env = { ANTHROPIC_MODEL: 'test' } as unknown as Env;
const data: ChartData = { categories: ['a', 'b'], series: [{ name: 's', data: [1, 2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };

/** A fake query() yielding one result message with the given text. */
function fakeQuery(text: string) {
  return async function* () { yield { type: 'result', result: text } as any; };
}

describe('LlmAuditAdvisor — fallback invariant (never a throw, never a route error)', () => {
  it('a valid gated reply builds that type (fallback:false)', async () => {
    const adv = new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'line' })) as any);
    const r = await adv.advise(data);
    expect(r.type).toBe('line');
    expect(r.fallback).toBe(false);
    expect(r).not.toHaveProperty('spec'); // returns a type decision, not a built spec
  });

  it('malformed JSON → Layer-1b type with fallback:true', async () => {
    const adv = new LlmAuditAdvisor(env, fakeQuery('not json at all') as any);
    const r = await adv.advise(data);
    expect(r.fallback).toBe(true);
    expect(CAPABILITY_TYPES).toContain(r.type);
    expect(r).not.toHaveProperty('spec');
  });

  it('an ungated type → fallback (never emits outside the capability set)', async () => {
    const adv = new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'gantt' })) as any);
    const r = await adv.advise(data);
    expect(r.fallback).toBe(true);
    expect(CAPABILITY_TYPES).toContain(r.type);
  });

  it('an LLM throw → fallback, not a throw', async () => {
    const boom = (async function* () { throw new Error('model down'); }) as any;
    const adv = new LlmAuditAdvisor(env, boom);
    const r = await adv.advise(data);
    expect(r.fallback).toBe(true);
    expect(r).not.toHaveProperty('spec');
  });
});

describe('LlmAuditAdvisor — circuit-breaker signal (unavailable vs answered-badly)', () => {
  it('the LLM CALL THROWING (auth/config/network) sets unavailable:true — the breaker case', async () => {
    const boom = (async function* () { throw new Error('403 The security token included in the request is invalid'); }) as any;
    const r = await new LlmAuditAdvisor(env, boom).advise(data);
    expect(r.fallback).toBe(true);
    expect(r.unavailable).toBe(true); // grey out "Ask AI": the model could not be reached
  });

  it('a model that ANSWERS but unusably (bad JSON) is NOT unavailable — retry may help', async () => {
    const r = await new LlmAuditAdvisor(env, fakeQuery('not json at all') as any).advise(data);
    expect(r.fallback).toBe(true);
    expect(r.unavailable).toBeFalsy(); // the LLM works; it just answered badly this time
  });

  it('a model that proposes an ungated type is NOT unavailable', async () => {
    const r = await new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'gantt' })) as any).advise(data);
    expect(r.fallback).toBe(true);
    expect(r.unavailable).toBeFalsy();
  });

  it('a good reply is neither fallback nor unavailable', async () => {
    const r = await new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'line' })) as any).advise(data);
    expect(r.fallback).toBe(false);
    expect(r.unavailable).toBeFalsy();
  });
});

describe('LlmAuditAdvisor — candidate list is the shape\'s capability set', () => {
  const seriesData: ChartData = { categories: ['N', 'S'], series: [{ name: '24', data: [1, 2] }, { name: '25', data: [3, 4] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Year' } };
  it('a gated-in type not in {bar,line,pie} (e.g. sunburst) is now AI-selectable', async () => {
    expect(capabilityFor(seriesData)).toContain('sunburst');
    const adv = new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'sunburst' })) as any);
    const r = await adv.advise(seriesData);
    expect(r.type).toBe('sunburst');
    expect(r.fallback).toBe(false);
  });
  it('a type NOT in the shape\'s capability set still falls back to rec (never throws)', async () => {
    const adv = new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'bullet' })) as any);
    const r = await adv.advise(seriesData); // seriesData has no bullet capability
    expect(r.fallback).toBe(true);
    expect(CAPABILITY_TYPES).toContain(r.type);
  });

  it('funnel + bubbleHeatmap are AI-selectable exactly when capabilityFor offers them', async () => {
    const twoSeries: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'x', data: [1, 2, 3] }, { name: 'y', data: [4, 5, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', seriesDimensionName: 'R' } };
    expect(capabilityFor(twoSeries)).toContain('bubbleHeatmap');
    const rh = await new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'bubbleHeatmap' })) as any).advise(twoSeries);
    expect(rh.type).toBe('bubbleHeatmap');
    expect(rh.fallback).toBe(false);

    const oneSeries: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'x', data: [3, 8, 2] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };
    expect(capabilityFor(oneSeries)).toContain('funnel');
    const rf = await new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'funnel' })) as any).advise(oneSeries);
    expect(rf.type).toBe('funnel');
    expect(rf.fallback).toBe(false);
  });

  it('bubble is AI-selectable when the data carries points', async () => {
    const withPoints: ChartData = {
      categories: ['A', 'B'], series: [{ name: 'x', data: [1, 4] }, { name: 'y', data: [2, 5] }],
      points: [{ x: 1, y: 2, size: 10, label: 'A' }, { x: 4, y: 5, size: 20, label: 'B' }],
      meta: { truncated: false, shown: 2, dimensionKind: 'categorical' },
    };
    expect(capabilityFor(withPoints)).toContain('bubble');
    const rb = await new LlmAuditAdvisor(env, fakeQuery(JSON.stringify({ type: 'bubble' })) as any).advise(withPoints);
    expect(rb.type).toBe('bubble');
    expect(rb.fallback).toBe(false);
  });
});
