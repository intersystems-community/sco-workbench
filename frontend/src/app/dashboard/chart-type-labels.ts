// frontend/src/app/dashboard/chart-type-labels.ts
//
// Human-readable chart-type labels (Change 4 / H2). The chart-type <select> value
// stays the raw Highcharts token the backend expects; only the DISPLAYED text is
// de-jargoned. Kept beside chart-capability.ts so it stays in lockstep with
// CAPABILITY_TYPES — the spec test fails if a capability token has no label/help.
import { CAPABILITY_TYPES, type ChartType } from './chart-capability';

/** Token → the word a user reads in the dropdown. */
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  column: 'Column',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  scatter: 'Scatter',
  heatmap: 'Heatmap',
  treemap: 'Treemap',
  dumbbell: 'Dumbbell',
  solidgauge: 'Gauge',
  stackedColumn: 'Stacked Column',
  stackedArea: 'Stacked Area',
  stackedColumn100: '100% Stacked Column',
  radar: 'Radar',
  divergingBar: 'Diverging Bar',
  slope: 'Slope',
  bullet: 'Bullet',
  sunburst: 'Sunburst',
  bubble: 'Bubble',
  funnel: 'Funnel',
  bubbleHeatmap: 'Bubble Heatmap',
  sankey: 'Sankey',
};

/** Token → a one-line "what it's good for", shown as the option's native title. */
export const CHART_TYPE_HELP: Record<ChartType, string> = {
  bar: 'Bar — compare categories',
  column: 'Column — compare categories vertically',
  line: 'Line — change over time',
  area: 'Area — cumulative change over time',
  pie: 'Pie — parts of a whole',
  scatter: 'Scatter — relationship between two measures',
  heatmap: 'Heatmap — density across two dimensions',
  treemap: 'Treemap — part-to-whole by size',
  dumbbell: 'Dumbbell — the gap between two series',
  solidgauge: 'Gauge — a single value against its whole',
  stackedColumn: 'Stacked Column — parts building to a total per category',
  stackedArea: 'Stacked Area — parts building to a total over time',
  stackedColumn100: '100% Stacked Column — each category\'s share of its whole',
  radar: 'Radar — compare several measures at a glance',
  divergingBar: 'Diverging Bar — values above and below a baseline',
  slope: 'Slope — how a value changes between two points in time.',
  bullet: 'Bullet — a value against its target and quality bands',
  sunburst: 'Sunburst — nested parts of a whole',
  bubble: 'Bubble — relationship between two measures, sized by a third',
  funnel: 'Funnel — stages narrowing through a process',
  bubbleHeatmap: 'Bubble Heatmap — a grid sized and coloured by value',
  sankey: 'Sankey — how a measure splits across two categories',
};

/**
 * Token → WHAT THE TYPE NEEDS, phrased to follow the word "needs". Shown appended to a
 * DISABLED chart-type option so a grayed-out type explains itself (Norman: a disabled
 * control must say why), mirroring the cube dropdown's "(no measures or dimension)" honesty.
 * Every phrase is the data condition capabilityFor() gates on — kept beside the labels so
 * the lockstep test fails if a capability token gains no requirement. The always-available
 * cartesian family (bar/column/line/area/scatter) still carries a phrase for completeness;
 * in practice those are never disabled (they draw for any non-empty shape).
 */
export const CHART_TYPE_REQUIREMENT: Record<ChartType, string> = {
  bar: 'any category breakdown',
  column: 'any category breakdown',
  line: 'any category breakdown',
  area: 'any category breakdown',
  scatter: 'any category breakdown',
  pie: 'one non-negative series',
  treemap: 'one non-negative series',
  heatmap: 'two or more series',
  dumbbell: 'exactly two series',
  solidgauge: 'a single value',
  stackedColumn: 'a second dimension of non-negative series',
  stackedArea: 'a second dimension over time',
  stackedColumn100: 'a second dimension of untruncated series',
  radar: 'at least three categories',
  divergingBar: 'signed values on a categorical axis',
  slope: 'exactly two categories',
  bullet: 'a target and quality bands',
  sunburst: 'a second dimension to nest',
  bubble: 'two measures (a third or Count sizes the bubbles)',
  funnel: 'one non-negative series',
  bubbleHeatmap: 'two or more non-negative series',
  sankey: 'two or more categories and a second dimension of non-negative series',
};

function isCapabilityType(token: string): token is ChartType {
  return (CAPABILITY_TYPES as readonly string[]).includes(token);
}

/** The human label for a token; the raw token unchanged if it is not in the allow-list. */
export function chartTypeLabel(token: string): string {
  return isCapabilityType(token) ? CHART_TYPE_LABELS[token] : token;
}

/** The one-line help for a token; empty string if the token is not in the allow-list. */
export function chartTypeHelp(token: string): string {
  return isCapabilityType(token) ? CHART_TYPE_HELP[token] : '';
}

/** What a token needs (the "(needs …)" reason); empty string if the token is unmapped. */
export function chartTypeRequirement(token: string): string {
  return isCapabilityType(token) ? CHART_TYPE_REQUIREMENT[token] : '';
}

/**
 * The disabled-option label for an inapplicable chart type: the human label plus the
 * data condition it needs — "Gauge (needs a single value)". Mirrors disabledCubeLabel.
 * Falls back to the bare label when a token has no requirement (never a dangling
 * "(needs )"). Pure — the template calls it declaratively.
 */
export function disabledTypeLabel(token: string): string {
  const label = chartTypeLabel(token);
  const requirement = chartTypeRequirement(token);
  return requirement ? `${label} (needs ${requirement})` : label;
}
