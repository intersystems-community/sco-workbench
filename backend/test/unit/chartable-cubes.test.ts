// backend/test/unit/chartable-cubes.test.ts
//
// The chartable-cube finder: returns EVERY cube with its measure and dimension
// counts (including 0-count residue cubes). The frontend decides chartability
// from the counts (≥1 measure AND ≥1 dimension) and disables non-chartable ones
// in the picker. A cube whose shape read FAILS (crash-level) is excluded. This
// change (Change 1) makes the backend report facts; the frontend decides policy.
import { describe, it, expect, vi } from 'vitest';
import { ChartableCubeFinder } from '../../src/dashboard/chartable-cubes.js';
import type { CubeCatalog, CubeCatalogEntry, CubeShape, CubeShapeReader } from '../../src/dashboard/chart-data.js';

const REAL: CubeCatalogEntry = { cubeName: 'ProductInventoryCube', className: 'SC.Core.Analytics.Cube.ProductInventory', editable: false };
const RESIDUE: CubeCatalogEntry = { cubeName: 'WorkbenchTestCubeIT3442x12', className: 'SC.Workbench.Cube.WorkbenchTestCubeIT3442x12', editable: true };
const MEASURE_NO_DIM: CubeCatalogEntry = { cubeName: 'ScalarOnly', className: 'SC.X.ScalarOnly', editable: true };
const DIM_NO_MEASURE: CubeCatalogEntry = { cubeName: 'DimsOnly', className: 'SC.X.DimsOnly', editable: true };

/** A shape reader keyed by cube name, returning the given measure/dimension counts. */
function shapeReaderFor(shapes: Record<string, { m: number; d: number } | Error>): CubeShapeReader {
  return {
    shape: vi.fn(async (cube: string): Promise<CubeShape> => {
      const s = shapes[cube];
      if (s === undefined) throw new Error(`no shape stubbed for ${cube}`);
      if (s instanceof Error) throw s;
      return {
        cube,
        measures: Array.from({ length: s.m }, (_, i) => ({ name: `m${i}` })),
        dimensions: Array.from({ length: s.d }, (_, i) => ({ name: `d${i}`, kind: 'categorical' as const, levels: [] })),
      };
    }),
  };
}

function catalogOf(...entries: CubeCatalogEntry[]): CubeCatalog {
  return { listCubes: vi.fn(async () => entries) };
}

describe('ChartableCubeFinder', () => {
  it('keeps a cube with BOTH measures and dimensions', async () => {
    const finder = new ChartableCubeFinder(
      catalogOf(REAL),
      shapeReaderFor({ ProductInventoryCube: { m: 5, d: 9 } }),
    );
    const cubes = await finder.list();
    expect(cubes.map((c) => c.cubeName)).toEqual(['ProductInventoryCube']);
    expect(cubes[0]).toMatchObject({ measureCount: 5, dimensionCount: 9, editable: false });
  });

  it('keeps a residue cube with zero measures and zero dimensions (shown, not dropped)', async () => {
    const finder = new ChartableCubeFinder(
      catalogOf(REAL, RESIDUE),
      shapeReaderFor({ ProductInventoryCube: { m: 5, d: 9 }, WorkbenchTestCubeIT3442x12: { m: 0, d: 0 } }),
    );
    const cubes = await finder.list();
    expect(cubes.map((c) => c.cubeName)).toEqual(['ProductInventoryCube', 'WorkbenchTestCubeIT3442x12']);
    expect(cubes.find((c) => c.cubeName === 'WorkbenchTestCubeIT3442x12'))
      .toMatchObject({ measureCount: 0, dimensionCount: 0 });
  });

  it('keeps a cube with a measure but NO dimension, carrying its real counts', async () => {
    const finder = new ChartableCubeFinder(
      catalogOf(MEASURE_NO_DIM),
      shapeReaderFor({ ScalarOnly: { m: 3, d: 0 } }),
    );
    const cubes = await finder.list();
    expect(cubes.map((c) => c.cubeName)).toEqual(['ScalarOnly']);
    expect(cubes[0]).toMatchObject({ measureCount: 3, dimensionCount: 0 });
  });

  it('keeps a cube with a dimension but NO measure, carrying its real counts', async () => {
    const finder = new ChartableCubeFinder(
      catalogOf(DIM_NO_MEASURE),
      shapeReaderFor({ DimsOnly: { m: 0, d: 4 } }),
    );
    const cubes = await finder.list();
    expect(cubes.map((c) => c.cubeName)).toEqual(['DimsOnly']);
    expect(cubes[0]).toMatchObject({ measureCount: 0, dimensionCount: 4 });
  });

  it('treats a cube whose shape read FAILS as non-chartable (never crashes the list)', async () => {
    const finder = new ChartableCubeFinder(
      catalogOf(REAL, RESIDUE),
      shapeReaderFor({ ProductInventoryCube: { m: 5, d: 9 }, WorkbenchTestCubeIT3442x12: new Error('boom') }),
    );
    const cubes = await finder.list();
    // The failing cube is silently excluded (it cannot be charted if its shape
    // can't be read); the healthy one still comes through.
    expect(cubes.map((c) => c.cubeName)).toEqual(['ProductInventoryCube']);
  });

  it('preserves catalog order across all cubes (chartable and not)', async () => {
    const a: CubeCatalogEntry = { cubeName: 'Alpha', className: 'X.Alpha', editable: false };
    const b: CubeCatalogEntry = { cubeName: 'Beta', className: 'X.Beta', editable: false };
    const finder = new ChartableCubeFinder(
      catalogOf(a, RESIDUE, b),
      shapeReaderFor({ Alpha: { m: 1, d: 1 }, Beta: { m: 2, d: 3 }, WorkbenchTestCubeIT3442x12: { m: 0, d: 0 } }),
    );
    expect((await finder.list()).map((c) => c.cubeName)).toEqual(['Alpha', 'WorkbenchTestCubeIT3442x12', 'Beta']);
  });

  it('resolves shapes concurrently (one shape call per catalog cube)', async () => {
    const reader = shapeReaderFor({ ProductInventoryCube: { m: 5, d: 9 }, WorkbenchTestCubeIT3442x12: { m: 0, d: 0 } });
    const finder = new ChartableCubeFinder(catalogOf(REAL, RESIDUE), reader);
    await finder.list();
    expect(reader.shape).toHaveBeenCalledTimes(2);
  });
});
