import { CAPABILITY_TYPES } from './chart-capability';
import { CHART_TYPE_LABELS, CHART_TYPE_HELP, CHART_TYPE_REQUIREMENT, chartTypeLabel, chartTypeHelp, chartTypeRequirement, disabledTypeLabel } from './chart-type-labels';

describe('chart-type labels (Change 4)', () => {
  it('every capability token has a human label and help — in lockstep with CAPABILITY_TYPES', () => {
    for (const t of CAPABILITY_TYPES) {
      expect(CHART_TYPE_LABELS[t], `label missing for ${t}`).toBeTruthy();
      expect(CHART_TYPE_HELP[t], `help missing for ${t}`).toBeTruthy();
    }
    // No stray labels beyond the allow-list (map and allow-list stay in lockstep).
    expect(Object.keys(CHART_TYPE_LABELS).sort()).toEqual([...CAPABILITY_TYPES].sort());
  });

  it('maps the known tokens to the specified human labels', () => {
    expect(chartTypeLabel('bar')).toBe('Bar');
    expect(chartTypeLabel('solidgauge')).toBe('Gauge');
    expect(chartTypeLabel('dumbbell')).toBe('Dumbbell');
    expect(chartTypeLabel('treemap')).toBe('Treemap');
  });

  it('maps sankey to its honest label/help/requirement (never says "flow of")', () => {
    expect(chartTypeLabel('sankey')).toBe('Sankey');
    expect(chartTypeHelp('sankey')).toBe('Sankey — how a measure splits across two categories');
    expect(chartTypeRequirement('sankey')).toBe('two or more categories and a second dimension of non-negative series');
    expect(chartTypeHelp('sankey').toLowerCase()).not.toContain('flow of');
  });

  it('returns the raw token unchanged for an unmapped value (never throws)', () => {
    expect(chartTypeLabel('mystery')).toBe('mystery');
    expect(chartTypeHelp('mystery')).toBe('');
  });

  it('help text is a one-line "good for" phrase', () => {
    expect(chartTypeHelp('treemap')).toBe('Treemap — part-to-whole by size');
    expect(chartTypeHelp('line')).toBe('Line — change over time');
    expect(chartTypeHelp('slope')).toBe('Slope — how a value changes between two points in time.');
  });
});

describe('chart-type requirement text (grayed-out dropdown reason)', () => {
  it('every capability token has a requirement phrase — in lockstep with CAPABILITY_TYPES', () => {
    for (const t of CAPABILITY_TYPES) {
      expect(CHART_TYPE_REQUIREMENT[t], `requirement missing for ${t}`).toBeTruthy();
    }
    expect(Object.keys(CHART_TYPE_REQUIREMENT).sort()).toEqual([...CAPABILITY_TYPES].sort());
  });

  it('the requirement names WHAT THE TYPE NEEDS, phrased to follow "needs"', () => {
    // The reason answers "why can't I pick this?" with the data condition the type requires.
    expect(chartTypeRequirement('solidgauge')).toBe('a single value');
    expect(chartTypeRequirement('pie')).toBe('one non-negative series');
    expect(chartTypeRequirement('dumbbell')).toBe('exactly two series');
    expect(chartTypeRequirement('slope')).toBe('exactly two categories');
    expect(chartTypeRequirement('sunburst')).toBe('a second dimension to nest');
    expect(chartTypeRequirement('bullet')).toBe('a target and quality bands');
  });

  it('returns an empty requirement for an unmapped token (never throws)', () => {
    expect(chartTypeRequirement('mystery')).toBe('');
  });

  it('disabledTypeLabel appends "(needs …)" to the human label', () => {
    expect(disabledTypeLabel('solidgauge')).toBe('Gauge (needs a single value)');
    expect(disabledTypeLabel('slope')).toBe('Slope (needs exactly two categories)');
    expect(disabledTypeLabel('dumbbell')).toBe('Dumbbell (needs exactly two series)');
  });

  it('disabledTypeLabel falls back to the bare label when a token has no requirement', () => {
    // An unknown token has no requirement phrase; the label is shown without a paren-clause
    // rather than a dangling "(needs )".
    expect(disabledTypeLabel('mystery')).toBe('mystery');
  });
});
