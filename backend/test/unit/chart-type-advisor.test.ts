// backend/test/unit/chart-type-advisor.test.ts
import { describe, it, expect } from 'vitest';
import { recommend, CAPABILITY_TYPES } from '../../src/dashboard/chart-type-advisor.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

function data(dimensionKind: ChartData['meta']['dimensionKind'], seriesCount: number, cats = 3): ChartData {
  return {
    categories: Array.from({ length: cats }, (_, i) => `c${i}`),
    series: Array.from({ length: seriesCount }, (_, i) => ({ name: `s${i}`, data: Array(cats).fill(1) })),
    meta: { truncated: false, shown: cats, dimensionKind },
  };
}

describe('chart-type-advisor — intent derived from data (no explicit intent, the cube case)', () => {
  it('temporal → line (auto-selection; IRIS has line too, the win is picking it up-front)', () => {
    expect(recommend(data('temporal', 1))).toEqual({ type: 'line', source: 'matrix', intent: 'trend' });
  });

  it('scalar (single value, no dimension) → solidgauge', () => {
    const d: ChartData = { categories: [], series: [{ name: 'v', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar' } };
    expect(recommend(d)).toEqual({ type: 'solidgauge', source: 'matrix', intent: 'single-value' });
  });

  it('categorical + EXACTLY two series over shared categories → dumbbell (better-than-IRIS)', () => {
    expect(recommend(data('categorical', 2))).toEqual({ type: 'dumbbell', source: 'matrix', intent: 'compare-two' });
  });

  it('categorical + one series, few short labels → column (orientation heuristic; bar for many/long)', () => {
    // 4 categories, labels c0..c3 (2 chars) — few AND short — reads better as vertical columns.
    // Was bar under the orientation-agnostic default; the heuristic flips it (spec §4). The
    // advisor still does NOT guess composition/pie from a one-series shape (spec §1).
    const r = recommend(data('categorical', 1, 4));
    expect(r).toEqual({ type: 'column', source: 'shape-default', intent: 'comparison' });
  });

  it('composition is reached ONLY via explicit intent → pie (small slice count), tagged matrix', () => {
    expect(recommend(data('categorical', 1, 3), 'composition')).toEqual({ type: 'pie', source: 'matrix', intent: 'composition' });
  });

  it('explicit composition intent + many categories → treemap (above the slice ceiling)', () => {
    expect(recommend(data('categorical', 1, 20), 'composition')).toEqual({ type: 'treemap', source: 'matrix', intent: 'composition' });
  });

  it('an unknown/absent dimension resolves to categorical, NEVER temporal', () => {
    // The no-silent-gap + never-guess-temporal rule, made executable.
    expect(recommend(data('categorical', 1, 2)).type).not.toBe('line');
  });
});

describe('chart-type-advisor — matrix vs shape-default tagging (no silent gap)', () => {
  it('an empty matrix cell returns a tagged shape-default, never nothing', () => {
    // many categories + many series has no better matrix answer → grouped/stacked bar, shape-default.
    const r = recommend(data('categorical', 5, 40));
    expect(r.source).toBe('shape-default');
    expect(r.type).toBe('bar'); // 40 categories fail the orientation count guard → bar (was the loose ['bar','column'] contain)
  });

  it('never returns a type outside the capability allow-list', () => {
    for (const dk of ['temporal', 'categorical', 'scalar'] as const) {
      for (const n of [1, 2, 5]) {
        expect(CAPABILITY_TYPES).toContain(recommend(data(dk, n)).type);
      }
    }
  });

  it('recommend never auto-selects bubble/funnel/bubbleHeatmap (offer-only, spec §Q5)', () => {
    const shapes: ChartData[] = [
      data('categorical', 2, 3),   // two series over 3 cats — bubbleHeatmap is OFFERED here
      data('categorical', 1, 4),   // one series — funnel is OFFERED here
      data('temporal', 3, 5),
      data('categorical', 5, 40),
    ];
    for (const d of shapes) {
      const t = recommend(d).type;
      expect(['bubble', 'funnel', 'bubbleHeatmap']).not.toContain(t);
    }
  });
});

describe('chart-type-advisor — orientation heuristic (column vs bar at the shape-default fallback)', () => {
  // COUNT GUARD: few short → column; many short → bar (labels c0.. are short in both).
  it('few short-labelled categories → column', () => {
    expect(recommend(data('categorical', 1, 5)).type).toBe('column'); // 5 ≤ 7, "c0".."c4" short
  });
  it('many short-labelled categories → bar (count guard)', () => {
    expect(recommend(data('categorical', 1, 12)).type).toBe('bar');   // 12 > 7
  });
  // LENGTH GUARD: few but long labels → bar; few and short → column.
  it('few but long-labelled categories → bar (length guard)', () => {
    const longLabels: ChartData = {
      categories: ['Northwestern Region', 'Southeastern Region', 'Central Distribution'],
      series: [{ name: 'v', data: [1, 2, 3] }],
      meta: { truncated: false, shown: 3, dimensionKind: 'categorical' },
    };
    expect(recommend(longLabels).type).toBe('bar'); // 3 ≤ 7 but labels > 10 chars
  });
  it('few and short-labelled categories → column (both guards satisfied)', () => {
    const shortLabels: ChartData = {
      categories: ['NW', 'SE', 'C'],
      series: [{ name: 'v', data: [1, 2, 3] }],
      meta: { truncated: false, shown: 3, dimensionKind: 'categorical' },
    };
    expect(recommend(shortLabels).type).toBe('column');
  });
  // EMPTY axis → bar (the length===0 guard; never column on an empty axis).
  it('empty categories → bar (empty-axis guard, never column)', () => {
    const empty: ChartData = { categories: [], series: [{ name: 'v', data: [] }], meta: { truncated: false, shown: 0, dimensionKind: 'categorical' } };
    expect(recommend(empty).type).toBe('bar');
  });
  // UNIFORM ACROSS SERIES COUNT: a heterogeneous ≥3-series shape (no seriesDimensionName, so it
  // falls through signalType + matrixType to the fallback) obeys the SAME orientation rule.
  // ≥3 series on purpose: exactly 2 series → compare-two → dumbbell and never reaches the fallback.
  it('heterogeneous multi-series, few short categories → column (uniform across series count)', () => {
    const multiFewShort: ChartData = {
      categories: ['NW', 'SE', 'C'],
      series: [{ name: 'a', data: [1, 2, 3] }, { name: 'b', data: [4, 5, 6] }, { name: 'c', data: [7, 8, 9] }],
      meta: { truncated: false, shown: 3, dimensionKind: 'categorical' },
    };
    expect(recommend(multiFewShort).type).toBe('column');
  });
  it('heterogeneous multi-series, many categories → bar (uniform across series count)', () => {
    const multiMany: ChartData = {
      categories: Array.from({ length: 12 }, (_, i) => `c${i}`),
      series: [{ name: 'a', data: Array(12).fill(1) }, { name: 'b', data: Array(12).fill(2) }, { name: 'c', data: Array(12).fill(3) }],
      meta: { truncated: false, shown: 12, dimensionKind: 'categorical' },
    };
    expect(recommend(multiMany).type).toBe('bar');
  });
  it('orientation rule never overrides a signal/matrix pick (runs only on the bar-default path)', () => {
    // Homogeneous few-short shape → stackedColumn signal fires BEFORE the fallback; must NOT become column.
    const homogeneousFewShort: ChartData = {
      categories: ['NW', 'SE', 'C'],
      series: [{ name: '24', data: [1, 2, 3] }, { name: '25', data: [4, 5, 6] }],
      meta: { truncated: false, shown: 3, dimensionKind: 'categorical', seriesDimensionName: 'Year' },
    };
    expect(recommend(homogeneousFewShort).type).toBe('stackedColumn');
    // Temporal 2-cat → slope (signal), not column. Two-series → dumbbell (matrix), not column.
    const twoCatTemporalShort: ChartData = { categories: ['Q1', 'Q2'], series: [{ name: 'v', data: [3, 8] }], meta: { truncated: false, shown: 2, dimensionKind: 'temporal' } };
    expect(recommend(twoCatTemporalShort).type).toBe('slope');
    expect(recommend(data('categorical', 2, 3)).type).toBe('dumbbell');
  });
});

describe('chart-type-advisor — documented offer-only gaps (deliberate, spec §3)', () => {
  // AREA: single-series-over-time is line, never area (area = an editorial emphasis with no data signal).
  // ≠2 categories on purpose: a temporal 2-cat shape → slope (signal) before matrixType's trend→line cell.
  it('temporal single-series → line, NOT area (area is offer-only)', () => {
    const r = recommend(data('temporal', 1, 5));
    expect(r.type).toBe('line');
    expect(r.type).not.toBe('area');
  });
  // stackedColumn100: the homogeneous matrix is stackedColumn (parts AND total), never 100%-stacked
  // (share-of-whole is analytic intent, not a data shape).
  it('homogeneous matrix → stackedColumn, NOT stackedColumn100 (100%-stacked is offer-only)', () => {
    const homogeneous: ChartData = {
      categories: ['N', 'S', 'E'],
      series: [{ name: '24', data: [1, 2, 3] }, { name: '25', data: [4, 5, 6] }],
      meta: { truncated: false, shown: 3, dimensionKind: 'categorical', seriesDimensionName: 'Year' },
    };
    const r = recommend(homogeneous);
    expect(r.type).toBe('stackedColumn');
    expect(r.type).not.toBe('stackedColumn100');
  });
  // heatmap/bubbleHeatmap: the true matrix shape is stackedColumn (perceptually stronger, preserves the
  // total); heatmap/bubbleHeatmap stay offer-only. The existing offer-only pin (the bubble/funnel/
  // bubbleHeatmap test above) already covers bubbleHeatmap — this comment records the disposition (spec §3).
});

describe('chart-type-advisor — signal-based auto-recommend (new precedence)', () => {
  // ≥3 categories on purpose: a TEMPORAL 2-category series (categories.length === 2 && temporal)
  // has HIGHER signal precedence than stacked (spec:303-310 / CONSIDER-08), so it would recommend
  // 'slope', not 'stackedColumn'. (A NOMINAL 2-category homogeneous series now reaches the stacked
  // gate after the D8 narrowing — but this fixture is categorical, so keep ≥3 to exercise stacked
  // unambiguously.) Do NOT shrink this to 2 to "match" a sibling.
  const seriesData: ChartData = { categories: ['N', 'S', 'E'], series: [{ name: '24', data: [1, 2, 3] }, { name: '25', data: [4, 5, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', seriesDimensionName: 'Year' } };
  const nominalTwoCat: ChartData = { categories: ['North', 'South'], series: [{ name: 'A', data: [3, 8] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };
  // before/after order is NOT detectable from ChartData — two nominal categories carry no
  // ordering, so slope's directional claim is unfounded and the predicate keys on temporal.
  const nominalTwoCatNeg: ChartData = { categories: ['North', 'South'], series: [{ name: 'Delta', data: [3, -8] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };
  const twoCatTemporal: ChartData = { ...nominalTwoCat, meta: { ...nominalTwoCat.meta, dimensionKind: 'temporal' } };
  const negCat: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'd', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };
  const bullet: ChartData = { categories: [], series: [{ name: 'Late', data: [7] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' }] } };

  it('(1) a scalar with target+bands auto-recommends bullet — the solidgauge DEFAULT-FLIP (test-locked)', () => {
    expect(recommend(bullet).type).toBe('bullet');
    // and a bare scalar with NO thresholds still recommends solidgauge (flip is thresholds-only).
    const bare: ChartData = { categories: [], series: [{ name: 'v', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar' } };
    expect(recommend(bare).type).toBe('solidgauge');
  });
  it('(1b) a PERCENTAGE scalar with target+bands recommends solidgauge (the ring), NOT bullet', () => {
    // Ring-always + band arcs: a percentage KPI renders as the full-circle ring, its thresholds drawn
    // as a zone arc on the ring — so it must fall THROUGH the bullet flip to single-value → solidgauge.
    const pct: ChartData = { ...bullet, meta: { ...bullet.meta, unit: 'percent' } };
    expect(recommend(pct)).toEqual({ type: 'solidgauge', source: 'matrix', intent: 'single-value' });
    // A percentage scalar WITHOUT thresholds also recommends solidgauge (unchanged path, new geometry).
    const pctBare: ChartData = { categories: [], series: [{ name: 'v', data: [82] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', unit: 'percent' } };
    expect(recommend(pctBare).type).toBe('solidgauge');
    // Regression: a RAW thresholded KPI STILL flips to bullet (the flip fires for the cases we keep).
    expect(recommend(bullet).type).toBe('bullet');
  });
  it('(2) two categories → slope ONLY on a temporal (ordered) axis; a nominal pair is column', () => {
    // Was 'bar' under D8; the orientation heuristic (SC-2664 change 2, spec §4) makes a two-SHORT-
    // nominal-category shape read as columns. The D8 crux — a nominal pair does NOT auto-slope — is
    // untouched: a mutant reverting the slope rule to the bare count rule makes nominalTwoCat return
    // 'slope', which still reddens this FIRST assertion (now 'column').
    expect(recommend(nominalTwoCat).type).toBe('column');     // was 'bar'/'slope'; slope narrowing (D8) + orientation (this task)
    expect(recommend(twoCatTemporal).type).toBe('slope');     // CONSIDER-08: two points in time do not read as a trend
    // The narrowing exposes an honest win: a nominal 2-cat pair WITH a negative now falls
    // through to divergingBar (was 'slope' — a directional line over a negative, the over-claim
    // D8 removes). The slope-mutant reddens the FIRST assertion above; the block halts there, so this
    // negative case pins the narrowing on a second mutation run (revert the slope rule with the first
    // line removed) rather than in the same run.
    expect(recommend(nominalTwoCatNeg).type).toBe('divergingBar');
  });
  it('(3) seriesDimensionName + non-negative → stackedColumn (stackedArea when temporal)', () => {
    expect(recommend(seriesData).type).toBe('stackedColumn');
    expect(recommend({ ...seriesData, meta: { ...seriesData.meta, dimensionKind: 'temporal' } }).type).toBe('stackedArea');
  });
  it('(4) categorical + hasNegative → divergingBar', () => {
    expect(recommend(negCat).type).toBe('divergingBar');
  });
  it('NEGATIVES: radar and sunburst are NOT auto-recommended (available only)', () => {
    // seriesData is a ≥3-category homogeneous non-negative series → recommends stackedColumn,
    // never sunburst; radar is never the deterministic pick.
    const r = recommend(seriesData);
    expect(r.type).toBe('stackedColumn');
    expect(r.type).not.toBe('sunburst');
    expect(r.type).not.toBe('radar');
  });
  it('heterogeneous multi-measure series (no seriesDimensionName) do NOT stack', () => {
    // ≥3 categories to match the sibling stacked fixtures and exercise the gate across category
    // counts. (Pre-D8, 2 categories would have been intercepted by slope BEFORE the stacked gate;
    // after the temporal-only narrowing a NOMINAL 2-category shape reaches the gate too, so this
    // test would hold at 2 as well — ≥3 keeps it unambiguous.) The stacked signal is evaluated and
    // declines (no seriesDimensionName), which is exactly what this test asserts.
    const hetero: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Count', data: [1, 2, 3] }, { name: 'Revenue', data: [3, 4, 5] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };
    expect(['stackedColumn', 'stackedArea', 'stackedColumn100']).not.toContain(recommend(hetero).type);
  });
  it('divergingBar is NOT auto-picked on a temporal axis', () => {
    const negTemporal = { ...negCat, meta: { ...negCat.meta, dimensionKind: 'temporal' as const } };
    expect(recommend(negTemporal).type).not.toBe('divergingBar');
  });
});

describe('chart-type-advisor — sankey is offered, never auto-recommended (offer-only)', () => {
  it('CAPABILITY_TYPES includes sankey', () => {
    expect(CAPABILITY_TYPES).toContain('sankey');
  });

  it('recommend never returns sankey for any shape (deterministic advisor untouched)', () => {
    const shapes: ChartData[] = [
      data('categorical', 2, 3),   // a two-series matrix — sankey is OFFERED here, but not auto-picked
      data('categorical', 5, 8),
      data('temporal', 3, 5),
      data('categorical', 1, 4),
    ];
    for (const d of shapes) {
      const withDim: ChartData = { ...d, meta: { ...d.meta, seriesDimensionName: 'Series' } };
      expect(recommend(withDim).type).not.toBe('sankey');
    }
  });
});
