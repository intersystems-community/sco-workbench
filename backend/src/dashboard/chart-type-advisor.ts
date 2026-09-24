// backend/src/dashboard/chart-type-advisor.ts
import type { ChartData, ChartType } from './chart-data.js';

/**
 * Deterministic Layer-1b advisor. Pure function of the fields ChartData already
 * carries — NO LLM, NO network. Transcribed from the chart-choice-audit selection
 * matrix (which lives in a user-level skill, not this repo); this transcription is
 * the durable artifact, filtered through CAPABILITY_TYPES so only Highcharts-
 * renderable types survive. See the D2/D3 design doc §1.
 *
 * It derives its own intent from the data when none is passed (the ordinary cube
 * case, which supplies no explicit intent), then maps (intent, shape) → type.
 * Where a matrix cell is populated AND the type is renderable, it returns that type
 * tagged `matrix`; where the cell is empty it returns a safe `shape-default` — so
 * there is NEVER a silent gap. It never guesses temporal: unknown → categorical.
 */

/** The types the vendored Highcharts bundle can render (capability-gated). */
export const CAPABILITY_TYPES = [
  'bar', 'column', 'line', 'area', 'pie',
  'scatter', 'heatmap', 'treemap', 'dumbbell', 'solidgauge',
  'stackedColumn', 'stackedArea', 'stackedColumn100',
  'radar', 'divergingBar', 'slope', 'bullet', 'sunburst', 'bubble', 'funnel', 'bubbleHeatmap', 'sankey',
] as const satisfies readonly ChartType[];

export type ChartIntent =
  | 'trend' | 'compare-two' | 'composition' | 'comparison' | 'single-value' | 'correlation';

/** Small-slice ceiling above which a pie is unreadable → treemap/bar instead. */
const PIE_SLICE_CEILING = 8;

/** Orientation heuristic (spec §4, NOT matrix-sourced — Kirk treats bar/column as one type).
 *  A vertical column reads better than a horizontal bar only for a FEW, SHORT-labelled
 *  categories; beyond either bound a horizontal bar reads better (wide rows, un-rotated labels). */
const COLUMN_MAX_CATEGORIES = 7;
const COLUMN_MAX_LABEL = 10;

export interface Recommendation { type: ChartType; source: 'matrix' | 'shape-default'; intent: ChartIntent }

/**
 * Derive analytic intent from the data alone (the no-explicit-intent cube case).
 * NB: 'composition' is NEVER auto-derived — a pie/treemap is truthful only when
 * its slices are mutually-exclusive parts of a whole, which the data shape alone
 * cannot establish, so composition is reachable only via an explicit `intent`
 * (Layer 2 / a future UI). A lone measure over categories → bar, the honest
 * not-better-than-IRIS default (spec §1 'Honest scope'). Dumbbell fires only for
 * EXACTLY two series over shared categories; three-plus series is a grouped bar.
 */
function deriveIntent(data: ChartData): ChartIntent {
  const dk = data.meta.dimensionKind;
  if (dk === 'temporal') return 'trend';
  if (dk === 'scalar') return 'single-value';
  // categorical from here — key on series count only; never guess composition.
  if (data.series.length === 2) return 'compare-two';
  return 'comparison';
}

/** The transcribed matrix: (intent, shape) → the better-than-IRIS type, or undefined. */
function matrixType(intent: ChartIntent, data: ChartData): ChartType | undefined {
  switch (intent) {
    case 'trend': return 'line';
    case 'single-value': return 'solidgauge';
    case 'compare-two': return 'dumbbell';
    case 'composition':
      return data.categories.length > PIE_SLICE_CEILING ? 'treemap' : 'pie';
    case 'correlation': return 'scatter';
    case 'comparison': return undefined; // no better-than-bar answer → shape-default
  }
}

/**
 * The safe fallback when the matrix cell is empty. A bar reads truthfully for one
 * series, many categories, or many series (grouped/stacked) alike — so the honest
 * no-silent-gap default is always a bar.
 */
const SHAPE_DEFAULT: ChartType = 'bar';

/**
 * Does this comparison shape read better as vertical columns than horizontal bars?
 * A property of the CATEGORY AXIS — series count is irrelevant, so this is uniform
 * across one-series and grouped multi-series (spec §4). Empty categories → false FIRST:
 * Math.max(...[]) is -Infinity (≤ COLUMN_MAX_LABEL) and 0 ≤ COLUMN_MAX_CATEGORIES, so
 * without the guard both bounds pass vacuously and an empty axis would prefer column.
 */
function prefersColumn(data: ChartData): boolean {
  if (data.categories.length === 0) return false;
  if (data.categories.length > COLUMN_MAX_CATEGORIES) return false;
  const longest = Math.max(...data.categories.map((c) => c.length));
  return longest <= COLUMN_MAX_LABEL;
}

/** Structural signals that PIN a type down (derivable). Returns a matrix-tagged
 *  recommendation, or null to fall through to intent derivation. Precedence is
 *  explicit and test-locked (spec §Advisor): bullet, slope, stacked, divergingBar. */
function signalType(data: ChartData): ChartType | null {
  const m = data.meta;
  const neg = data.series.some((s) => s.data.some((v) => v !== null && v < 0));
  // (1) single value + target + bands → bullet (default-flip from solidgauge, intended) — EXCEPT a
  //     PERCENTAGE KPI, which renders as the full-circle ring (its bands drawn as a zone arc on the
  //     ring), not a bullet. The ring is the delegated Track-C selection (ring-always + band arcs).
  if (data.series.length === 1 && data.series[0]!.data.length === 1 && m.target != null && m.bands?.length && m.unit !== 'percent') return 'bullet';
  // (2) two points on a TEMPORAL axis → slope; a nominal pair falls through to the bar default
  // (ChartData carries no ordered-categorical signal, so temporal is the only ordering we trust).
  if (data.categories.length === 2 && m.dimensionKind === 'temporal') return 'slope';
  // (3) homogeneous non-negative series → stacked (area when temporal).
  if (m.seriesDimensionName && data.series.length >= 2 && !neg) {
    return m.dimensionKind === 'temporal' ? 'stackedArea' : 'stackedColumn';
  }
  // (4) categorical + negative → divergingBar.
  if (m.dimensionKind === 'categorical' && neg) return 'divergingBar';
  return null;
}

export function recommend(data: ChartData, intent?: ChartIntent): Recommendation {
  // Signal checks run BEFORE intent derivation, only when no explicit intent is given
  // (an explicit intent is a caller decision the signals must not override).
  if (!intent) {
    const sig = signalType(data);
    if (sig && (CAPABILITY_TYPES as readonly ChartType[]).includes(sig)) {
      return { type: sig, source: 'matrix', intent: deriveIntent(data) };
    }
  }
  const derived = intent ?? deriveIntent(data);
  const m = matrixType(derived, data);
  if (m && (CAPABILITY_TYPES as readonly ChartType[]).includes(m)) {
    return { type: m, source: 'matrix', intent: derived };
  }
  const fallbackType: ChartType = prefersColumn(data) ? 'column' : SHAPE_DEFAULT;
  return { type: fallbackType, source: 'shape-default', intent: derived };
}
