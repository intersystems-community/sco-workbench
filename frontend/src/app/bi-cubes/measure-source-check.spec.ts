import { isRecordId, measureProblem, type MeasureLike } from './measure-source-check';

const TYPES: Record<string, string> = {
  uid: '%Library.String',
  orderStatus: '%Library.String',
  quantity: '%Library.Numeric',
  lineCount: '%Library.Integer',
  dueDay: '%Library.Date',
  plannedEndDate: '%Library.DateTime',
  customer: 'SC.Data.Customer',
};
const m = (over: Partial<MeasureLike>): MeasureLike => ({
  name: 'm', type: 'number', aggregate: 'SUM', srcKind: 'property', sourceProperty: '', ...over,
});

describe('measureProblem', () => {
  it('accepts a numeric property for an integer/number measure', () => {
    expect(measureProblem(m({ sourceProperty: 'quantity' }), TYPES)).toBeNull();
    expect(measureProblem(m({ sourceProperty: 'lineCount', type: 'integer' }), TYPES)).toBeNull();
  });

  it('rejects a number measure over a string property, naming both types', () => {
    const p = measureProblem(m({ name: 'statusSum', sourceProperty: 'orderStatus' }), TYPES);
    expect(p).toContain('"statusSum" is type number');
    expect(p).toContain('%Library.String');
  });

  it('rejects a date measure over %DateTime and accepts one over %Date', () => {
    expect(measureProblem(m({ sourceProperty: 'plannedEndDate', aggregate: 'MAX', type: 'date' }), TYPES)).toContain('%Date');
    expect(measureProblem(m({ sourceProperty: 'dueDay', aggregate: 'MAX', type: 'date' }), TYPES)).toBeNull();
  });

  it('rejects the record id as a source and says to leave it empty', () => {
    expect(measureProblem(m({ sourceProperty: 'uid', aggregate: 'COUNT', type: 'integer' }), TYPES)).toMatch(/leave the source empty/i);
  });

  it('rejects COUNT/SUM/AVG with a non-numeric measure type', () => {
    for (const aggregate of ['COUNT', 'SUM', 'AVG']) {
      expect(measureProblem(m({ sourceProperty: 'dueDay', aggregate, type: 'date' }), TYPES)).toContain('integer or number');
    }
  });

  it('rejects a string or text measure with any aggregate', () => {
    for (const type of ['string', 'text']) {
      for (const aggregate of ['COUNT', 'MIN', 'MAX']) {
        expect(measureProblem(m({ sourceProperty: 'orderStatus', aggregate, type }), TYPES)).toMatch(/use a dimension/);
      }
    }
  });

  it('accepts a sourceless record count, and treats it as COUNT', () => {
    expect(measureProblem(m({ name: 'orderCount', aggregate: 'COUNT', type: 'integer' }), TYPES)).toBeNull();
    expect(measureProblem(m({ aggregate: 'SUM', type: 'date' }), TYPES)).toContain('COUNT');
  });

  it('does not judge sources it cannot type (expressions, references, unknown properties)', () => {
    expect(measureProblem(m({ srcKind: 'expression', sourceExpression: '%source.a*2' }), TYPES)).toBeNull();
    expect(measureProblem(m({ sourceProperty: 'customer', aggregate: 'MAX' }), TYPES)).toBeNull();
    expect(measureProblem(m({ sourceProperty: 'notLoadedYet' }), TYPES)).toBeNull();
  });
});

describe('isRecordId', () => {
  it('matches uid / ID / %ID regardless of case', () => {
    expect(['uid', 'UID', 'ID', '%ID'].every(isRecordId)).toBe(true);
    expect(isRecordId('productId')).toBe(false);
  });
});
