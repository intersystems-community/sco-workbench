// frontend/src/app/dashboard/chart-builder-state.spec.ts
import { initialBuilderState, onTypeOverride, onAiToggle, whyLabel, whyExplanation } from './chart-builder-state';

describe('chart-builder-state (pure)', () => {
  it('the AI toggle flips useAi', () => {
    const s = onAiToggle(initialBuilderState(), true);
    expect(s.useAi).toBe(true);
  });
});

describe('whyLabel — plain-language provenance (no "layer 1b" jargon)', () => {
  it('never leaks the internal "layer" / "matrix" vocabulary', () => {
    for (const layer of ['1a', '1b', '2'] as const) {
      const label = whyLabel({ type: 'bar', layer, fallback: false });
      expect(label).not.toMatch(/layer|matrix|shape-default/i);
    }
  });

  it('an explicit user choice (1a) reads "your choice"', () => {
    expect(whyLabel({ type: 'pie', layer: '1a', fallback: false })).toBe('Pie · your choice');
  });

  it('a deterministic recommendation (1b) reads "recommended for this data"', () => {
    expect(whyLabel({ type: 'bar', layer: '1b', fallback: false })).toBe('Bar · recommended for this data');
  });

  it('a successful AI suggestion (2, no fallback) is NAMED as AI (trust calibration)', () => {
    expect(whyLabel({ type: 'line', layer: '2', fallback: false })).toBe('Line · suggested by AI');
  });

  it('an AI fallback (2 + fallback) reads as a recommendation, not an AI suggestion', () => {
    // The model was asked but its answer was unusable → a recommended chart is what
    // actually drew, so it must NOT claim to be "suggested by AI".
    expect(whyLabel({ type: 'bar', layer: '2', fallback: true })).toBe('Bar · recommended for this data');
  });
});

describe('whyExplanation (Change 10 / T1)', () => {
  const rec = (intent: string | undefined, source: 'matrix' | 'shape-default' | undefined, type = 'bar') =>
    ({ layer: '1b' as const, intent, source, type });

  it('maps each matrix intent to its educational sentence', () => {
    expect(whyExplanation(rec('trend', 'matrix')))
      .toBe('Your data is a time series, so a line shows how the value moves over time.');
    expect(whyExplanation(rec('compare-two', 'matrix')))
      .toBe('You\'re comparing exactly two series — a dumbbell puts the gap between them front and centre.');
    expect(whyExplanation(rec('single-value', 'matrix')))
      .toBe('A single value against its whole, which a gauge reads at a glance.');
    expect(whyExplanation(rec('composition', 'matrix')))
      .toBe('These are parts of a whole, so a pie shows each share.');
    expect(whyExplanation(rec('correlation', 'matrix')))
      .toBe('Two measures plotted against each other, so a scatter shows how they relate.');
  });

  it('honesty guard: a shape-default source returns the "dependable default" sentence, orientation-aware', () => {
    // Bar side (unchanged).
    expect(whyExplanation(rec('comparison', 'shape-default', 'bar')))
      .toBe('A bar is the dependable default for comparing categories.');
    // Column side (the orientation heuristic — a shape-default CAN now be a column).
    expect(whyExplanation(rec('comparison', 'shape-default', 'column')))
      .toBe('A column is the dependable default for comparing a few categories.');
    // Guard STILL WINS over the intent map even if an intent is somehow present.
    expect(whyExplanation(rec('trend', 'shape-default', 'bar')))
      .toBe('A bar is the dependable default for comparing categories.');
  });

  it('returns no sentence for an explicit override (1a) or an AI pick (2)', () => {
    expect(whyExplanation({ layer: '1a', intent: undefined, source: undefined, type: 'bar' })).toBe('');
    expect(whyExplanation({ layer: '2', intent: undefined, source: undefined, type: 'bar' })).toBe('');
  });

  it('returns no sentence when the layer is 1b but no intent/source is present (nothing to explain)', () => {
    expect(whyExplanation({ layer: '1b', intent: undefined, source: undefined, type: 'bar' })).toBe('');
  });

  it('slope type returns the slope-specific sentence', () => {
    expect(whyExplanation({ layer: '1b', source: 'matrix', intent: 'trend', type: 'slope' }))
      .toBe('Two points in time, so a slope makes the change between them the story.');
  });

  it('stackedColumn and stackedArea return the stacking sentence', () => {
    expect(whyExplanation({ layer: '1b', source: 'matrix', intent: undefined, type: 'stackedColumn' }))
      .toBe('The series are parts of one measure, so stacking shows both the parts and their total.');
    expect(whyExplanation({ layer: '1b', source: 'matrix', intent: undefined, type: 'stackedArea' }))
      .toBe('The series are parts of one measure, so stacking shows both the parts and their total.');
  });

  it('bullet type returns the bullet-specific sentence', () => {
    expect(whyExplanation({ layer: '1b', source: 'matrix', intent: undefined, type: 'bullet' }))
      .toBe('A value with a target and quality bands, which a bullet reads against its goal at a glance.');
  });

  it('divergingBar type returns the diverging-bar sentence', () => {
    expect(whyExplanation({ layer: '1b', source: 'matrix', intent: undefined, type: 'divergingBar' }))
      .toBe('Values sit above and below a baseline, so a diverging bar shows direction and size together.');
  });
});
