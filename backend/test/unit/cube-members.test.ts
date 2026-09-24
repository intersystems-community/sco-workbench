import { describe, it, expect, vi } from 'vitest';
import { DeepSeeMemberReader } from '../../src/dashboard/cube-members.js';
import { NotFoundError, QueryError } from '../../src/iris/iris-error.js';
import type { CubeShape, CubeShapeReader } from '../../src/dashboard/chart-data.js';
import mdxMembers from './fixtures/mdx-members.sample.json' with { type: 'json' };

const shape: CubeShape = {
  cube: 'SalesCube',
  measures: [{ name: 'Revenue' }],
  dimensions: [{ name: 'region', kind: 'categorical', levels: [{ name: 'Region', spec: '[region].[H1].[Region]' }] }],
};
const shapeReader: CubeShapeReader = { shape: async () => shape };
// The multi-level "Customer" shape (Country + Customer Name) — Chloe's flagged case — for the level cases.
const customerShape: CubeShape = {
  cube: 'SalesCube',
  measures: [{ name: 'Revenue' }],
  dimensions: [{ name: 'Customer', kind: 'categorical', levels: [
    { name: 'Country', caption: 'Country', spec: '[Customer].[H1].[Country]' },
    { name: 'CustomerName', caption: 'Customer Name', spec: '[Customer].[H1].[CustomerName]' },
  ] }],
};

describe('DeepSeeMemberReader', () => {
  it('composes MEMBERS MDX from the FIRST level spec (absent level) and parses member names off Axis 0', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxMembers);
    const reader = new DeepSeeMemberReader(shapeReader, { mdxExecute });
    const members = await reader.members('SalesCube', 'region');
    const mdx = mdxExecute.mock.calls[0]![0] as string;
    expect(mdx).toBe('SELECT {[region].[H1].[Region].MEMBERS} ON 0 FROM [SalesCube]');
    expect(members.map((m) => m.name)).toEqual(['West', 'East', 'North']);
  });

  it('enumerates the CHOSEN level when a level spec is passed (B-CUBE-15)', async () => {
    const mdxExecute = vi.fn().mockResolvedValue(mdxMembers);
    const reader = new DeepSeeMemberReader({ shape: async () => customerShape }, { mdxExecute });
    await reader.members('SalesCube', 'Customer', '[Customer].[H1].[CustomerName]');
    expect(mdxExecute.mock.calls[0]![0]).toBe('SELECT {[Customer].[H1].[CustomerName].MEMBERS} ON 0 FROM [SalesCube]');
  });

  it('rejects an unknown level with NotFoundError (candidates = the dimension\'s level specs), never calling mdxExecute (B-CUBE-15)', async () => {
    const mdxExecute = vi.fn();
    const reader = new DeepSeeMemberReader({ shape: async () => customerShape }, { mdxExecute });
    await expect(reader.members('SalesCube', 'Customer', '[Customer].[H1].[Nope]')).rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('falls back to [dim].MEMBERS when the shape carries no levels', async () => {
    const noSpec: CubeShape = { cube: 'SalesCube', measures: [{ name: 'Revenue' }], dimensions: [{ name: 'region', kind: 'categorical', levels: [] }] };
    const mdxExecute = vi.fn().mockResolvedValue(mdxMembers);
    const reader = new DeepSeeMemberReader({ shape: async () => noSpec }, { mdxExecute });
    await reader.members('SalesCube', 'region');
    expect(mdxExecute.mock.calls[0]![0]).toBe('SELECT {[region].MEMBERS} ON 0 FROM [SalesCube]');
  });

  it('rejects an unknown dimension with NotFoundError + candidates, never calling mdxExecute', async () => {
    const mdxExecute = vi.fn();
    const reader = new DeepSeeMemberReader(shapeReader, { mdxExecute });
    await expect(reader.members('SalesCube', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(mdxExecute).not.toHaveBeenCalled();
  });

  it('turns an Info.Error MDX rejection into a QueryError', async () => {
    const mdxExecute = vi.fn().mockResolvedValue({ Info: { Error: 'bad' }, Result: {} });
    const reader = new DeepSeeMemberReader(shapeReader, { mdxExecute });
    await expect(reader.members('SalesCube', 'region')).rejects.toBeInstanceOf(QueryError);
  });

  it('maps the member key from MemberInfo.memberKey (NOT the internal memberID) alongside the name', async () => {
    // Live shape (verified against ProductInventoryCube): memberKey is the real MDX
    // key that goes inside `&[...]`; memberID is an internal positional id
    // ("Member_1"). They DIFFER — pinning distinct values here so a fixture where
    // id==key can never again mask a read of the wrong field.
    const mdxExecute = vi.fn().mockResolvedValue({
      Info: { Error: '' },
      Result: {
        Axes: [{ Tuples: [
          { Members: [{ Name: 'Battery' }], MemberInfo: [{ memberID: 'Member_1', memberKey: 'Battery', dimName: 'productCategory', levelName: 'Category' }] },
          { Members: [{ Name: 'Cable' }], MemberInfo: [{ memberID: 'Member_2', memberKey: 'Cable' }] },
        ] }],
        CellData: [],
      },
    });
    const reader = new DeepSeeMemberReader(shapeReader, { mdxExecute });
    const members = await reader.members('SalesCube', 'region');
    expect(members).toEqual([
      { name: 'Battery', key: 'Battery' },
      { name: 'Cable', key: 'Cable' },
    ]);
  });

  it('omits key when MemberInfo carries only the internal memberID (no memberKey)', async () => {
    // A tuple with memberID but no memberKey must NOT emit `&[Member_1]` — degrade
    // to name form rather than a non-resolving internal-id reference.
    const mdxExecute = vi.fn().mockResolvedValue({
      Info: { Error: '' },
      Result: {
        Axes: [{ Tuples: [{ Members: [{ Name: 'Battery' }], MemberInfo: [{ memberID: 'Member_1' }] }] }],
        CellData: [],
      },
    });
    const reader = new DeepSeeMemberReader(shapeReader, { mdxExecute });
    expect(await reader.members('SalesCube', 'region')).toEqual([{ name: 'Battery' }]);
  });

  it('omits key when the tuple has no MemberInfo (degrades to name only)', async () => {
    const mdxExecute = vi.fn().mockResolvedValue({
      Info: { Error: '' },
      Result: { Axes: [{ Tuples: [{ Members: [{ Name: 'West' }] }] }], CellData: [] },
    });
    const reader = new DeepSeeMemberReader(shapeReader, { mdxExecute });
    expect(await reader.members('SalesCube', 'region')).toEqual([{ name: 'West' }]);
  });
});
