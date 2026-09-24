// backend/src/dashboard/chart-spec-advisor.ts
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { runOneShot, type QueryFn } from '../agent/agent.js';
import { recommend, CAPABILITY_TYPES } from './chart-type-advisor.js';
import { capabilityFor } from './chart-plan.js';
import type { ChartData, ChartSpecAdvisor, ChartTypeAdvice, ChartType } from './chart-data.js';

const replySchema = z.object({ type: z.enum(CAPABILITY_TYPES as unknown as [ChartType, ...ChartType[]]) });

/** Extract the first {...} block, tolerant of stray prose (as auto-map does). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no json');
  return JSON.parse(text.slice(start, end + 1));
}

function candidateList(data: ChartData): ChartType[] {
  // The safe set is every type actually BUILDABLE for this shape, plus the deterministic
  // rec (always present). Radar/sunburst become AI-reachable exactly when their shape
  // gates pass; every candidate is guaranteed to build. (spec §Layer-2, CTE-SPEC-02.)
  const rec = recommend(data).type;
  return Array.from(new Set<ChartType>([rec, ...capabilityFor(data)]));
}

/**
 * Layer 2 — AI ceiling. Same "AI proposes within an enumerated safe set,
 * deterministic layer decides" pattern as auto-map. On ANY failure (LLM error,
 * invalid JSON, schema miss, ungated type) it falls back to Layer 1b's type and
 * returns { fallback:true, reason }. It NEVER throws and NEVER emits outside
 * CAPABILITY_TYPES. It returns only a chart-type DECISION — the route negotiates a
 * renderer and builds the spec, so the advisor stays renderer-agnostic.
 */
export class LlmAuditAdvisor implements ChartSpecAdvisor {
  constructor(private readonly env: Env, private readonly queryImpl?: QueryFn) {}

  async advise(data: ChartData, prompt?: string): Promise<ChartTypeAdvice> {
    const candidates = candidateList(data);
    // `unavailable` distinguishes an OUTAGE (the call threw — auth/config/network,
    // the circuit-breaker case) from a model that answered but unusably (bad JSON /
    // ungated type — a normal fallback, retry may help). The FE greys out "Ask AI"
    // only on `unavailable`.
    const fallback = (reason: string, unavailable = false): ChartTypeAdvice => {
      return { type: recommend(data).type, fallback: true, reason, unavailable };
    };
    let text: string;
    try {
      text = await runOneShot(this.env, buildPrompt(data, candidates, prompt), this.queryImpl);
    } catch (err) {
      return fallback(err instanceof Error ? err.message : 'The chart advisor was unavailable.', true);
    }
    try {
      const { type } = replySchema.parse(extractJson(text));
      if (!candidates.includes(type)) return fallback(`Model proposed ${type}, not among the candidates.`);
      return { type, fallback: false };
    } catch {
      return fallback('Could not parse a chart type from the model response.');
    }
  }
}

function buildPrompt(data: ChartData, candidates: ChartType[], userPrompt?: string): string {
  return [
    'Choose the single best chart type for this data from the allowed list ONLY.',
    `Allowed types: ${candidates.join(', ')}.`,
    `Data shape: ${data.series.length} series over ${data.categories.length} categories, axis kind ${data.meta.dimensionKind}.`,
    userPrompt ? `User hint: ${userPrompt}` : '',
    'Respond with ONLY JSON: {"type":"<one of the allowed types>"}.',
  ].filter(Boolean).join('\n');
}
