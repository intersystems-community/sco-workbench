import { describe, it, expect } from 'vitest';
import {
  generateCubeClass,
  validateCubeDefinition,
  cubeClassName,
} from '../../src/cube/cube-generator.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

const sampleCube: CubeDefinition = {
  cubeName: 'WorkbenchTestSource',
  sourceClass: 'Workbench.Test.Source',
  description: 'Test cube over sample sales data',
  dimensions: [
    {
      name: 'RegionD',
      type: 'data',
      hasAll: true,
      hierarchies: [
        {
          name: 'H1',
          levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }],
        },
      ],
    },
  ],
  measures: [
    {
      name: 'Total Amount',
      sourceProperty: 'Amount',
      factName: 'MxAmount',
      aggregate: 'SUM',
      type: 'number',
      factNumber: 3,
    },
  ],
};

describe('cubeClassName', () => {
  it('prefixes the Workbench cube package', () => {
    expect(cubeClassName('Foo')).toBe('SC.Workbench.Cube.Foo');
  });
});

describe('generateCubeClass', () => {
  it('produces a well-formed cube class with the expected header', () => {
    const cls = generateCubeClass(sampleCube);
    expect(cls).toContain(
      'Class SC.Workbench.Cube.WorkbenchTestSource Extends %DeepSee.CubeDefinition [ DependsOn = Workbench.Test.Source, ProcedureBlock ]',
    );
    expect(cls).toContain('XData Cube [ XMLNamespace = "http://www.intersystems.com/deepsee" ]');
    expect(cls).toContain('Parameter DOMAIN;');
    // description appears as a /// doc comment (twice: class + XData region)
    expect(cls.match(/\/\/\/ Test cube over sample sales data/g)).toHaveLength(2);
  });

  it('uses sourceClass verbatim in both DependsOn and the cube sourceClass attribute', () => {
    const cls = generateCubeClass(sampleCube);
    expect(cls).toContain('DependsOn = Workbench.Test.Source,');
    expect(cls).toContain('sourceClass="Workbench.Test.Source"');
  });

  it('emits dimension, level (with factNumber) and measure (no fact attrs)', () => {
    const cls = generateCubeClass(sampleCube);
    expect(cls).toContain('<dimension name="RegionD"');
    expect(cls).toContain('<level name="Region"');
    expect(cls).toContain('sourceProperty="Region"');
    expect(cls).toContain('factNumber="2"'); // level keeps its explicit fact number
    expect(cls).toContain('<measure name="Total Amount"');
    expect(cls).toContain('aggregate="SUM"');
    // Measures do NOT emit factNumber/factName — IRIS auto-assigns fact storage
    // (so multiple measures over one source don't collide). namedFactNums=false.
    const measureLine = cls.split('\n').find((l) => l.includes('<measure name="Total Amount"'))!;
    expect(measureLine).not.toContain('factNumber=');
    expect(measureLine).not.toContain('factName=');
    expect(cls).toContain('namedFactNums="false"');
  });

  it('hoists sourceProperty onto a TIME dimension and strips it from the level', () => {
    // IRIS requires a time dimension to carry sourceProperty (the date field);
    // the levels then only extract parts via timeFunction. The form puts the
    // date on the levels, so the generator must hoist it up (and not duplicate
    // it on the level), else IRIS errors with #5001.
    const cls = generateCubeClass({
      cubeName: 'TimeCube',
      sourceClass: 'X.Y',
      dimensions: [
        {
          name: 'DateD',
          type: 'time',
          hasAll: true,
          hierarchies: [
            {
              name: 'H1',
              levels: [
                { name: 'year', sourceProperty: 'orderDate', timeFunction: 'Year', factNumber: 2 },
                { name: 'month', sourceProperty: 'orderDate', timeFunction: 'MonthYear', factNumber: 3 },
              ],
            },
          ],
        },
      ],
      measures: [],
    });
    // Dimension carries the date field…
    expect(cls).toMatch(/<dimension name="DateD"[^>]*sourceProperty="orderDate"[^>]*type="time"/);
    // …and the time levels do NOT repeat sourceProperty (only timeFunction).
    const yearLevel = cls.split('\n').find((l) => l.includes('<level name="year"'))!;
    expect(yearLevel).toContain('timeFunction="Year"');
    expect(yearLevel).not.toContain('sourceProperty=');
  });

  it('omits optional attributes that have no default and no value (e.g. defaultListing)', () => {
    const cls = generateCubeClass(sampleCube);
    expect(cls).not.toContain('defaultListing=');
  });

  it('always writes defaulted attributes (disabled, bucketSize, countMeasureName)', () => {
    const cls = generateCubeClass(sampleCube);
    expect(cls).toContain('disabled="false"');
    expect(cls).toContain('bucketSize="8"');
    expect(cls).toContain('countMeasureName="%COUNT"');
  });

  it('escapes XML special characters in attribute values', () => {
    const cls = generateCubeClass({
      ...sampleCube,
      displayName: 'Sales & "Ops" <region>',
    });
    expect(cls).toContain('displayName="Sales &amp; &quot;Ops&quot; &lt;region&gt;"');
  });

  it('is deterministic (stable golden output) — no timestamps or randomness', () => {
    expect(generateCubeClass(sampleCube)).toBe(generateCubeClass(sampleCube));
  });

  it('throws on duplicate LEVEL factNumbers', () => {
    const dup: CubeDefinition = {
      ...sampleCube,
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [
            {
              name: 'H1',
              levels: [
                { name: 'Region', sourceProperty: 'Region', factNumber: 2 },
                { name: 'Region2', sourceProperty: 'Region2', factNumber: 2 }, // clash
              ],
            },
          ],
        },
      ],
    };
    expect(() => generateCubeClass(dup)).toThrow(/Duplicate factNumber 2/);
  });

  it('throws when a LEVEL factNumber is below 2 (fact 1 is reserved)', () => {
    const bad: CubeDefinition = {
      ...sampleCube,
      dimensions: [
        {
          name: 'RegionD',
          type: 'data',
          hasAll: true,
          hierarchies: [{ name: 'H1', levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 1 }] }],
        },
      ],
    };
    expect(() => generateCubeClass(bad)).toThrow(/facts start at 2/);
  });
});

describe('validateCubeDefinition', () => {
  it('returns no problems for a valid definition', () => {
    expect(validateCubeDefinition(sampleCube)).toEqual([]);
  });

  it('flags a missing sourceClass', () => {
    const problems = validateCubeDefinition({ ...sampleCube, sourceClass: '' });
    expect(problems.join('\n')).toMatch(/sourceClass is required/);
  });

  it('flags a dimension with no hierarchies (would be an untranslatable IRIS #5001)', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [{ name: 'Empty', type: 'data', hierarchies: [] }],
    });
    expect(problems.join('\n')).toMatch(/Dimension "Empty" must have at least one hierarchy with a named level/);
  });

  it('flags a dimension whose only level has no name', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [
        { name: 'Region', type: 'data', hierarchies: [{ name: 'H1', levels: [{ name: '', factNumber: 2 }] }] },
      ],
    });
    expect(problems.join('\n')).toMatch(/Dimension "Region" must have at least one hierarchy with a named level/);
  });

  it('flags a dimension whose only hierarchy is disabled', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [
        {
          name: 'Region',
          type: 'data',
          hierarchies: [{ name: 'H1', disabled: true, levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }],
        },
      ],
    });
    expect(problems.join('\n')).toMatch(/Dimension "Region" must have at least one hierarchy with a named level/);
  });

  it('does not flag a disabled dimension (it is not emitted)', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [{ name: 'Skipped', type: 'data', disabled: true, hierarchies: [] }],
    });
    expect(problems.join('\n')).not.toMatch(/must have at least one hierarchy/);
  });

  it('flags a hierarchy that carries a named level but has no name', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [
        { name: 'Region', type: 'data', hierarchies: [{ levels: [{ name: 'Region', sourceProperty: 'Region', factNumber: 2 }] }] },
      ],
    });
    expect(problems.join('\n')).toMatch(/A hierarchy in dimension "Region" needs a name/);
  });

  it('flags a named level with no source (property/expression/timeFunction) — would <UNDEFINED> at build', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [
        { name: 'Region', type: 'data', hierarchies: [{ name: 'H1', levels: [{ name: 'Region', factNumber: 2 }] }] },
      ],
    });
    expect(problems.join('\n')).toMatch(/Level "Region\.H1\.Region" needs a source/);
  });

  it('accepts a level sourced by a timeFunction (no sourceProperty/expression)', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      dimensions: [
        {
          name: 'DateD',
          type: 'time',
          sourceProperty: 'SaleDate',
          hierarchies: [{ name: 'H1', levels: [{ name: 'Yr', timeFunction: 'Year', factNumber: 2 }] }],
        },
      ],
    });
    expect(problems.join('\n')).not.toMatch(/needs a source/);
  });

  it('does NOT require a measure source (a sourceless measure is valid — a COUNT)', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      measures: [{ name: 'Amt', factName: 'MxAmt', aggregate: 'SUM', type: 'number', factNumber: 3 }],
    });
    expect(problems.join('\n')).not.toMatch(/needs a source/);
  });

  it('accepts a measure sourced by an expression', () => {
    const problems = validateCubeDefinition({
      ...sampleCube,
      measures: [
        { name: 'Amt', sourceExpression: '%source.Qty * %source.Price', factName: 'MxAmt', aggregate: 'SUM', type: 'number', factNumber: 3 },
      ],
    });
    expect(problems.join('\n')).not.toMatch(/needs a source/);
  });
});

describe('generateCubeClass measure aggregate coercion', () => {
  it('coerces a SOURCELESS measure to a COUNT aggregate (SUM-of-nothing is invalid)', () => {
    const cls = generateCubeClass({
      ...sampleCube,
      measures: [{ name: 'RowCount', factName: 'MxRowCount', aggregate: 'SUM', type: 'integer', factNumber: 3 }],
    });
    // The sourceless measure is emitted with aggregate="COUNT", not the SUM it was given.
    expect(cls).toMatch(/<measure name="RowCount"[^>]*aggregate="COUNT"/);
  });

  it('keeps the chosen aggregate for a SOURCED measure', () => {
    const cls = generateCubeClass({
      ...sampleCube,
      measures: [{ name: 'Total', sourceProperty: 'Amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3 }],
    });
    expect(cls).toMatch(/<measure name="Total"[^>]*aggregate="SUM"/);
  });
});
