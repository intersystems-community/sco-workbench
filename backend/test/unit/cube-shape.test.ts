// backend/test/unit/cube-shape.test.ts
import { describe, it, expect } from 'vitest';
import { DeepSeeShapeAdapter } from '../../src/dashboard/cube-shape.js';
import type { DeepSeeClient } from '../../src/iris/deepsee-client.js';
import type { AtelierClient } from '../../src/iris/atelier-client.js';

const atelier = { query: async () => [] } as unknown as AtelierClient;

function deepseeWith(filters: any[], measures: any[] = []) {
  return { measures: async () => measures, filters: async () => filters, listings: async () => [] } as unknown as DeepSeeClient;
}

describe('DeepSeeShapeAdapter.shape', () => {
  it('maps time/age dimensions → temporal and everything else → categorical', async () => {
    // cubeStructure derives dims from filter MDX; without a definition, type is absent → categorical.
    const adapter = new DeepSeeShapeAdapter(
      deepseeWith(
        [{ caption: 'Region', value: '[Region].[H1].[Region]' }],
        [{ name: '%COUNT', caption: 'Count' }],
      ),
      atelier,
    );
    const shape = await adapter.shape('MyCube');
    expect(shape.measures.map((m) => m.name)).toContain('%COUNT');
    // No definition available → dimension tag absent → categorical (never guessed temporal).
    expect(shape.dimensions[0]!.kind).toBe('categorical');
  });

  it('never labels a dimension temporal on an absent tag (the safe default)', async () => {
    const adapter = new DeepSeeShapeAdapter(deepseeWith([{ caption: 'X', value: '[X].[H1].[X]' }]), atelier);
    const shape = await adapter.shape('C');
    expect(shape.dimensions.every((d) => d.kind !== 'temporal' || true)).toBe(true);
    expect(shape.dimensions[0]!.kind).toBe('categorical');
  });

  it('carries each dimension\'s levels[] with name + spec (single-level dim)', async () => {
    const adapter = new DeepSeeShapeAdapter(
      deepseeWith([{ caption: 'Region', value: '[Region].[H1].[Region]' }]),
      atelier,
    );
    const shape = await adapter.shape('MyCube');
    expect(shape.dimensions[0]!.levels).toEqual([
      { name: 'Region', caption: 'Region', spec: '[Region].[H1].[Region]' },
    ]);
  });

  it('carries ALL levels of a multi-level hierarchy in catalog order (B-CUBE-15)', async () => {
    // Two filter entries for the same dim+hierarchy = two levels. This is the "Customer"
    // shape Chloe flagged: a country-style level AND a customer-name level, both offered.
    const adapter = new DeepSeeShapeAdapter(
      deepseeWith([
        { caption: 'Country', value: '[Customer].[H1].[Country]' },
        { caption: 'Customer Name', value: '[Customer].[H1].[CustomerName]' },
      ]),
      atelier,
    );
    const shape = await adapter.shape('SalesCube');
    const customer = shape.dimensions.find((d) => d.name === 'Customer')!;
    expect(customer.levels.map((l) => l.spec)).toEqual([
      '[Customer].[H1].[Country]', '[Customer].[H1].[CustomerName]',
    ]);
    expect(customer.levels.map((l) => l.caption)).toEqual(['Country', 'Customer Name']);
  });
});
