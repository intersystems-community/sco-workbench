/**
 * Does a measure's type fit its source? Mirrors the backend's
 * measure-source-types check for PROPERTY sources (an expression's return type
 * is only known server-side), so the form — and the assistant filling it — gets
 * the reason at once instead of at Compile. A mismatch compiles but builds empty
 * or broken: a number measure over `uid` fails on every row, a date measure over
 * a %DateTime builds garbage, a string measure only compiles with COUNT and then
 * reads empty.
 */

/** IRIS datatypes a numeric measure (and a range) can read. */
export const NUMERIC_TYPES = new Set([
  '%Library.Numeric', '%Library.Integer', '%Library.Decimal', '%Library.Double', '%Library.Float',
  '%Library.Currency', '%Library.TinyInt', '%Library.SmallInt', '%Library.BigInt',
]);
const INTEGER_TYPES = new Set(['%Library.Integer', '%Library.TinyInt', '%Library.SmallInt', '%Library.BigInt']);
const BOOLEAN = '%Library.Boolean';
const DATE = '%Library.Date';
const TEXTUAL_TYPES = new Set([
  '%Library.String', '%Library.VarString', '%Library.RawString', '%Library.Char', '%Library.Text',
  '%Library.DateTime', '%Library.TimeStamp', '%Library.PosixTime', '%Library.Time', '%Library.List', '%Library.Binary',
]);

/** The fields of a form measure this check reads. */
export interface MeasureLike {
  name: string;
  type: string;
  aggregate: string;
  srcKind?: 'property' | 'expression';
  sourceProperty?: string;
  sourceExpression?: string;
}

const NUMERIC_AGGREGATES = new Set(['COUNT', 'SUM', 'AVG']);

const NEEDS: Record<string, string> = {
  integer: 'a numeric property (%Integer, %Numeric, %Double…)',
  number: 'a numeric property (%Integer, %Numeric, %Double…)',
  boolean: 'a %Boolean or integer property',
  date: 'a %Date property; %DateTime/%TimeStamp values build into wrong numbers',
};

/** The record id: never a measure source (a COUNT of it is just the row count). */
export function isRecordId(property: string): boolean {
  return ['uid', 'id', '%id'].includes(property.trim().toLowerCase());
}

function fits(measureType: string, sourceType: string): boolean {
  if (measureType === 'integer' || measureType === 'number') return NUMERIC_TYPES.has(sourceType) || sourceType === BOOLEAN;
  if (measureType === 'boolean') return sourceType === BOOLEAN || INTEGER_TYPES.has(sourceType);
  if (measureType === 'date') return sourceType === DATE;
  return true; // string / text are refused before this
}

/** Why this measure won't build correctly, or null when it fits (or can't be judged here). */
export function measureProblem(m: MeasureLike, propertyTypes: Readonly<Record<string, string>>): string | null {
  const name = m.name.trim() || 'this measure';
  const prop = m.srcKind === 'expression' ? '' : (m.sourceProperty ?? '').trim();
  const hasSource = !!prop || (m.srcKind === 'expression' && !!(m.sourceExpression ?? '').trim());
  const aggregate = hasSource ? m.aggregate : 'COUNT';

  if (prop && isRecordId(prop)) {
    return `Measure "${name}" uses the record id "${prop}" as its source. Every cube already counts records (%COUNT); ` +
      `for a named count, leave the source empty and use aggregate COUNT with type integer.`;
  }
  if (m.type === 'string' || m.type === 'text') {
    return `Measure "${name}" is type ${m.type}: text can't be aggregated into a number (SCO only compiles it with ` +
      `COUNT, which reads empty). For a record count, leave the source empty with type integer; ` +
      `to break numbers down by text, use a dimension.`;
  }
  if (NUMERIC_AGGREGATES.has(aggregate) && m.type !== 'integer' && m.type !== 'number') {
    return `Measure "${name}" uses ${aggregate}, which needs type integer or number, not ${m.type}.`;
  }
  const sourceType = prop ? propertyTypes[prop] : undefined;
  const known = !!sourceType && (NUMERIC_TYPES.has(sourceType) || TEXTUAL_TYPES.has(sourceType) || sourceType === BOOLEAN || sourceType === DATE);
  if (known && !fits(m.type, sourceType!)) {
    return `Measure "${name}" is type ${m.type}, but its source ${prop} is ${sourceType}. ` +
      `A ${m.type} measure needs ${NEEDS[m.type]}. Change the measure type or its source.`;
  }
  return null;
}
