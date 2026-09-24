import { describe, it, expect } from 'vitest';
import { generateCubeClass } from '../../src/cube/cube-generator.js';
import { parseCubeClass } from '../../src/cube/cube-parser.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

/**
 * The parser must round-trip the generator's output for the "Core + multi-level
 * hierarchies" feature set, so the edit form reloads exactly what was created.
 */
describe('parseCubeClass round-trip', () => {
  const def: CubeDefinition = {
    cubeName: 'WidgetCube',
    sourceClass: 'Workbench.Test.Widget',
    description: 'A demo cube',
    displayName: 'Widget Cube',
    dimensions: [
      {
        name: 'DateD',
        type: 'time',
        hasAll: true,
        hierarchies: [
          {
            name: 'H1',
            levels: [
              { name: 'Year', sourceProperty: 'orderDate', timeFunction: 'Year', factNumber: 2 },
              { name: 'Month', sourceProperty: 'orderDate', timeFunction: 'MonthYear', factNumber: 3 },
            ],
          },
        ],
      },
      {
        name: 'RegionD',
        type: 'data',
        hasAll: true,
        hierarchies: [
          { name: 'H1', levels: [{ name: 'Region', sourceProperty: 'region', nullReplacement: 'Unknown', factNumber: 4 }] },
        ],
      },
    ],
    measures: [
      { name: 'Total', sourceProperty: 'amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 5 },
      { name: 'Avg', sourceProperty: 'amount', factName: 'MxAvg', aggregate: 'AVG', type: 'number', factNumber: 6 },
    ],
  };

  it('parses cube identity (name, source, description, displayName)', () => {
    const parsed = parseCubeClass(generateCubeClass(def));
    expect(parsed).not.toBeNull();
    expect(parsed!.cubeName).toBe('WidgetCube');
    expect(parsed!.sourceClass).toBe('Workbench.Test.Widget');
    expect(parsed!.description).toBe('A demo cube');
    expect(parsed!.displayName).toBe('Widget Cube');
  });

  it('parses a multi-level time hierarchy with timeFunctions', () => {
    const parsed = parseCubeClass(generateCubeClass(def))!;
    const dateDim = parsed.dimensions!.find((d) => d.name === 'DateD')!;
    expect(dateDim.type).toBe('time');
    const levels = dateDim.hierarchies[0]!.levels;
    expect(levels.map((l) => l.name)).toEqual(['Year', 'Month']);
    expect(levels[0]!.timeFunction).toBe('Year');
    expect(levels[1]!.timeFunction).toBe('MonthYear');
    expect(levels[0]!.sourceProperty).toBe('orderDate');
  });

  it('parses a data dimension level with sourceProperty + nullReplacement', () => {
    const parsed = parseCubeClass(generateCubeClass(def))!;
    const regionDim = parsed.dimensions!.find((d) => d.name === 'RegionD')!;
    const level = regionDim.hierarchies[0]!.levels[0]!;
    expect(level.sourceProperty).toBe('region');
    expect(level.nullReplacement).toBe('Unknown');
  });

  it('parses measures with aggregate, type, and source property', () => {
    const parsed = parseCubeClass(generateCubeClass(def))!;
    expect(parsed.measures!.map((m) => `${m.name}:${m.aggregate}`)).toEqual(['Total:SUM', 'Avg:AVG']);
    expect(parsed.measures![0]!.sourceProperty).toBe('amount');
    // The generator no longer emits measure factName (IRIS auto-assigns fact
    // storage); the parser derives a stable one from the name as a fallback.
    expect(parsed.measures![0]!.factName).toBe('Total');
  });

  it('returns null for source with no XData Cube block', () => {
    expect(parseCubeClass('Class Foo Extends %RegisteredObject\n{\n}')).toBeNull();
  });
});
