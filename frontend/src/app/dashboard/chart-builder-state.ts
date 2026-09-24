// frontend/src/app/dashboard/chart-builder-state.ts
import type { ChartSpecResponse } from './services/dashboard-chart.service';

/** The chart-type override + AI toggle the shared preview owns (spec §5.3). Source is
 *  no longer part of builder state — the mounted component (cube vs kpi builder) IS the
 *  source. `layer`/`fallback`/`reason` were dropped: no live caller read them (the
 *  why-lines read the rendered spec, not this state). */
export interface BuilderState {
  typeOverride: string | null;
  useAi: boolean;
}

export function initialBuilderState(): BuilderState {
  return { typeOverride: null, useAi: false };
}
export function onTypeOverride(s: BuilderState, type: string): BuilderState {
  return { ...s, typeOverride: type };
}
export function onAiToggle(s: BuilderState, on: boolean): BuilderState {
  return { ...s, useAi: on };
}

/**
 * A plain-language provenance line for the chart, replacing the "bar · layer 1b ·
 * matrix" internal jargon (a Gulf-of-Evaluation gap: the layer/source names are
 * implementation vocabulary the user cannot decode). Answers "why this chart?" in
 * the user's terms: who chose the type. Trust calibration (Lee & See): the user
 * should see whether a chart is their pick, a deterministic recommendation, or an
 * AI suggestion — the AI case is named so an AI-derived choice is never mistaken
 * for a deterministic one. `fallback` is surfaced separately by the panel's note.
 */
export function whyLabel(resp: Pick<ChartSpecResponse, 'type' | 'layer' | 'fallback'>): string {
  const type = resp.type.charAt(0).toUpperCase() + resp.type.slice(1);
  if (resp.layer === '2' && !resp.fallback) return `${type} · suggested by AI`;
  if (resp.layer === '1a') return `${type} · your choice`;
  return `${type} · recommended for this data`;
}

/**
 * One plain-language sentence explaining WHY the deterministic advisor recommended
 * this chart type (Change 10 / T1) — trust calibration (Lee & See) + ecological
 * interface design (make the work-domain constraint that drove the pick visible).
 * Only the recommendation case (layer 1b) gets a sentence; an explicit override (1a)
 * or an AI pick (2) returns '' (their `whyLabel` already says "your choice" /
 * "suggested by AI"). Honesty guard: a `shape-default` source is phrased as a
 * dependable default, never "best for", and WINS over the intent map — we never dress
 * a fallback up as a clever pick. Pure; presentation, so it lives beside `whyLabel`.
 */
export function whyExplanation(resp: Pick<ChartSpecResponse, 'layer' | 'source' | 'intent' | 'type'>): string {
  if (resp.layer !== '1b') return '';
  // Honesty guard first: a shape-default is a fallback, not a matrix-matched pick. The advisor's
  // orientation heuristic (spec §4) can make this a column instead of a bar, so phrase it to match.
  if (resp.source === 'shape-default') {
    return resp.type === 'column'
      ? 'A column is the dependable default for comparing a few categories.'
      : 'A bar is the dependable default for comparing categories.';
  }
  // Signal-driven new types explain themselves by type (the signal, not the intent, drove the pick).
  switch (resp.type) {
    case 'slope': return 'Two points in time, so a slope makes the change between them the story.';
    case 'stackedColumn': case 'stackedArea': return 'The series are parts of one measure, so stacking shows both the parts and their total.';
    case 'bullet': return 'A value with a target and quality bands, which a bullet reads against its goal at a glance.';
    case 'divergingBar': return 'Values sit above and below a baseline, so a diverging bar shows direction and size together.';
  }
  switch (resp.intent) {
    case 'trend': return 'Your data is a time series, so a line shows how the value moves over time.';
    case 'compare-two': return "You're comparing exactly two series — a dumbbell puts the gap between them front and centre.";
    case 'single-value': return 'A single value against its whole, which a gauge reads at a glance.';
    case 'composition': return 'These are parts of a whole, so a pie shows each share.';
    case 'correlation': return 'Two measures plotted against each other, so a scatter shows how they relate.';
    default: return '';
  }
}
