import {
  addTile, deleteTile, updateTile, reorderTile, resizeTile, moveTileToIndex, isDirty, defaultTileTitle, newTileId,
} from './dashboard-state';
import { emptyDashboardConfig, type TileConfig, type DashboardConfig } from './dashboard-config';

const table = (id: string): TileConfig => ({ id, kind: 'table', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Product' } });
const chart = (id: string): TileConfig => ({ id, kind: 'chart', layout: { w: 2, h: 1 }, selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] } });

describe('dashboard-state — mutations are immutable and correct', () => {
  it('addTile appends without mutating the input', () => {
    const base = emptyDashboardConfig();
    const next = addTile(base, table('a'));
    expect(base.tiles).toHaveLength(0);   // input untouched
    expect(next.tiles.map((t) => t.id)).toEqual(['a']);
  });
  it('newTileId returns the first free tile-N', () => {
    expect(newTileId([])).toBe('tile-0');
    expect(newTileId([table('tile-0'), table('tile-2')])).toBe('tile-1');
  });
  it('deleteTile removes by id', () => {
    const cfg: DashboardConfig = { schemaVersion: 1, tiles: [table('a'), chart('b')] };
    expect(deleteTile(cfg, 'a').tiles.map((t) => t.id)).toEqual(['b']);
  });
  it('updateTile replaces one tile by id', () => {
    const cfg: DashboardConfig = { schemaVersion: 1, tiles: [table('a')] };
    const updated = updateTile(cfg, 'a', { ...table('a'), title: 'Products' });
    expect(updated.tiles[0].title).toBe('Products');
  });
  it('reorderTile moves left/right and clamps at the ends', () => {
    const cfg: DashboardConfig = { schemaVersion: 1, tiles: [table('a'), chart('b'), table('c')] };
    expect(reorderTile(cfg, 'b', 'left').tiles.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    expect(reorderTile(cfg, 'b', 'right').tiles.map((t) => t.id)).toEqual(['a', 'c', 'b']);
    expect(reorderTile(cfg, 'a', 'left').tiles.map((t) => t.id)).toEqual(['a', 'b', 'c']); // clamp, no throw
  });
  it('resizeTile sets the discrete span', () => {
    const cfg: DashboardConfig = { schemaVersion: 1, tiles: [table('a')] };
    expect(resizeTile(cfg, 'a', 3, 2).tiles[0].layout).toEqual({ w: 3, h: 2 });
  });
});

describe('dashboard-state — moveTileToIndex', () => {
  const cfg: DashboardConfig = { schemaVersion: 1, tiles: [table('a'), chart('b'), table('c')] };

  it('moves a tile to an earlier index', () => {
    expect(moveTileToIndex(cfg, 'c', 0).tiles.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });
  it('moves a tile to a later index', () => {
    expect(moveTileToIndex(cfg, 'a', 2).tiles.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });
  it('clamps an index below 0 and above the last (no throw)', () => {
    expect(moveTileToIndex(cfg, 'b', -5).tiles.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    expect(moveTileToIndex(cfg, 'b', 99).tiles.map((t) => t.id)).toEqual(['a', 'c', 'b']);
  });
  it('is a value-equal no-op when the tile is already at that index', () => {
    expect(moveTileToIndex(cfg, 'b', 1).tiles.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
  it('is a no-op for an unknown id', () => {
    expect(moveTileToIndex(cfg, 'zzz', 0).tiles.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate the input config', () => {
    const before = JSON.stringify(cfg);
    moveTileToIndex(cfg, 'a', 2);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe('dashboard-state — isDirty', () => {
  it('false for structurally-equal configs, true after any change', () => {
    const a: DashboardConfig = { schemaVersion: 1, tiles: [table('a')] };
    const b: DashboardConfig = { schemaVersion: 1, tiles: [table('a')] };
    expect(isDirty(a, b)).toBe(false);
    expect(isDirty(a, addTile(b, chart('c')))).toBe(true);
    expect(isDirty(a, resizeTile(b, 'a', 2, 1))).toBe(true);
  });
});

describe('dashboard-state — defaultTileTitle', () => {
  it('a table tile → the humanized table name', () => {
    expect(defaultTileTitle(table('a'))).toBe('Product'); // SC.Data.Product → Product
  });
  it('a cube chart → "<Measure> by <Dimension>"', () => {
    expect(defaultTileTitle(chart('a'))).toBe('Revenue by Region');
  });
  it('a multi-measure cube chart titles from the first measure + the category dimension', () => {
    const t: TileConfig = { id: 'm', kind: 'chart', layout: { w: 2, h: 1 }, selection: { source: 'cube', cube: 'ProductInventoryCube', measures: ['availableQuantity', 'totalQuantity'], dimensions: [{ name: 'region', role: 'category' }] } };
    expect(defaultTileTitle(t)).toBe('Available Quantity by Region');
  });
  it('a cube chart with only a filter (no category) titles from the measure alone', () => {
    const t: TileConfig = { id: 'f', kind: 'chart', layout: { w: 2, h: 1 }, selection: { source: 'cube', cube: 'C', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'filter', member: 'West' }] } };
    expect(defaultTileTitle(t)).toBe('Revenue');
  });
  it('a kpi chart → the kpi, optionally "by <dimension>"', () => {
    const kpi: TileConfig = { id: 'k', kind: 'chart', layout: { w: 2, h: 1 }, selection: { source: 'kpi', kpi: 'OnHand', expandDimension: 'quantityStatus' } };
    expect(defaultTileTitle(kpi)).toBe('On Hand by Quantity Status');
  });
});
