import { describe, it, expect } from 'vitest';
import {
  validateDashboardConfig, emptyDashboardConfig, CURRENT_SCHEMA_VERSION,
  type DashboardConfig,
} from '../../src/dashboard/dashboard-config.js';
import { ValidationError } from '../../src/iris/iris-error.js';

const chartTile = {
  id: 't1', kind: 'chart', title: 'Revenue by Region',
  layout: { w: 2, h: 1 },
  selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }], chartType: 'bar' },
};
const tableTile = { id: 't2', kind: 'table', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Product' } };

describe('validateDashboardConfig — negatives', () => {
  it('rejects a non-object', () => {
    expect(() => validateDashboardConfig(null)).toThrow(ValidationError);
    expect(() => validateDashboardConfig(42)).toThrow(ValidationError);
  });
  it('rejects a missing/!array tiles', () => {
    expect(() => validateDashboardConfig({ schemaVersion: 1 })).toThrow(ValidationError);
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: {} })).toThrow(ValidationError);
  });
  it('rejects an unknown schemaVersion (newer build wrote it)', () => {
    expect(() => validateDashboardConfig({ schemaVersion: 2, tiles: [] })).toThrow(ValidationError);
  });
  it('rejects an unknown tile kind', () => {
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...chartTile, kind: 'map' }] })).toThrow(ValidationError);
  });
  it('rejects an out-of-range layout span', () => {
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...tableTile, layout: { w: 4, h: 1 } }] })).toThrow(ValidationError);
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...tableTile, layout: { w: 1, h: 3 } }] })).toThrow(ValidationError);
  });
  it('rejects a selection whose shape does not match its kind', () => {
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...chartTile, selection: { table: 'X' } }] })).toThrow(ValidationError);
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...tableTile, selection: { source: 'cube', cube: 'C', measures: ['M'] } }] })).toThrow(ValidationError);
  });
  it('rejects a cube chart with no measure and a kpi chart with no kpi', () => {
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...chartTile, selection: { source: 'cube', cube: 'C' } }] })).toThrow(ValidationError);
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...chartTile, selection: { source: 'kpi' } }] })).toThrow(ValidationError);
  });
  it('rejects a missing tile id', () => {
    const { id, ...noId } = tableTile;
    expect(() => validateDashboardConfig({ schemaVersion: 1, tiles: [noId] })).toThrow(ValidationError);
  });
});

describe('validateDashboardConfig — happy + tolerance', () => {
  it('accepts a valid mixed config and returns a normalized copy', () => {
    const out = validateDashboardConfig({ schemaVersion: 1, tiles: [chartTile, tableTile] });
    expect(out.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(out.tiles).toHaveLength(2);
    expect(out.tiles[0]).toMatchObject({ id: 't1', kind: 'chart' });
  });
  it('drops unknown fields on the tile and the selection (tolerant parse for B/C)', () => {
    const dirty = { schemaVersion: 1, tiles: [{ ...tableTile, bogus: 1, selection: { table: 'X', renderer: 'echarts' } }] };
    const out = validateDashboardConfig(dirty);
    expect(out.tiles[0]).not.toHaveProperty('bogus');
    expect(out.tiles[0]!.selection).not.toHaveProperty('renderer');
    expect(out.tiles[0]!.selection).toEqual({ table: 'X' });
  });
  it('preserves an optional topN and chartType on a cube selection', () => {
    const out = validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...chartTile, selection: { source: 'cube', cube: 'C', measures: ['M'], topN: 5, chartType: 'pie' } }] });
    expect(out.tiles[0]!.selection).toMatchObject({ topN: 5, chartType: 'pie' });
  });
  it('emptyDashboardConfig is a valid empty config', () => {
    const e: DashboardConfig = emptyDashboardConfig();
    expect(validateDashboardConfig(e)).toEqual(e);
  });
});

describe('validateChartSelection — cube general shape (Track B round 3)', () => {
  const wrap = (selection: unknown) =>
    validateDashboardConfig({ schemaVersion: 1, tiles: [{ id: 'c', kind: 'chart', layout: { w: 2, h: 1 }, selection }] })
      .tiles[0]!.selection as any;

  it('accepts measures[] + role-tagged dimensions (incl. an optional level) and drops undefined', () => {
    const s = wrap({ source: 'cube', cube: 'C', measures: ['M1', 'M2'], dimensions: [
      { name: 'D', role: 'category', level: '[D].[H1].[L2]' }, { name: 'S', role: 'series' }, { name: 'F', role: 'filter', member: 'West' },
    ] });
    expect(s.measures).toEqual(['M1', 'M2']);
    expect(s.dimensions).toHaveLength(3);
    expect(s.dimensions[0]).toEqual({ name: 'D', role: 'category', level: '[D].[H1].[L2]' }); // level preserved
    expect(s.dimensions[1]).toEqual({ name: 'S', role: 'series' });                            // absent level dropped
    expect(s.dimensions[2]).toEqual({ name: 'F', role: 'filter', member: 'West' });
  });

  it('drops a non-string level to undefined (tolerant per-field)', () => {
    const s = wrap({ source: 'cube', cube: 'C', measures: ['M'], dimensions: [{ name: 'D', role: 'category', level: 42 }] });
    expect(s.dimensions[0]).toEqual({ name: 'D', role: 'category' });
  });

  it('rejects a cube selection with an empty/absent measures[]', () => {
    expect(() => wrap({ source: 'cube', cube: 'C', measures: [] })).toThrow(ValidationError);
    expect(() => wrap({ source: 'cube', cube: 'C' })).toThrow(ValidationError);
  });

  it('rejects a filter dimension with no member, and an unknown role', () => {
    expect(() => wrap({ source: 'cube', cube: 'C', measures: ['M'], dimensions: [{ name: 'F', role: 'filter' }] })).toThrow(ValidationError);
    expect(() => wrap({ source: 'cube', cube: 'C', measures: ['M'], dimensions: [{ name: 'D', role: 'axis' }] })).toThrow(ValidationError);
  });

  it('drops a malformed dimensions value to undefined (tolerant), keeping a valid measures-only chart', () => {
    const s = wrap({ source: 'cube', cube: 'C', measures: ['M'], dimensions: 'nope' });
    expect(s).toEqual({ source: 'cube', cube: 'C', measures: ['M'] });
  });
});

describe('validateTableSelection — columns (Track B, tolerant)', () => {
  const withCols = (columns: unknown) =>
    validateDashboardConfig({ schemaVersion: 1, tiles: [{ ...tableTile, selection: { table: 'SC.Data.Product', columns } }] })
      .tiles[0]!.selection as { table: string; columns?: string[] };

  it('keeps a valid ordered subset of column names', () => {
    expect(withCols(['name', 'uid'])).toEqual({ table: 'SC.Data.Product', columns: ['name', 'uid'] });
  });
  it('drops an empty array (equivalent to "all columns")', () => {
    expect(withCols([])).toEqual({ table: 'SC.Data.Product' });
  });
  it('drops a non-array columns value', () => {
    expect(withCols('name,uid')).toEqual({ table: 'SC.Data.Product' });
    expect(withCols({ 0: 'name' })).toEqual({ table: 'SC.Data.Product' });
  });
  it('drops the whole columns field when any member is a non-string or blank', () => {
    expect(withCols(['name', 42])).toEqual({ table: 'SC.Data.Product' });
    expect(withCols(['name', '  '])).toEqual({ table: 'SC.Data.Product' });
    expect(withCols(['name', ''])).toEqual({ table: 'SC.Data.Product' });
  });
  it('a table tile with no columns key stays valid and minimal (no columns key)', () => {
    const out = validateDashboardConfig({ schemaVersion: 1, tiles: [tableTile] });
    expect(out.tiles[0]!.selection).toEqual({ table: 'SC.Data.Product' });
    expect(out.tiles[0]!.selection).not.toHaveProperty('columns');
  });
});

describe('validateDashboardConfig — funnelSort persistence', () => {
  it('keeps a valid funnelSort on a cube selection', () => {
    const tile = { id: 't1', kind: 'chart', layout: { w: 1, h: 1 }, selection: { source: 'cube', cube: 'X', measures: ['m'], chartType: 'funnel', funnelSort: 'source' } };
    const out = validateDashboardConfig({ schemaVersion: 1, tiles: [tile] });
    expect(out.tiles[0]!.selection).toMatchObject({ chartType: 'funnel', funnelSort: 'source' });
  });
  it('drops an invalid funnelSort', () => {
    const tile = { id: 't1', kind: 'chart', layout: { w: 1, h: 1 }, selection: { source: 'cube', cube: 'X', measures: ['m'], funnelSort: 'sideways' } };
    const out = validateDashboardConfig({ schemaVersion: 1, tiles: [tile] });
    expect(out.tiles[0]!.selection).not.toHaveProperty('funnelSort');
  });
});
