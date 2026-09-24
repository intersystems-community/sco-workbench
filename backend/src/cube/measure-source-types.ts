/**
 * A measure's `type` must fit what its source returns, or the cube compiles but
 * the measure is broken. Verified against SCO by building one cube per pairing:
 *
 *   - number over a %String (COUNT of `uid`)   → build fails on every row
 *   - number over a %String-returning helper   → builds, measure is empty
 *   - string with COUNT                        → builds, measure is empty
 *   - string with SUM / MIN / MAX              → does not compile ("Aggregate
 *                                                function for string measure must be COUNT")
 *   - date over a %DateTime property           → builds, values are garbage
 *   - integer over a %Numeric property         → fine
 *
 * So this checks each measure's source — a property's type, or the return type
 * of a `##class(X).method(...)` expression — before the class is generated.
 * Anything it can't type (arithmetic, references, custom datatypes, traversal)
 * is left alone rather than guessed at.
 */
import type { CubeDefinition, CubeMeasure } from './cube-definition.model.js';

/** Where the check reads source types from (the source class, and helper classes). */
export interface SourceTypeLookup {
  /** The IRIS datatype of a source-class property, e.g. "%Library.Numeric". */
  propertyType(name: string): string | undefined;
  /** The return type of `className.method`, or undefined if there is no such method. */
  methodReturnType(className: string, method: string): Promise<string | undefined>;
}

const INTEGERS = ['Integer', 'TinyInt', 'SmallInt', 'BigInt'];
const NUMERICS = [...INTEGERS, 'Numeric', 'Decimal', 'Double', 'Float', 'Currency'];
const TEXTUAL = ['String', 'VarString', 'RawString', 'Char', 'Text', 'DateTime', 'TimeStamp', 'PosixTime', 'Time', 'List', 'Binary'];
const lib = (names: string[]) => new Set(names.map((n) => `%Library.${n}`));

const NUMERIC_SOURCES = lib([...NUMERICS, 'Boolean']);
const BOOLEAN_SOURCES = lib([...INTEGERS, 'Boolean']);
const DATE_SOURCES = lib(['Date']);
/** Datatypes whose fit we know; any other type (a reference, a custom datatype) isn't checked. */
const KNOWN_SOURCES = lib([...NUMERICS, 'Boolean', 'Date', ...TEXTUAL]);
/** Aggregates that only work over an integer/number measure. */
const NUMERIC_AGGREGATES = new Set(['COUNT', 'SUM', 'AVG']);
/** The record id: never a measure source (a COUNT of it is just the row count). */
const RECORD_ID = new Set(['uid', 'id', '%id']);

/** A sourceless measure counts rows: the generator gives it the constant source 1. */
const ROW_COUNT_SOURCE = '%Library.Integer';

/** "%Integer" → "%Library.Integer"; full and non-% names are returned as-is. */
function normalizeType(type: string): string {
  const t = type.trim();
  return /^%[A-Za-z]+$/.test(t) ? `%Library.${t.slice(1)}` : t;
}

/** Which measure types can read a source of IRIS type `source`, or null when any can. */
function allowedSources(measureType: string): Set<string> | null {
  if (measureType === 'integer' || measureType === 'number') return NUMERIC_SOURCES;
  if (measureType === 'boolean') return BOOLEAN_SOURCES;
  if (measureType === 'date') return DATE_SOURCES;
  return null; // string / text are refused before this; age / iKnow aren't checked
}

const NEEDS: Record<string, string> = {
  integer: 'a numeric source (%Integer, %Numeric, %Double…)',
  number: 'a numeric source (%Integer, %Numeric, %Double…)',
  boolean: 'a %Boolean or integer source',
  date: 'a %Date source; %DateTime/%TimeStamp values build into wrong numbers',
};

/** Parentheses balance and never close more than they open. */
function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** The class and method of an expression that is exactly one `##class(X).method(...)` call. */
export function expressionCall(expr: string): { className: string; method: string } | null {
  const m = /^##class\(([%A-Za-z0-9.]+)\)\.([%A-Za-z0-9]+)\((.*)\)$/s.exec(expr.trim());
  if (!m || !balanced(m[3]!)) return null;
  return { className: m[1]!, method: m[2]! };
}

interface ResolvedSource {
  label: string;
  type: string | undefined;
}

/** What a measure reads, and its IRIS type when that can be known. */
async function resolveSource(
  m: CubeMeasure,
  lookup: SourceTypeLookup,
  returnType: (cls: string, method: string) => Promise<string | undefined>,
): Promise<ResolvedSource> {
  const prop = m.sourceProperty?.trim();
  if (prop) return { label: prop, type: prop.includes('->') ? undefined : lookup.propertyType(prop) };
  const expr = m.sourceExpression?.trim();
  if (expr) {
    const call = expressionCall(expr);
    return { label: call ? `${call.method}()` : 'its expression', type: call ? await returnType(call.className, call.method) : undefined };
  }
  return { label: 'no source (a row count)', type: ROW_COUNT_SOURCE };
}

/** One measure's problems, given its resolved source. */
function problemsFor(m: CubeMeasure, source: ResolvedSource): string[] {
  const out: string[] = [];
  const prop = m.sourceProperty?.trim() ?? '';
  const hasSource = !!prop || !!m.sourceExpression?.trim();
  const aggregate = hasSource ? m.aggregate : 'COUNT';

  if (RECORD_ID.has(prop.toLowerCase())) {
    out.push(
      `Measure "${m.name}" uses the record id "${prop}" as its source. Every cube already counts records ` +
        `(%COUNT); for a named count, leave the source empty and use aggregate COUNT with type integer.`,
    );
    return out;
  }
  if (m.type === 'string' || m.type === 'text') {
    // SCO compiles a string measure only with COUNT, and that reads empty in a
    // pivot; it's only meaningful as a searchable (listing-filter) measure.
    if (aggregate === 'COUNT' && m.searchable) return out;
    out.push(
      `Measure "${m.name}" is type ${m.type}: text can't be aggregated into a number (SCO only compiles it with ` +
        `COUNT, which reads empty). For a record count, leave the source empty with type integer; ` +
        `to break numbers down by text, use a dimension.`,
    );
    return out;
  }
  if (NUMERIC_AGGREGATES.has(aggregate) && m.type !== 'integer' && m.type !== 'number') {
    // The type itself is wrong, so the source check below would only repeat it.
    out.push(`Measure "${m.name}" uses ${aggregate}, which needs type integer or number, not ${m.type}.`);
    return out;
  }
  const allowed = allowedSources(m.type);
  const type = source.type ? normalizeType(source.type) : undefined;
  if (allowed && type && KNOWN_SOURCES.has(type) && !allowed.has(type)) {
    out.push(
      `Measure "${m.name}" is type ${m.type}, but its source ${source.label} is ${type}. ` +
        `A ${m.type} measure needs ${NEEDS[m.type]}. Change the measure type or its source.`,
    );
  }
  return out;
}

/** Every measure whose type doesn't fit its source, as readable messages (empty when all fit). */
export async function measureSourceProblems(def: CubeDefinition, lookup: SourceTypeLookup): Promise<string[]> {
  const returnTypes = new Map<string, Promise<string | undefined>>();
  const returnType = (cls: string, method: string): Promise<string | undefined> => {
    const key = `${cls}.${method}`;
    if (!returnTypes.has(key)) returnTypes.set(key, lookup.methodReturnType(cls, method));
    return returnTypes.get(key)!;
  };
  const out: string[] = [];
  for (const m of def.measures ?? []) {
    if (!m.name?.trim() || m.name.trim().startsWith('%')) continue;
    out.push(...problemsFor(m, await resolveSource(m, lookup, returnType)));
  }
  return out;
}
