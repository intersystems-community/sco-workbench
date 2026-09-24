import { previewOrder, snapSpan } from './dashboard-drag';
import type { TileConfig } from './dashboard-config';

const t = (id: string): TileConfig => ({ id, kind: 'table', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Product' } });
const ids = (tiles: TileConfig[]) => tiles.map((x) => x.id);

describe('dashboard-drag — previewOrder', () => {
  const tiles = [t('a'), t('b'), t('c'), t('d')];
  it('re-inserts the dragged tile at the target index (move forward)', () => {
    expect(ids(previewOrder(tiles, 'a', 2))).toEqual(['b', 'c', 'a', 'd']);
  });
  it('re-inserts the dragged tile at the target index (move backward)', () => {
    expect(ids(previewOrder(tiles, 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
  });
  it('is identity when the target equals the current index', () => {
    expect(ids(previewOrder(tiles, 'b', 1))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('clamps an out-of-range target', () => {
    expect(ids(previewOrder(tiles, 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(previewOrder(tiles, 'd', -3))).toEqual(['d', 'a', 'b', 'c']);
  });
  it('returns the input order for an unknown id', () => {
    expect(ids(previewOrder(tiles, 'zzz', 0))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('does not mutate the input array', () => {
    const before = ids(tiles);
    previewOrder(tiles, 'a', 3);
    expect(ids(tiles)).toEqual(before);
  });
});

describe('dashboard-drag — snapSpan (nearest preset; divisor is the MEASURED cell, not 360)', () => {
  const GAP = 16;
  // A GROWN column on a wide desktop (the regression the review flagged): cellW=480, not 360.
  it('snaps width against the measured column width, not the 360 constant', () => {
    expect(snapSpan(480, 360, 480, 360, GAP).w).toBe(1); // ~one grown cell → 1 col
    expect(snapSpan(2 * 480 + GAP, 360, 480, 360, GAP).w).toBe(2); // two grown cells + a gap → 2 cols
    expect(snapSpan(3 * 480 + 2 * GAP, 360, 480, 360, GAP).w).toBe(3);
  });
  it('clamps to the six presets (w∈{1,2,3}, h∈{1,2})', () => {
    expect(snapSpan(5, 5, 480, 360, GAP)).toEqual({ w: 1, h: 1 });          // tiny drag → smallest
    expect(snapSpan(9999, 9999, 480, 360, GAP)).toEqual({ w: 3, h: 2 });    // huge drag → largest
  });
  it('snaps height against the 360 row track', () => {
    expect(snapSpan(480, 360, 480, 360, GAP).h).toBe(1);
    expect(snapSpan(480, 2 * 360 + GAP, 480, 360, GAP).h).toBe(2);
  });
});
