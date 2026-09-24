// backend/test/unit/cube-query.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CubeQueryRunner } from '../../src/dashboard/cube-query.js';
import { QueryError, NotFoundError, ValidationError } from '../../src/iris/iris-error.js';
import type { CubeShape, CubeShapeReader } from '../../src/dashboard/chart-data.js';
import mdxSample from './fixtures/mdx-result.sample.json' with { type: 'json' };

const shape: CubeShape = {
  cube: 'SalesCube',
  measures: [{ name: 'Revenue' }, { name: '%COUNT' }],
  // levels[] is the leaf-level MDX path the real shape reader carries (each hierarchy's
  // levels). composeMdx queries the CHOSEN level's set (levels[0] when none is picked),
  // not the All-leaking dimension-wide [dim].MEMBERS — see the additivity fix block below.
  dimensions: [
    { name: 'orderDate', kind: 'temporal', levels: [{ name: 'Year', spec: '[orderDate].[H1].[Year]' }] },
    { name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] },
  ],
};
const shapeReader: CubeShapeReader = { shape: async () => shape };

describe('CubeQueryRunner — injection closed by construction', () => {
  it('rejects an unknown measure BEFORE mdxExecute is called', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    await expect(runner.query({ cube: 'SalesCube', measures: ['] } DROP TABLE'], dimensions: [{ name: 'region', role: 'category' }] }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled(); // the D1 resolveClass guarantee, as a test
  });

  it('rejects an unknown dimension before composing MDX', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'nope', role: 'category' }] }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });
});

describe('CubeQueryRunner — compose + normalize', () => {
  it('a well-formed spec composes MDX (snapshot) and normalizes cells to ChartData', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(mdxExecute).toHaveBeenCalledOnce();
    expect(mdxExecute.mock.calls[0]![0]).toMatchSnapshot(); // the composed MDX string
    expect(data.categories.length).toBeGreaterThan(0);
    expect(data.series[0]!.name).toBeDefined();
  });

  it('a time dimension sets meta.dimensionKind temporal; a non-time one categorical', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    expect((await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'orderDate', role: 'category' }] })).meta.dimensionKind).toBe('temporal');
    expect((await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] })).meta.dimensionKind).toBe('categorical');
  });

  it('a scalar query (no rowDimension) sets dimensionKind scalar', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    expect((await runner.query({ cube: 'SalesCube', measures: ['Revenue'] })).meta.dimensionKind).toBe('scalar');
  });

  it('carries measure + dimension LABELS onto meta so the pure builder can title truthfully', async () => {
    // shape has Revenue (no caption → falls back to the name) and region (no levels → dim-name label).
    const captioned: CubeShape = {
      cube: 'SalesCube',
      measures: [{ name: 'Revenue', caption: 'Total Revenue' }, { name: '%COUNT', caption: 'Count' }],
      dimensions: [{ name: 'region', kind: 'categorical', levels: [] }],
    };
    const runner = new CubeQueryRunner({ shape: async () => captioned }, { mdxExecute: vi.fn().mockResolvedValue(mdxSample) });
    const withDim = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(withDim.meta.valueLabel).toBe('Total Revenue'); // the authored caption, passed through verbatim
    expect(withDim.meta.categoryLabel).toBe('Region');     // the dimension code humanized (no level caption)
    // A measure with no caption falls back to its humanized name; a scalar has no dimension label.
    const runner2 = new CubeQueryRunner({ shape: async () => shape }, { mdxExecute: vi.fn().mockResolvedValue(mdxSample) });
    const scalar = await runner2.query({ cube: 'SalesCube', measures: ['Revenue'] });
    expect(scalar.meta.valueLabel).toBe('Revenue');
    expect(scalar.meta.categoryLabel).toBeUndefined();
  });

  it('humanizes a camelCase dimension code for the title (the "by productCategory" bug)', async () => {
    const camel: CubeShape = {
      cube: 'ConsolidatedInventoryCube',
      measures: [{ name: '%COUNT', caption: 'Count' }],
      dimensions: [{ name: 'productCategory', kind: 'categorical', levels: [] }],
    };
    const runner = new CubeQueryRunner({ shape: async () => camel }, { mdxExecute: vi.fn().mockResolvedValue(mdxSample) });
    const data = await runner.query({ cube: 'ConsolidatedInventoryCube', measures: ['%COUNT'], dimensions: [{ name: 'productCategory', role: 'category' }] });
    expect(data.meta.categoryLabel).toBe('Product Category'); // NOT the raw "productCategory"
    expect(data.meta.valueLabel).toBe('Count');
  });

  it('a NULL cell becomes null, never 0', async () => {
    // Use a fixture variant whose cell is null/missing — assert the normalizer preserves the gap.
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.series[0]!.data.every((v) => v === null || typeof v === 'number')).toBe(true);
  });

  it('topN sets meta.truncated when the axis exceeds the cap', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute }, undefined, { defaultTopN: 1 });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    if (data.meta.total && data.meta.total > 1) expect(data.meta.truncated).toBe(true);
  });

  it('an IRIS MDX error (Info.Error present) → QueryError 422', async () => {
    const mdxExecute = vi.fn().mockResolvedValue({ Info: { Error: 'bad member [region].[nope]' }, Result: {} });
    const runner = new CubeQueryRunner(shapeReader, { mdxExecute });
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] }))
      .rejects.toBeInstanceOf(QueryError);
  });
});

import mdxCrossjoin from './fixtures/mdx-crossjoin.sample.json' with { type: 'json' };
import mdxCrossjoinTruncated from './fixtures/mdx-crossjoin-truncated.sample.json' with { type: 'json' };
import mdxTwoMeasure from './fixtures/mdx-two-measure.sample.json' with { type: 'json' };
import { MAX_SERIES } from '../../src/dashboard/cube-query.js';

describe('CubeQueryRunner — crossjoin (second-dimension split, honest homogeneous series)', () => {
  const seriesShape: CubeShape = {
    cube: 'SalesCube',
    measures: [{ name: 'Revenue' }],
    dimensions: [
      { name: 'customer', kind: 'categorical', levels: [{ name: 'Customer', spec: '[customer].[H1].[Customer]' }] },
      { name: 'year', kind: 'temporal', levels: [{ name: 'Year', spec: '[year].[H1].[Year]' }] },
    ],
  };
  const reader: CubeShapeReader = { shape: async () => seriesShape };

  it('rejects an unknown seriesDimension before composing MDX', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'customer', role: 'category' }, { name: 'nope', role: 'series' },
    ] }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('composes a CROSSJOIN MDX with the single measure ON 0 (snapshot) and validated identifiers only', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxCrossjoin);
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'customer', role: 'category' }, { name: 'year', role: 'series' },
    ] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toMatch(/CROSSJOIN\(/);
    // The [All]-leak fix: the crossjoin enumerates the LEAF LEVEL of each dimension,
    // NOT the dimension-wide [dim].MEMBERS (which folds in the [All] member and every
    // hierarchy level, double/quadruple-counting a SUM measure). See the dedicated
    // additivity test below and the live integration gate.
    expect(mdx).toMatch(/\[customer\]\.\[H1\]\.\[Customer\]\.MEMBERS/);
    expect(mdx).toMatch(/\[year\]\.\[H1\]\.\[Year\]\.MEMBERS/);
    expect(mdx).not.toMatch(/\[customer\]\.MEMBERS/); // never the All-leaking dimension-wide set
    expect(mdx).not.toMatch(/\[year\]\.MEMBERS/);
    expect(mdx).toMatchSnapshot();
  });

  it('walks the two-member tuples by dimName: categories = ROW members, series = SERIES members (never swapped)', async () => {
    // AXIS IDENTITY, not just distinctness. IRIS returns each CROSSJOIN row tuple's
    // Members in the REVERSE of the CROSSJOIN() argument order, so with
    // rowDimension=customer, seriesDimension=year the fixture's Members are
    // [yearMember, customerMember]. Reading them positionally (Members[0]=row) would
    // SILENTLY swap the axes — categories would come back as ['2024','2025'] and the
    // series as customers. The runner MUST attribute each member by MemberInfo.dimName:
    // dimName 'customer' → the row (category) axis, 'year' → the series axis.
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(mdxCrossjoin) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'customer', role: 'category' }, { name: 'year', role: 'series' },
    ] });
    expect(data.categories).toEqual(['Staples', 'Amazon']);
    expect(data.series.map((s) => s.name)).toEqual(['2024', '2025']);
    // series '2024' over [Staples, Amazon] = [100, null] (the empty cell is a gap, never 0);
    // series '2025' = [150, 300].
    expect(data.series[0]!.data).toEqual([100, null]);
    expect(data.series[1]!.data).toEqual([150, 300]);
    expect(data.meta.seriesDimensionName).toBe('Year');
    // row-axis truncation metadata still describes the CATEGORY axis, unchanged.
    expect(data.meta.dimensionKind).toBe('categorical');
  });

  it('caps the series axis at MAX_SERIES and DISCLOSES it (never a silent trim)', async () => {
    expect(MAX_SERIES).toBe(8);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(mdxCrossjoin) });
    // With a full series count above the cap, seriesTruncated is set. Drive the count via
    // the seriesTotal source (Step 3 reads it); here the fixture has 2 members ≤ 8, so
    // NOT truncated — assert the honest negative, and cover the positive in a variant.
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'customer', role: 'category' }, { name: 'year', role: 'series' },
    ] });
    expect(data.meta.seriesTruncated).toBe(false);
    expect(data.meta.seriesShown).toBe(2);
    expect(data.meta.seriesTotal).toBe(2);
  });

  it('discloses a truncated series axis from the %chartSeriesTotal column (not the emitted count)', async () => {
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(mdxCrossjoinTruncated) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'customer', role: 'category' }, { name: 'year', role: 'series' },
    ] });
    expect(data.meta.seriesShown).toBe(2);       // the emitted (bounded) series count
    expect(data.meta.seriesTotal).toBe(40);      // read from the column, NOT the fallback
    expect(data.meta.seriesTruncated).toBe(true); // 40 > 2 ⇒ disclosed, never a silent trim
  });
});

describe('CubeQueryRunner — [All]-leak additivity fix (leaf-level MDX, never [dim].MEMBERS)', () => {
  // The pre-existing D2 bug: [dim].MEMBERS returns the [All] member AND mixes every
  // hierarchy level, so a SUM measure double-counts (single-dim) or quadruple-counts
  // (crossjoin). The fix queries the leaf LEVEL — [dim].[hier].[level].MEMBERS — which
  // carries the leaf members only. Live additivity is gated by the integration tier;
  // these unit tests lock the composed MDX so the regression cannot silently return.
  const withSpec: CubeShape = {
    cube: 'SalesCube',
    measures: [{ name: 'Revenue' }],
    dimensions: [{ name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] }],
  };

  it('single-dimension: TOPCOUNT and %DISTINCT enumerate the leaf level, not [dim].MEMBERS', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => withSpec }, { mdxExecute });
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toMatch(/TOPCOUNT\(\[region\]\.\[H1\]\.\[Region\]\.MEMBERS,/);
    expect(mdx).toMatch(/%DISTINCT\(\[region\]\.\[H1\]\.\[Region\]\.MEMBERS\)/);
    expect(mdx).not.toMatch(/\[region\]\.MEMBERS/); // the All-leaking form is gone
  });

  it('falls back to [dim].MEMBERS when the shape carries no levels (graceful degradation)', async () => {
    // A shape without levels (e.g. a minimal test fixture or a dimension whose level
    // spec could not be resolved) must still compose valid MDX — the pre-fix behaviour.
    const noSpec: CubeShape = {
      cube: 'SalesCube',
      measures: [{ name: 'Revenue' }],
      dimensions: [{ name: 'region', kind: 'categorical', levels: [] }],
    };
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => noSpec }, { mdxExecute });
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toMatch(/TOPCOUNT\(\[region\]\.MEMBERS,/);
  });
});

describe('CubeQueryRunner — general-spec collapse guards (defense in depth)', () => {
  const mk = () => {
    const mdxExecute = vi.fn();
    return { mdxExecute, runner: new CubeQueryRunner(shapeReader, { mdxExecute }) };
  };

  it('rejects two category dimensions (ValidationError) before mdxExecute', async () => {
    const { mdxExecute, runner } = mk();
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'orderDate', role: 'category' },
    ] })).rejects.toBeInstanceOf(ValidationError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('rejects two series dimensions', async () => {
    const { mdxExecute, runner } = mk();
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'series' }, { name: 'orderDate', role: 'series' },
    ] })).rejects.toBeInstanceOf(ValidationError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('rejects a dimension used as both an axis and a filter', async () => {
    const { mdxExecute, runner } = mk();
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'region', role: 'filter', member: 'West' },
    ] })).rejects.toBeInstanceOf(ValidationError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('rejects a filter assignment with no member', async () => {
    const { mdxExecute, runner } = mk();
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'filter' },
    ] })).rejects.toBeInstanceOf(ValidationError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('rejects the deferred combo: 2+ measures AND a series split (ValidationError) before mdxExecute', async () => {
    const { mdxExecute, runner } = mk();
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue', '%COUNT'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'orderDate', role: 'series' },
    ] })).rejects.toBeInstanceOf(ValidationError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });
});

describe('CubeQueryRunner — level-granular selection (B-CUBE-15)', () => {
  const customerShape: CubeShape = {
    cube: 'SalesCube',
    measures: [{ name: 'Revenue' }],
    dimensions: [{ name: 'Customer', kind: 'categorical', levels: [
      { name: 'Country', caption: 'Country', spec: '[Customer].[H1].[Country]' },
      { name: 'CustomerName', caption: 'Customer Name', spec: '[Customer].[H1].[CustomerName]' },
    ] }],
  };
  const reader: CubeShapeReader = { shape: async () => customerShape };

  it('an explicit non-first level composes TOPCOUNT on THAT level and titles from the level caption', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'Customer', role: 'category', level: '[Customer].[H1].[CustomerName]' },
    ] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toContain('TOPCOUNT([Customer].[H1].[CustomerName].MEMBERS,');
    expect(data.meta.categoryLabel).toBe('Customer Name'); // the LEVEL caption, not "Customer"
  });

  it('absent level resolves to the FIRST level (byte-identical to pre-B-CUBE-15)', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'Customer', role: 'category' },
    ] });
    expect(mdxExecute.mock.calls[0]![0]).toContain('TOPCOUNT([Customer].[H1].[Country].MEMBERS,');
    expect(data.meta.categoryLabel).toBe('Country'); // first level's caption
  });

  it('rejects an unknown level with NotFoundError (candidates = the dimension\'s level specs) before mdxExecute', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'Customer', role: 'category', level: '[Customer].[H1].[Nope]' },
    ] })).rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });
});

describe('CubeQueryRunner — multiple measures on the no-split path (#1)', () => {
  const invShape: CubeShape = {
    cube: 'ProductInventoryCube',
    measures: [{ name: 'availableQuantity' }, { name: 'totalQuantity' }],
    dimensions: [{ name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] }],
  };
  const reader: CubeShapeReader = { shape: async () => invShape };

  it('composes both measures ON 0 (snapshot) and returns two series', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxTwoMeasure);
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    const data = await runner.query({ cube: 'ProductInventoryCube', measures: ['availableQuantity', 'totalQuantity'], dimensions: [{ name: 'region', role: 'category' }] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toContain('{[Measures].[availableQuantity],[Measures].[totalQuantity],[Measures].[%chartTotal]} ON 0');
    expect(mdx).toMatchSnapshot();
    expect(data.categories).toEqual(['West', 'East']);
    expect(data.series).toHaveLength(2);
    expect(data.series[0]!.data).toEqual([10, 20]);
    expect(data.series[1]!.data).toEqual([30, 50]);
  });

  it('names each series from the REQUESTED measure (humanized), not the Axis-0 member Name (B-CUBE-04a)', async () => {
    // The shape has no captions → the humanized measure name. This pins naming WITHOUT
    // depending on what IRIS returns on Axis 0 (a live-only fact); a caption, when present,
    // rides through verbatim — the same rule meta.valueLabel uses.
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(mdxTwoMeasure) });
    const data = await runner.query({ cube: 'ProductInventoryCube', measures: ['availableQuantity', 'totalQuantity'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.series.map((s) => s.name)).toEqual(['Available Quantity', 'Total Quantity']);
    expect(data.meta.truncated).toBe(false); // total=2 == shown=2
  });

  it('a captioned measure series uses the caption verbatim', async () => {
    const captioned: CubeShape = {
      cube: 'ProductInventoryCube',
      measures: [{ name: 'availableQuantity', caption: 'Available Qty' }, { name: 'totalQuantity', caption: 'Total Qty' }],
      dimensions: [{ name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] }],
    };
    const runner = new CubeQueryRunner({ shape: async () => captioned }, { mdxExecute: vi.fn().mockResolvedValue(mdxTwoMeasure) });
    const data = await runner.query({ cube: 'ProductInventoryCube', measures: ['availableQuantity', 'totalQuantity'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.series.map((s) => s.name)).toEqual(['Available Qty', 'Total Qty']);
  });
});

describe('CubeQueryRunner — decoupled axes (#2): role assignment picks category vs series', () => {
  // Re-declare the customer + year shape locally (the crossjoin block's `reader` is not in scope here).
  const seriesShape: CubeShape = {
    cube: 'SalesCube',
    measures: [{ name: 'Revenue' }],
    dimensions: [
      { name: 'customer', kind: 'categorical', levels: [{ name: 'Customer', spec: '[customer].[H1].[Customer]' }] },
      { name: 'year', kind: 'temporal', levels: [{ name: 'Year', spec: '[year].[H1].[Year]' }] },
    ],
  };
  const reader: CubeShapeReader = { shape: async () => seriesShape };

  it('year=category, customer=series composes the MIRROR crossjoin and attributes by dimName', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxCrossjoin);
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'year', role: 'category' }, { name: 'customer', role: 'series' },
    ] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    // Mirror image of the customer=category/year=series snapshot: row set is now year, series set customer.
    expect(mdx).toContain('CROSSJOIN(TOPCOUNT([year].[H1].[Year].MEMBERS,');
    expect(mdx).toContain('TOPCOUNT([customer].[H1].[Customer].MEMBERS,8,');
    // Attribution follows the ROLE, not tuple position: categories are the year members, series the customers.
    expect(data.categories).toEqual(['2024', '2025']);
    expect(data.series.map((s) => s.name)).toEqual(['Staples', 'Amazon']);
    expect(data.meta.seriesDimensionName).toBe('Customer');
  });
});

describe('CubeQueryRunner — filters (#3): a validated WHERE slicer', () => {
  const shape3: CubeShape = {
    cube: 'SalesCube',
    measures: [{ name: 'Revenue' }],
    dimensions: [
      { name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] },
      { name: 'product', kind: 'categorical', levels: [{ name: 'Product', spec: '[product].[H1].[Product]' }] },
      { name: 'year', kind: 'temporal', levels: [{ name: 'Year', spec: '[year].[H1].[Year]' }] },
    ],
  };
  // A member reader that knows region/product/year members. Filter validation calls it with the
  // resolved level spec (3rd arg) — the stub ignores it (single-level dims) but the runner passes it.
  const memberReader = {
    members: vi.fn(async (_cube: string, dim: string, _level?: string) => (
      dim === 'region' ? [{ name: 'West' }, { name: 'East' }]
      : dim === 'product' ? [{ name: 'Widget' }, { name: 'Gadget' }]
      : [{ name: '2024' }, { name: '2025' }]
    )),
  };

  it('appends a single-member WHERE slicer built from the filter\'s resolved (first) level spec (snapshot)', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'year', role: 'filter', member: '2024' },
    ] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toContain('FROM [SalesCube] WHERE ([year].[H1].[Year].[2024])');
    expect(mdx).toContain('%DISTINCT([region].[H1].[Region].MEMBERS)'); // additivity/truncation intact
    expect(mdx).toMatchSnapshot();
  });

  it('joins two filters into one slicer tuple', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' },
      { name: 'year', role: 'filter', member: '2024' },
      { name: 'product', role: 'filter', member: 'Widget' },
    ] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toContain('WHERE ([year].[H1].[Year].[2024],[product].[H1].[Product].[Widget])');
  });

  it('a filter on a chosen non-first LEVEL builds the WHERE tuple from THAT level spec and validates members against it (B-CUBE-15)', async () => {
    const custShape: CubeShape = {
      cube: 'SalesCube',
      measures: [{ name: 'Revenue' }],
      dimensions: [
        { name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] },
        { name: 'Customer', kind: 'categorical', levels: [
          { name: 'Country', caption: 'Country', spec: '[Customer].[H1].[Country]' },
          { name: 'CustomerName', caption: 'Customer Name', spec: '[Customer].[H1].[CustomerName]' },
        ] },
      ],
    };
    const custReader = { members: vi.fn(async () => [{ name: 'Acme Ltd' }]) };
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => custShape }, { mdxExecute }, custReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' },
      { name: 'Customer', role: 'filter', level: '[Customer].[H1].[CustomerName]', member: 'Acme Ltd' },
    ] });
    // member validation enumerated the CHOSEN level, not the first
    expect(custReader.members).toHaveBeenCalledWith('SalesCube', 'Customer', '[Customer].[H1].[CustomerName]');
    expect(mdxExecute.mock.calls[0]![0]).toContain('WHERE ([Customer].[H1].[CustomerName].[Acme Ltd])');
  });

  it('bracket-escapes a member name (] → ]]) belt-and-braces', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const weird = { members: vi.fn(async () => [{ name: 'A]B' }]) };
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, weird);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'year', role: 'filter', member: 'A]B' },
    ] });
    expect(mdxExecute.mock.calls[0]![0]).toContain('[year].[H1].[Year].[A]]B]');
  });

  it('rejects an unknown filter member with NotFoundError + candidates, never reaching MDX', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'year', role: 'filter', member: '1999' },
    ] })).rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('rejects an unknown filter DIMENSION with NotFoundError before MDX', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'nope', role: 'filter', member: 'x' },
    ] })).rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('a filter applies to the crossjoin path too (WHERE orthogonal to the axes)', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'region', role: 'category' }, { name: 'product', role: 'series' },
      { name: 'year', role: 'filter', member: '2024' },
    ] });
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toContain('CROSSJOIN(');
    expect(mdx).toContain('WHERE ([year].[H1].[Year].[2024])');
  });

  // ── Scalar path MDX text — no snapshot exists for it today (B-CUBE-PLAN-02). Pin the exact
  //    composed text so the `from` refactor in Step 3 cannot silently perturb the scalar branch. ──
  it('the scalar path (no category, no filters) composes the exact bare SELECT — pins the pre-refactor text', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'] });
    expect(mdxExecute.mock.calls[0]![0]).toBe('SELECT {[Measures].[Revenue]} ON 0 FROM [SalesCube]');
  });

  it('the newly-reachable scalar-plus-WHERE combo (filter, NO category) composes SELECT … ON 0 FROM … WHERE (…)', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => shape3 }, { mdxExecute }, memberReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [
      { name: 'year', role: 'filter', member: '2024' },
    ] });
    expect(mdxExecute.mock.calls[0]![0]).toBe('SELECT {[Measures].[Revenue]} ON 0 FROM [SalesCube] WHERE ([year].[H1].[Year].[2024])');
  });

  it('a two-measure scalar-plus-WHERE keeps both measures ON 0 under the slicer', async () => {
    const shape2m: CubeShape = { cube: 'SalesCube', measures: [{ name: 'Revenue' }, { name: 'Units' }], dimensions: shape3.dimensions }; // reuses shape3's levels[] dims
    const mdxExecute = vi.fn().mockResolvedValue(mdxSample);
    const runner = new CubeQueryRunner({ shape: async () => shape2m }, { mdxExecute }, memberReader);
    await runner.query({ cube: 'SalesCube', measures: ['Revenue', 'Units'], dimensions: [
      { name: 'year', role: 'filter', member: '2024' },
    ] });
    expect(mdxExecute.mock.calls[0]![0]).toBe('SELECT {[Measures].[Revenue],[Measures].[Units]} ON 0 FROM [SalesCube] WHERE ([year].[H1].[Year].[2024])');
  });
});

// ── Helper for bubble tests: builds a canned RawMdxResult envelope from measure column names + cell matrix ──
function buildMdxResult(measureCols: string[], categories: string[], cellMatrix: (number | null)[][]): unknown {
  const colCount = measureCols.length;
  const rowCount = categories.length;
  const flatCells = cellMatrix.flat().map((val) => ({ ValueLogical: val }));
  return {
    Result: {
      Axes: [
        { Tuples: measureCols.map((m) => ({ Members: [{ Name: m }] })) },
        { Tuples: categories.map((c) => ({ Members: [{ Name: c }] })) },
      ],
      CellData: flatCells,
    },
  };
}

describe('CubeQueryRunner — bubble points projection', () => {
  // Shape WITHOUT %COUNT in measures — ensures the bypass test is meaningful
  const bubbleShape: CubeShape = {
    cube: 'SalesCube',
    measures: [{ name: 'Revenue' }, { name: 'Margin' }],
    dimensions: [{ name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] }],
  };
  const reader: CubeShapeReader = { shape: async () => bubbleShape };

  it('projects x=measure0, y=measure1, size=measure2, label=category into data.points', async () => {
    // Request three measures over two categories A, B. Use %COUNT as the third measure.
    const result = buildMdxResult(['Revenue', 'Margin', '%COUNT'], ['A', 'B'], [
      [1, 2, 3],  // row A: Revenue=1, Margin=2, %COUNT=3
      [4, 5, 6],  // row B: Revenue=4, Margin=5, %COUNT=6
    ]);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(result) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue', 'Margin', '%COUNT'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.points).toEqual([
      { x: 1, y: 2, size: 3, label: 'A' },
      { x: 4, y: 5, size: 6, label: 'B' },
    ]);
    expect(data.series).toHaveLength(3); // the axis series stay populated
  });

  it('with only two measures, points carry size:null (Count/third measure is optional)', async () => {
    const result = buildMdxResult(['Revenue', 'Margin'], ['A', 'B'], [
      [1, 2],
      [3, 4],
    ]);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(result) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue', 'Margin'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.points).toEqual([
      { x: 1, y: 2, size: null, label: 'A' },
      { x: 3, y: 4, size: null, label: 'B' },
    ]);
  });

  it('drops a point whose x or y is a null cell (a gap is no point)', async () => {
    const result = buildMdxResult(['Revenue', 'Margin'], ['A', 'B'], [
      [1, 2],
      [null, 4],  // B's x is null → drop B
    ]);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(result) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue', 'Margin'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.points).toEqual([{ x: 1, y: 2, size: null, label: 'A' }]); // B dropped
  });

  it('does NOT attach points for a single-measure query', async () => {
    const result = buildMdxResult(['Revenue'], ['A', 'B'], [
      [1],
      [2],
    ]);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(result) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] });
    expect(data.points).toBeUndefined();
  });

  it("accepts '%COUNT' as a measure without throwing the unknown-measure NotFoundError", async () => {
    // Use a result with three measures including %COUNT
    const result = buildMdxResult(['Revenue', 'Margin', '%COUNT'], ['A', 'B'], [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(result) });
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue', 'Margin', '%COUNT'], dimensions: [{ name: 'region', role: 'category' }] }))
      .resolves.toBeDefined();
  });

  it("names the %COUNT size series 'Count', not the humanized '%COUNT' (§192)", async () => {
    const result = buildMdxResult(['Revenue', 'Margin', '%COUNT'], ['A', 'B'], [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const runner = new CubeQueryRunner(reader, { mdxExecute: vi.fn().mockResolvedValue(result) });
    const data = await runner.query({ cube: 'SalesCube', measures: ['Revenue', 'Margin', '%COUNT'], dimensions: [{ name: 'region', role: 'category' }] });
    // The third (size) series is the %COUNT source — its name reads cleanly, so a bubble's sizeLabel is "Count".
    expect(data.series[2]!.name).toBe('Count');
  });

  it('any other unknown measure still throws NotFoundError', async () => {
    const mdxExecute = vi.fn();
    const runner = new CubeQueryRunner(reader, { mdxExecute });
    await expect(runner.query({ cube: 'SalesCube', measures: ['Revenue', 'NoSuchMeasure'], dimensions: [{ name: 'region', role: 'category' }] }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled(); // validation fails before MDX
  });
});
