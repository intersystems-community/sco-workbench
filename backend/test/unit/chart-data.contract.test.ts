import { describe, it, expect, expectTypeOf } from 'vitest';
import type { ChartType, ChartMeta, CubeQuerySpec } from '../../src/dashboard/chart-data.js';

describe('chart-data contract — chart-type-expansion additions', () => {
  it('the ChartType union contains every one of the 21 tokens', () => {
    // A value-level round-trip proves the union admits each token (a compile error here
    // is the real guard; the runtime assertion keeps the test non-empty).
    const all: ChartType[] = [
      'bar', 'column', 'line', 'area', 'pie', 'scatter', 'heatmap', 'treemap', 'dumbbell', 'solidgauge',
      'stackedColumn', 'stackedArea', 'stackedColumn100', 'radar', 'divergingBar', 'slope', 'bullet', 'sunburst', 'bubble', 'funnel', 'bubbleHeatmap',
    ];
    expect(new Set(all).size).toBe(21);
  });

  it('ChartMeta carries the additive series-axis + bullet side-channel fields (all optional)', () => {
    const meta: ChartMeta = { truncated: false, shown: 1, dimensionKind: 'categorical' };
    expectTypeOf(meta).toHaveProperty('seriesDimensionName');
    const full: ChartMeta = {
      truncated: false, shown: 2, dimensionKind: 'categorical',
      seriesDimensionName: 'Region', seriesTruncated: true, seriesShown: 8, seriesTotal: 40,
      target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: 20, kind: 'warning' }],
    };
    expect(full.bands![0]!.kind).toBe('ok');
  });

  it('CubeQuerySpec is the general role model (measures[] + role-tagged dimensions)', () => {
    const spec: CubeQuerySpec = {
      cube: 'C', measures: ['M1', 'M2'],
      dimensions: [
        { name: 'D', role: 'category' },
        { name: 'S', role: 'series' },
        { name: 'F', role: 'filter', member: 'West' },
      ],
    };
    expect(spec.dimensions!.map((d) => d.role)).toEqual(['category', 'series', 'filter']);
    expect(spec.dimensions!.find((d) => d.role === 'filter')!.member).toBe('West');
  });
});
