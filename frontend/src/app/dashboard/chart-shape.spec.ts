// frontend/src/app/dashboard/chart-shape.spec.ts
// The pure shape/label helpers, extracted from chart-panel.ts (spec §11). These
// cases moved verbatim out of chart-panel.spec.ts with their import re-pointed to
// ./chart-shape — the behaviour is unchanged; only the home moved.
import { isCubeChartable, disabledCubeLabel, hasPlottableData, seriesCollapsed, treemapBranchKey, dimensionLevelGroups } from './chart-shape';
import type { ChartData, ChartSpecResponse } from './services/dashboard-chart.service';

describe('cube chartability helpers (Change 1)', () => {
  it('isCubeChartable requires BOTH a measure and a dimension', () => {
    expect(isCubeChartable({ measureCount: 1, dimensionCount: 1 })).toBe(true);
    expect(isCubeChartable({ measureCount: 5, dimensionCount: 9 })).toBe(true);
    expect(isCubeChartable({ measureCount: 0, dimensionCount: 4 })).toBe(false);
    expect(isCubeChartable({ measureCount: 3, dimensionCount: 0 })).toBe(false);
    expect(isCubeChartable({ measureCount: 0, dimensionCount: 0 })).toBe(false);
  });

  it('disabledCubeLabel humanizes the cube name and names the specific reason from the counts', () => {
    // Plain plural on both nouns for a clean read; the both-missing case shortens to just
    // "(no measures)" — no measures is the binding reason (a cube cannot chart without one,
    // dimensions or not), so naming both would only cost space.
    expect(disabledCubeLabel({ cubeName: 'WBDemoNoDim', measureCount: 3, dimensionCount: 0 })).toBe('WB Demo No Dim (no dimensions)');
    expect(disabledCubeLabel({ cubeName: 'ScalarCube', measureCount: 0, dimensionCount: 4 })).toBe('Scalar (no measures)');
    expect(disabledCubeLabel({ cubeName: 'EmptyCube', measureCount: 0, dimensionCount: 0 })).toBe('Empty (no measures)');
  });
});

describe('hasPlottableData (empty-cube state)', () => {
  const meta = { truncated: false, shown: 0, dimensionKind: 'categorical' as const };
  it('is false when there are no categories', () => {
    expect(hasPlottableData({ categories: [], series: [], meta })).toBe(false);
  });
  it('is false when every cell across every series is null (a cube with structure but no fact rows)', () => {
    expect(hasPlottableData({
      categories: ['A', 'B'],
      series: [{ name: 'Total', data: [null, null] }],
      meta,
    })).toBe(false);
  });
  it('is false when there are categories but no series at all', () => {
    expect(hasPlottableData({ categories: ['A', 'B'], series: [], meta })).toBe(false);
  });
  it('is true when at least one cell is a real number (0 is real data, not a gap)', () => {
    expect(hasPlottableData({
      categories: ['A', 'B'],
      series: [{ name: 'Total', data: [null, 0] }],
      meta,
    })).toBe(true);
  });
  it('is true for ordinary populated data', () => {
    expect(hasPlottableData({
      categories: ['A', 'B'],
      series: [{ name: 'Total', data: [1, 2] }],
      meta,
    })).toBe(true);
  });
});

describe('seriesCollapsed (split-by that yields one series)', () => {
  const base = { truncated: false, shown: 2, dimensionKind: 'categorical' as const };
  it('is null when NO split was requested (no series dimension)', () => {
    expect(seriesCollapsed({
      categories: ['A', 'B'],
      series: [{ name: 'Total', data: [1, 2] }],
      meta: base,
    })).toBeNull();
  });
  it('is null when a split produced two or more series (a real breakdown)', () => {
    expect(seriesCollapsed({
      categories: ['A', 'B'],
      series: [{ name: 'x', data: [1, 2] }, { name: 'y', data: [3, 4] }],
      meta: { ...base, seriesDimensionName: 'Inventory Type', seriesShown: 2, seriesTotal: 2 },
    })).toBeNull();
  });
  it('names the split dimension when it collapsed to a single series (the reported case)', () => {
    // The user split by "Inventory Type" but that dimension has one member in the data, so
    // the breakdown is a single series — no stacking/nesting is honest. The note must name
    // the dimension so the user understands WHY nothing changed.
    expect(seriesCollapsed({
      categories: ['Battery', 'CPU'],
      series: [{ name: '<null>', data: [1, 2] }],
      meta: { ...base, seriesDimensionName: 'Inventory Type', seriesShown: 1, seriesTotal: 1 },
    })).toBe('Inventory Type');
  });
});

describe('treemapBranchKey (nested-treemap branch context strip)', () => {
  const PALETTE = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#56B4E9', '#CC79A7', '#F0E442', '#000000'];
  const base = { truncated: false, shown: 3, dimensionKind: 'categorical' as const };
  // A nested treemap: row dim = ship-status (3 members = 3 BRANCHES), split = customer (2 series).
  const nestedData: ChartData = {
    categories: ['Late', 'OnTime', 'Unknown'],
    series: [{ name: 'Acme', data: [1, 2, 3] }, { name: 'Globex', data: [4, 5, 6] }],
    meta: { ...base, seriesDimensionName: 'customer', seriesShown: 2, seriesTotal: 2 },
  };
  // The rendered spec carries the palette it colours the level-1 (branch) tiles with.
  const treemapSpec: ChartSpecResponse = {
    spec: { chart: { type: 'treemap' }, colors: PALETTE, series: [{ type: 'treemap', data: [], levels: [{ level: 1, colorByPoint: true }] }] },
    type: 'treemap', layer: '1b',
  };

  it('is null when there is no spec or no data yet', () => {
    expect(treemapBranchKey(null, nestedData)).toBeNull();
    expect(treemapBranchKey(treemapSpec, null)).toBeNull();
  });

  it('is null for a sunburst — it labels its own centre ring, so it needs no strip', () => {
    const sunburstSpec: ChartSpecResponse = { ...treemapSpec, spec: { ...treemapSpec.spec, chart: { type: 'sunburst' } }, type: 'sunburst' };
    expect(treemapBranchKey(sunburstSpec, nestedData)).toBeNull();
  });

  it('is null for a FLAT treemap (no series dimension) — each tile is already its own labelled category', () => {
    const flatData: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Total', data: [1, 2, 3] }], meta: base };
    expect(treemapBranchKey(treemapSpec, flatData)).toBeNull();
  });

  it('is null when a split collapsed to a single series (no branches to key)', () => {
    const collapsed: ChartData = { categories: ['Late', 'OnTime'], series: [{ name: '<null>', data: [1, 2] }], meta: { ...base, seriesDimensionName: 'customer', seriesShown: 1, seriesTotal: 1 } };
    expect(treemapBranchKey(treemapSpec, collapsed)).toBeNull();
  });

  it('maps each branch (row category) to the palette hue the tile is coloured with, in category order', () => {
    // level-1 colorByPoint cycles the spec palette over the branches in data order,
    // so branch i is drawn in colors[i]. The strip must read the SAME palette off the
    // spec (not a re-declared constant) so a swatch can never drift from its tile.
    expect(treemapBranchKey(treemapSpec, nestedData)).toEqual([
      { label: 'Late', color: '#0072B2' },
      { label: 'OnTime', color: '#E69F00' },
      { label: 'Unknown', color: '#009E73' },
    ]);
  });

  it('reads the palette off the spec, so a different spec palette yields different swatches (drift guard)', () => {
    const recolored: ChartSpecResponse = { ...treemapSpec, spec: { ...treemapSpec.spec, colors: ['#111111', '#222222', '#333333'] } };
    expect(treemapBranchKey(recolored, nestedData)).toEqual([
      { label: 'Late', color: '#111111' },
      { label: 'OnTime', color: '#222222' },
      { label: 'Unknown', color: '#333333' },
    ]);
  });

  it('wraps the palette with modulo when there are more branches than palette entries', () => {
    const twoColor: ChartSpecResponse = { ...treemapSpec, spec: { ...treemapSpec.spec, colors: ['#aa', '#bb'] } };
    const key = treemapBranchKey(twoColor, nestedData)!;
    expect(key.map((k) => k.color)).toEqual(['#aa', '#bb', '#aa']);
  });

  it('is null when the spec carries no palette (cannot key a colour it does not know)', () => {
    const noColors: ChartSpecResponse = { ...treemapSpec, spec: { chart: { type: 'treemap' } } };
    expect(treemapBranchKey(noColors, nestedData)).toBeNull();
  });
});

describe('dimensionLevelGroups (level options grouped by dimension — B-CUBE-15)', () => {
  it('makes one optgroup per dimension (in shape order) with its levels as options (catalog order, spec = value)', () => {
    const groups = dimensionLevelGroups([
      { name: 'customer', kind: 'categorical', levels: [
        { name: 'Country', spec: '[customer].[H1].[Country]' },
        { name: 'CustomerName', caption: 'Customer Name', spec: '[customer].[H1].[CustomerName]' },
      ] },
      { name: 'orderDate', kind: 'temporal', levels: [{ name: 'Year', spec: '[orderDate].[H1].[Year]' }] },
    ]);
    expect(groups.map((g) => g.dimension)).toEqual(['customer', 'orderDate']); // shape order, NOT alpha
    expect(groups[0]!.label).toBe('Customer');
    expect(groups[0]!.kind).toBe('categorical');               // kind still rides for chart-type inference
    expect(groups[0]!.levels).toEqual([
      { name: 'Country', label: 'Country', spec: '[customer].[H1].[Country]' },
      { name: 'CustomerName', label: 'Customer Name', spec: '[customer].[H1].[CustomerName]' }, // caption wins; catalog order
    ]);
  });
  it('omits a dimension with no resolvable level (empty levels[]) — nothing to select', () => {
    const groups = dimensionLevelGroups([
      { name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] },
      { name: 'broken', kind: 'categorical', levels: [] },
    ]);
    expect(groups.map((g) => g.dimension)).toEqual(['region']);
  });
});
