import { describe, it, expect, vi } from 'vitest';
import {
  expressionCall,
  measureSourceProblems,
  type SourceTypeLookup,
} from '../../src/cube/measure-source-types.js';
import type { CubeDefinition, CubeMeasure } from '../../src/cube/cube-definition.model.js';

/** SC.Data.MfgOrder-like property types, and CubeUtil's real return types. */
const PROPS: Record<string, string> = {
  uid: '%Library.String',
  orderStatus: '%Library.String',
  quantity: '%Library.Numeric',
  lineCount: '%Library.Integer',
  isRush: '%Library.Boolean',
  dueDay: '%Library.Date',
  plannedEndDate: '%Library.DateTime',
  customer: 'SC.Data.Customer',
  amount: 'SC.Core.DataType.Money',
};
const RETURNS: Record<string, string> = {
  'SC.Core.Util.CubeUtil.getDateTimeDiffInHours': '%Library.Numeric',
  'SC.Core.Util.CubeUtil.getDaysBefore': '%Integer',
  'SC.Core.Util.CubeUtil.getLocationCountry': '%Library.String',
};

function lookup(): SourceTypeLookup & { methodReturnType: ReturnType<typeof vi.fn> } {
  return {
    propertyType: (name: string) => PROPS[name],
    methodReturnType: vi.fn(async (cls: string, method: string) => RETURNS[`${cls}.${method}`]),
  };
}

const measure = (m: Partial<CubeMeasure>): CubeMeasure => ({
  name: 'm', factName: 'm', aggregate: 'SUM', type: 'number', factNumber: 2, ...m,
});
const cube = (...measures: CubeMeasure[]): CubeDefinition => ({ cubeName: 'C', sourceClass: 'SC.Data.MfgOrder', measures });
const problems = (...measures: CubeMeasure[]) => measureSourceProblems(cube(...measures), lookup());

describe('expressionCall', () => {
  it('recognises a whole-expression ##class(...).method(...) call', () => {
    expect(expressionCall('##class(SC.Core.Util.CubeUtil).getDaysBefore(%source.plannedEndDate)')).toEqual({
      className: 'SC.Core.Util.CubeUtil',
      method: 'getDaysBefore',
    });
    expect(expressionCall(' ##class(%SYSTEM.SQL).Functions.X() ')).toBeNull();
  });

  it('returns null for arithmetic or a call that is only part of the expression', () => {
    expect(expressionCall('%source.quantity-%source.quantityReserved')).toBeNull();
    expect(expressionCall('##class(A.B).f(%source.x)*2')).toBeNull();
    expect(expressionCall('')).toBeNull();
  });
});

describe('measureSourceProblems — the source type must fit the measure type', () => {
  it('accepts a numeric property for an integer or number measure', async () => {
    expect(await problems(
      measure({ name: 'qty', sourceProperty: 'quantity', type: 'number' }),
      measure({ name: 'qtyInt', sourceProperty: 'quantity', type: 'integer' }),
      measure({ name: 'lines', sourceProperty: 'lineCount', type: 'integer' }),
      measure({ name: 'rush', sourceProperty: 'isRush', aggregate: 'SUM', type: 'integer' }),
    )).toEqual([]);
  });

  it('rejects a number measure over a string property (the uid case), naming both types', async () => {
    const out = await problems(measure({ name: 'statusSum', sourceProperty: 'orderStatus', type: 'number' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('"statusSum"');
    expect(out[0]).toContain('number');
    expect(out[0]).toContain('orderStatus');
    expect(out[0]).toContain('%Library.String');
  });

  it('rejects a date measure over a %DateTime property (it builds into wrong numbers)', async () => {
    const out = await problems(measure({ name: 'lastEnd', sourceProperty: 'plannedEndDate', aggregate: 'MAX', type: 'date' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('%Date');
  });

  it('accepts a date measure over a %Date property', async () => {
    expect(await problems(measure({ sourceProperty: 'dueDay', aggregate: 'MAX', type: 'date' }))).toEqual([]);
  });

  it('checks an expression by the return type of the method it calls', async () => {
    expect(await problems(measure({
      name: 'workHours', aggregate: 'AVG', type: 'number',
      sourceExpression: '##class(SC.Core.Util.CubeUtil).getDateTimeDiffInHours(%source.plannedStartDate, %source.plannedEndDate)',
    }))).toEqual([]);
    const out = await problems(measure({
      name: 'country', aggregate: 'MAX', type: 'number',
      sourceExpression: '##class(SC.Core.Util.CubeUtil).getLocationCountry(%source.workLocationId)',
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('getLocationCountry');
    expect(out[0]).toContain('%Library.String');
  });

  it('normalises a short return type (%Integer) before comparing', async () => {
    expect(await problems(measure({
      type: 'integer', sourceExpression: '##class(SC.Core.Util.CubeUtil).getDaysBefore(%source.plannedEndDate)',
    }))).toEqual([]);
  });

  it('does not guess when the source type is unknown', async () => {
    const lk = lookup();
    const out = await measureSourceProblems(cube(
      measure({ sourceProperty: 'customer', aggregate: 'MAX' }),               // a reference
      measure({ sourceProperty: 'amount' }),                                   // a custom datatype
      measure({ sourceProperty: 'customer->creditLimit' }),                    // traversal
      measure({ sourceExpression: '%source.quantity*2' }),                     // arithmetic
      measure({ sourceExpression: '##class(X.Y).unknown(%source.uid)' }),      // method not found
    ), lk);
    expect(out).toEqual([]);
  });

  it('looks each method up only once', async () => {
    const lk = lookup();
    const expr = '##class(SC.Core.Util.CubeUtil).getDateTimeDiffInHours(%source.a, %source.b)';
    await measureSourceProblems(cube(measure({ sourceExpression: expr }), measure({ sourceExpression: expr })), lk);
    expect(lk.methodReturnType).toHaveBeenCalledTimes(1);
  });
});

describe('measureSourceProblems — counting records', () => {
  it('accepts a named record count with no source (COUNT, integer)', async () => {
    expect(await problems(measure({ name: 'orderCount', aggregate: 'COUNT', type: 'integer' }))).toEqual([]);
  });

  it('rejects the record id (uid) as a measure source and says to leave it empty', async () => {
    const out = await problems(measure({ name: 'orderCount', sourceProperty: 'uid', aggregate: 'COUNT', type: 'integer' }));
    expect(out).toHaveLength(1); // one actionable message, not also a type mismatch
    expect(out[0]).toContain('uid');
    expect(out[0]).toMatch(/leave the source empty/i);
  });

  it('rejects a COUNT, SUM or AVG measure whose type is not integer/number', async () => {
    for (const aggregate of ['COUNT', 'SUM', 'AVG'] as const) {
      const out = await problems(measure({ name: 'x', sourceProperty: 'dueDay', aggregate, type: 'date' }));
      expect(out.some((p) => p.includes(aggregate) && p.includes('integer or number'))).toBe(true);
    }
  });

  it('rejects a string or text measure with any aggregate (MIN/MAX do not compile, COUNT reads empty)', async () => {
    for (const type of ['string', 'text'] as const) {
      for (const aggregate of ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const) {
        const out = await problems(measure({ name: 'status', sourceProperty: 'orderStatus', aggregate, type }));
        expect(out).toHaveLength(1);
        expect(out[0]).toContain(`type ${type}`);
        expect(out[0]).toMatch(/use a dimension/);
      }
    }
  });

  it('allows a searchable string COUNT measure (a listing filter)', async () => {
    expect(await problems(measure({ sourceProperty: 'orderStatus', aggregate: 'COUNT', type: 'string', searchable: true }))).toEqual([]);
  });

  it('treats a sourceless measure as a row count (so a date type is rejected)', async () => {
    const out = await problems(measure({ name: 'n', aggregate: 'SUM', type: 'date' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('"n"');
  });


});
