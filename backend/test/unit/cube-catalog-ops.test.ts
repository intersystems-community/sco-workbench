import { describe, it, expect } from 'vitest';
import { NativeClient, type ConnectionFactory } from '../../src/iris/native-client.js';
import {
  listCubes,
  cubeDetail,
  deleteCube,
  cubeStructure,
  structureFromDefinition,
  dimensionsFromFilters,
  parseMdxLevel,
} from '../../src/iris/cube-catalog-ops.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';
import type { AtelierClient } from '../../src/iris/atelier-client.js';
import type { DeepSeeClient } from '../../src/iris/deepsee-client.js';

const cfg = { host: 'h', port: 1972, namespace: 'SC', user: 'u', password: 'p' };

/** A NativeClient whose classMethodValue is driven by `impl`. */
function clientWith(impl: (cls: string, method: string, args: unknown[]) => unknown) {
  const factory: ConnectionFactory = () => ({
    close: () => {},
    isClosed: () => false,
    createIris: () => ({
      classMethodValue: (cls, method, ...args) => impl(cls, method, args),
      classMethodVoid: () => {},
      classMethodObject: () => null,
    }),
  });
  return new NativeClient(cfg, factory);
}

/** A fake AtelierClient exposing only query(), which is all these ops use. */
function atelierWith(rowsFor: (sql: string, params: unknown[]) => unknown[]): AtelierClient {
  return {
    query: async (sql: string, params: unknown[] = []) => rowsFor(sql, params),
  } as unknown as AtelierClient;
}

describe('listCubes', () => {
  it('maps dictionary rows to summaries (cube name = class short name, source = DependsOn)', async () => {
    const atelier = atelierWith(() => [
      { Name: 'SC.Core.Analytics.Cube.SalesOrderCube', DependsOn: 'SC.Data.SalesOrder' },
      { Name: 'SC.Core.Analytics.Cube.IssueCube', DependsOn: 'SC.Data.Issue,Other.Dep' },
    ]);
    const cubes = await listCubes(atelier);
    expect(cubes).toEqual([
      {
        // An SCO built-in cube → NOT editable in the Workbench.
        className: 'SC.Core.Analytics.Cube.SalesOrderCube',
        cubeName: 'SalesOrderCube',
        sourceClass: 'SC.Data.SalesOrder',
        editable: false,
      },
      {
        // DependsOn may be a comma list; the source is the first entry.
        className: 'SC.Core.Analytics.Cube.IssueCube',
        cubeName: 'IssueCube',
        sourceClass: 'SC.Data.Issue',
        editable: false,
      },
    ]);
  });

  it('marks Workbench cubes (SC.Workbench.Cube.*) as editable', async () => {
    const atelier = atelierWith(() => [
      { Name: 'SC.Workbench.Cube.MyCube', DependsOn: 'SC.Data.Thing' },
    ]);
    const cubes = await listCubes(atelier);
    expect(cubes[0]).toMatchObject({ cubeName: 'MyCube', editable: true });
  });

  it('drops rows without a Name', async () => {
    const atelier = atelierWith(() => [{ DependsOn: 'X' }, { Name: 'A.B.C' }]);
    const cubes = await listCubes(atelier);
    expect(cubes).toHaveLength(1);
    expect(cubes[0]!.cubeName).toBe('C');
  });
});

describe('cubeDetail', () => {
  it('resolves the class name from a bare cube name and reports build state', async () => {
    // Bare-name resolution queries the dictionary for cube subclasses and
    // matches by short name.
    const atelier = atelierWith(() => [
      { Name: 'SC.Core.Analytics.Cube.SalesOrderCube', DependsOn: 'SC.Data.SalesOrder' },
    ]);
    const native = clientWith((_cls, method) => {
      if (method === '%CubeExists') return 1;
      if (method === '%GetCubeFactClass') return 'SC.Core.Analytics.Cube.SalesOrderCube.Fact';
      if (method === '%GetCubeFactCount') return 1445;
      return undefined;
    });
    const detail = await cubeDetail(native, atelier, 'SalesOrderCube');
    expect(detail).toEqual({
      cubeName: 'SalesOrderCube',
      className: 'SC.Core.Analytics.Cube.SalesOrderCube',
      sourceClass: 'SC.Data.SalesOrder',
      exists: true,
      editable: false,
      factClass: 'SC.Core.Analytics.Cube.SalesOrderCube.Fact',
      factCount: 1445,
    });
  });

  it('reports exists=false without fact info when the cube is not built', async () => {
    const atelier = atelierWith(() => []);
    const native = clientWith((_cls, method) => (method === '%CubeExists' ? 0 : undefined));
    const detail = await cubeDetail(native, atelier, 'Ghost');
    expect(detail.exists).toBe(false);
    expect(detail.factClass).toBeUndefined();
    expect(detail.factCount).toBeUndefined();
  });

  it('tolerates a dictionary query failure (source class undefined)', async () => {
    const atelier = {
      query: async () => {
        throw new Error('dict down');
      },
    } as unknown as AtelierClient;
    const native = clientWith((_cls, method) => (method === '%CubeExists' ? 0 : undefined));
    const detail = await cubeDetail(native, atelier, 'X');
    expect(detail.sourceClass).toBeUndefined();
    expect(detail.exists).toBe(false);
  });
});

describe('deleteCube', () => {
  const WB = 'SC.Workbench.Cube.MyCube';

  it('refuses to delete a non-Workbench (SCO built-in) cube', () => {
    const native = clientWith(() => 1);
    const res = deleteCube(native, 'SC.Core.Analytics.Cube.SalesOrderCube');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/only Workbench cubes/i);
  });

  it('kills the cube data THEN deletes the class, in that order', async () => {
    const calls: Array<[string, string]> = [];
    const native = clientWith((cls, method) => {
      calls.push([cls, method]);
      if (method === '%CubeExists') return 1;
      if (method === '%KillCube') return 1;
      if (method === 'Delete') return 1;
      return undefined;
    });
    const res = deleteCube(native, WB);
    expect(res.ok).toBe(true);
    const methods = calls.map((c) => c[1]);
    expect(methods.indexOf('%KillCube')).toBeLessThan(methods.indexOf('Delete'));
    expect(calls).toContainEqual(['%SYSTEM.OBJ', 'Delete']);
  });

  it('skips %KillCube when the cube does not exist but still deletes the class', () => {
    const calls: string[] = [];
    const native = clientWith((_cls, method) => {
      calls.push(method);
      if (method === '%CubeExists') return 0;
      if (method === 'Delete') return 1;
      return undefined;
    });
    const res = deleteCube(native, WB);
    expect(res.ok).toBe(true);
    expect(calls).not.toContain('%KillCube');
    expect(calls).toContain('Delete');
  });

  it('fails cleanly when %KillCube errors', () => {
    const native = clientWith((_cls, method) => {
      if (method === '%CubeExists') return 1;
      if (method === '%KillCube') return '0 err';
      if (method === 'GetErrorText') return 'ERROR #5002: kill failed';
      return undefined;
    });
    const res = deleteCube(native, WB);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/#5002/);
  });

  it('fails when the class delete errors after data drop', () => {
    const native = clientWith((_cls, method) => {
      if (method === '%CubeExists') return 1;
      if (method === '%KillCube') return 1;
      if (method === 'Delete') return '0 err';
      if (method === 'GetErrorText') return 'ERROR #5090: cannot delete';
      return undefined;
    });
    const res = deleteCube(native, WB);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/deleting the class failed/);
  });
});

describe('parseMdxLevel', () => {
  it('splits a 3-part MDX spec into dim/hier/level', () => {
    expect(parseMdxLevel('[orderPlacedDate].[H1].[Year]')).toEqual({
      dim: 'orderPlacedDate',
      hier: 'H1',
      level: 'Year',
    });
  });

  it('returns null for non-3-part or missing specs', () => {
    expect(parseMdxLevel(undefined)).toBeNull();
    expect(parseMdxLevel('[measures].[totalOrderValue]')).toBeNull();
    expect(parseMdxLevel('not-mdx')).toBeNull();
  });
});

describe('dimensionsFromFilters', () => {
  it('groups flat filter levels into a dimension → hierarchy → level tree, preserving order', () => {
    const dims = dimensionsFromFilters([
      { caption: 'Order Status', value: '[orderStatus].[H1].[orderStatus]' },
      { caption: 'Year', value: '[orderPlacedDate].[H1].[Year]', type: 'year' },
      { caption: 'Month', value: '[orderPlacedDate].[H1].[Month]', type: 'month' },
      { caption: 'noise', value: '[measures].[x]' }, // dropped (not 3-part)
    ]);
    expect(dims).toHaveLength(2);
    expect(dims[0]).toEqual({
      name: 'orderStatus',
      hierarchies: [
        { name: 'H1', levels: [{ name: 'orderStatus', caption: 'Order Status', spec: '[orderStatus].[H1].[orderStatus]' }] },
      ],
    });
    // The two orderPlacedDate levels collapse under one dimension → one hierarchy.
    expect(dims[1]!.name).toBe('orderPlacedDate');
    expect(dims[1]!.hierarchies[0]!.levels.map((l) => l.name)).toEqual(['Year', 'Month']);
    expect(dims[1]!.hierarchies[0]!.levels[0]!.type).toBe('year');
  });
});

describe('cubeStructure', () => {
  it('assembles measures + dimensions + listings from the DeepSee client', async () => {
    const deepsee = {
      measures: async () => [
        { name: '%COUNT', caption: 'Count', type: 'integer', hidden: 0, factName: '' },
        { name: 'totalOrderValue', caption: 'Total Order Value', type: 'number', hidden: 0, factName: 'MxorderValue' },
      ],
      filters: async () => [{ caption: 'Sales Region', value: '[salesRegion].[H1].[salesRegion]' }],
      listings: async () => [
        { name: 'salesOrderListing', fields: 'uid,orderValue', order: 'orderPlacedDate', type: 'table' },
      ],
    } as unknown as DeepSeeClient;

    const s = await cubeStructure(deepsee, 'SalesOrderCube');
    expect(s.measures.map((m) => m.name)).toEqual(['%COUNT', 'totalOrderValue']);
    expect(s.measures[1]!.factName).toBe('MxorderValue');
    expect(s.dimensions[0]!.name).toBe('salesRegion');
    expect(s.dimensions[0]!.hierarchies[0]!.levels[0]!.name).toBe('salesRegion');
    expect(s.listings[0]).toMatchObject({ name: 'salesOrderListing', type: 'table' });
  });

  it('degrades each part to empty on error (no throw)', async () => {
    const deepsee = {
      measures: async () => {
        throw new Error('down');
      },
      filters: async () => {
        throw new Error('down');
      },
      listings: async () => {
        throw new Error('down');
      },
    } as unknown as DeepSeeClient;
    const s = await cubeStructure(deepsee, 'X');
    expect(s).toEqual({ measures: [], dimensions: [], listings: [] });
  });

  it('merges sourceProperty from the definition — incl. a time dim shared date field', async () => {
    const deepsee = {
      measures: async () => [],
      filters: async () => [
        { caption: 'Region', value: '[RegionD].[H1].[Region]' },
        { caption: 'Year', value: '[DateD].[H1].[Year]', type: 'year' },
        { caption: 'Month', value: '[DateD].[H1].[Month]', type: 'month' },
      ],
      listings: async () => [],
    } as unknown as DeepSeeClient;
    const definition = {
      cubeName: 'C',
      sourceClass: 'X.Y',
      dimensions: [
        { name: 'RegionD', type: 'data', hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'region', factNumber: 2 }] }] },
        {
          name: 'DateD',
          type: 'time',
          hierarchies: [{ name: 'H1', levels: [
            { name: 'Year', sourceProperty: 'orderDate', timeFunction: 'Year', factNumber: 3 },
            { name: 'Month', sourceProperty: 'orderDate', timeFunction: 'MonthYear', factNumber: 4 },
          ] }],
        },
      ],
      measures: [],
    } as any;
    const s = await cubeStructure(deepsee, 'C', definition);
    const region = s.dimensions.find((d) => d.name === 'RegionD')!.hierarchies[0]!.levels[0]!;
    expect(region.sourceProperty).toBe('region');
    // Both time levels show the shared date field AND keep their time function (type).
    const dateLevels = s.dimensions.find((d) => d.name === 'DateD')!.hierarchies[0]!.levels;
    expect(dateLevels.every((l) => l.sourceProperty === 'orderDate')).toBe(true);
    expect(dateLevels.map((l) => l.type)).toEqual(['year', 'month']);
    // NEW — the temporal tag is surfaced from CubeDefinition.dimensions[].type so
    // the charting layer can tell a temporal axis from a categorical one.
    expect(s.dimensions.find((d) => d.name === 'DateD')!.type).toBe('time');
    expect(s.dimensions.find((d) => d.name === 'RegionD')!.type).toBe('data');
  });
});

describe('structureFromDefinition (unbuilt cube detail)', () => {
  const def: CubeDefinition = {
    cubeName: 'C',
    sourceClass: 'SC.Data.SalesOrder',
    dimensions: [
      {
        name: 'RegionD',
        type: 'data',
        hierarchies: [{ name: 'H1', levels: [{ name: 'Region', displayName: 'Region', sourceProperty: 'salesRegion', factNumber: 2 }] }],
      },
    ],
    measures: [{ name: 'Total', displayName: 'Total', sourceProperty: 'orderValue', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3 }],
  };

  it('derives measures + the dimension tree straight from a draft definition', () => {
    const s = structureFromDefinition(def);
    expect(s.measures).toEqual([
      { name: 'Total', caption: 'Total', type: 'number', hidden: undefined, factName: 'MxTotal' },
    ]);
    const level = s.dimensions[0]!.hierarchies[0]!.levels[0]!;
    expect(s.dimensions[0]!.name).toBe('RegionD');
    expect(level.name).toBe('Region');
    expect(level.sourceProperty).toBe('salesRegion');
    expect(level.spec).toBe('[RegionD].[H1].[Region]');
    expect(s.listings).toEqual([]);
  });

  it('propagates a time dimension shared date field onto each level', () => {
    const timeDef: CubeDefinition = {
      cubeName: 'C',
      sourceClass: 'X.Y',
      dimensions: [
        {
          name: 'DateD',
          type: 'time',
          sourceProperty: 'orderDate',
          hierarchies: [{ name: 'H1', levels: [
            { name: 'Year', timeFunction: 'Year', factNumber: 2 },
            { name: 'Month', timeFunction: 'MonthYear', factNumber: 3 },
          ] }],
        },
      ],
      measures: [],
    };
    const s = structureFromDefinition(timeDef);
    const levels = s.dimensions[0]!.hierarchies[0]!.levels;
    expect(levels.every((l) => l.sourceProperty === 'orderDate')).toBe(true);
    expect(levels.map((l) => l.type)).toEqual(['Year', 'MonthYear']);
  });

  it('drops unnamed dimensions/levels and hierarchies with no named level', () => {
    const messy: CubeDefinition = {
      cubeName: 'C',
      sourceClass: 'X.Y',
      dimensions: [
        { name: '', type: 'data', hierarchies: [] },
        { name: 'D', type: 'data', hierarchies: [{ name: 'H1', levels: [{ name: '', factNumber: 2 }] }] },
      ],
      measures: [],
    };
    const s = structureFromDefinition(messy);
    expect(s.dimensions).toEqual([{ name: 'D', hierarchies: [] }]);
  });
});
