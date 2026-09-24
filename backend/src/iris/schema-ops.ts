/**
 * Read-only IRIS schema introspection, used to verify/repair class and property
 * names BEFORE generating a cube class. Runs entirely over the Atelier
 * `/action/query` SQL endpoint (against `%Dictionary.*`), so it needs no Native
 * SDK object callbacks.
 *
 * Motivating bugs this prevents:
 *  - `SC_Data.SalesOrder` (SQL table) vs `SC.Data.SalesOrder` (ObjectScript class).
 *  - `OrderValue` guessed when the real property is `orderValue`.
 *  - `customerId->Name` traversal when `customerId` is a plain %String, not a reference.
 */

/**
 * Per-statement transport overrides, for the rare statement whose own runtime is
 * nothing like a schema query's. Everything in this module ignores them and takes
 * the client's defaults; `LOAD DATA` (see `sc-data-load-ops.ts`) does not.
 */
export interface SqlQueryOptions {
  /** Per-attempt timeout in ms, overriding the client's. */
  timeoutMs?: number;
  /** Total attempts including the first. `1` means "never retry this statement". */
  attempts?: number;
}

/** The subset of AtelierClient this module needs (keeps it unit-testable). */
export interface SqlQuerier {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
    options?: SqlQueryOptions,
  ): Promise<Row[]>;
}

export interface PropertyInfo {
  name: string;
  type: string;
  /** True when the property's type is another persistent class (supports `->` traversal). */
  isReference: boolean;
}

export interface ResolveResult {
  input: string;
  exists: boolean;
  /** The real ObjectScript class name when resolved. */
  className?: string;
  /** The SQL table name (schema.table) for the resolved class, if any. */
  sqlTableName?: string;
  /** How it was resolved, for transparency. */
  via?: 'exact-class' | 'sql-table';
  /** When unresolved, the nearest existing class names to suggest. */
  candidates?: string[];
}

export interface MethodInfo {
  name: string;
  /** True for a ClassMethod (callable as `##class(X).Method(...)`). */
  isClassMethod: boolean;
  /** Formal spec, e.g. "(id As %String) As %String" (may be empty). */
  signature: string;
  returnType: string;
  /** First line of the method's /// doc comment, if any. */
  description?: string;
}

/** A foreign key on a class: its name, the class it references, and the local
 *  property/column(s) that carry the referenced key. Used to warn that a
 *  data-integration target's referenced rows must exist before ingesting. */
export interface ForeignKeyInfo {
  name: string;
  /** The referenced (parent) class, e.g. `SC.Data.Location`. */
  referencedClass: string;
  /** The local properties that hold the reference (usually one, e.g. `primaryLocationId`). */
  columns: string[];
}

export interface MatchResult {
  className: string;
  requested: string;
  /** Set when the requested name matches a real property exactly (case-sensitive). */
  exact?: string;
  /** Ranked nearest property names (best first). Empty if the class has no props. */
  closest: Array<{ name: string; score: number }>;
}

/**
 * Resolve a user-supplied name (either an ObjectScript class or a SQL
 * schema.table name) to the real compiled class.
 */
export async function resolveClass(q: SqlQuerier, name: string): Promise<ResolveResult> {
  const trimmed = name.trim();

  // 1. Exact class name.
  const exact = await q.query<{ Name: string; SqlTableName?: string; SqlSchemaName?: string }>(
    'SELECT Name, SqlSchemaName, SqlTableName FROM %Dictionary.CompiledClass WHERE Name = ?',
    [trimmed],
  );
  if (exact.length && exact[0]) {
    return {
      input: name,
      exists: true,
      className: exact[0].Name,
      sqlTableName: sqlName(exact[0]),
      via: 'exact-class',
    };
  }

  // 2. SQL table name — split on the last '.' or '_' into schema + table.
  const sep = Math.max(trimmed.lastIndexOf('.'), trimmed.lastIndexOf('_'));
  if (sep > 0) {
    const schema = trimmed.slice(0, sep);
    const table = trimmed.slice(sep + 1);
    const byTable = await q.query<{ Name: string; SqlTableName?: string; SqlSchemaName?: string }>(
      'SELECT Name, SqlSchemaName, SqlTableName FROM %Dictionary.CompiledClass WHERE SqlSchemaName = ? AND SqlTableName = ?',
      [schema, table],
    );
    if (byTable.length && byTable[0]) {
      return {
        input: name,
        exists: true,
        className: byTable[0].Name,
        sqlTableName: sqlName(byTable[0]),
        via: 'sql-table',
      };
    }
  }

  // 3. Unresolved — suggest nearest existing classes (search within the same
  //    top-level package prefix if any, else all classes).
  const prefix = trimmed.includes('.') ? trimmed.slice(0, trimmed.indexOf('.') + 1) : '';
  const pool = await q.query<{ Name: string }>(
    prefix
      ? 'SELECT Name FROM %Dictionary.CompiledClass WHERE Name %STARTSWITH ?'
      : 'SELECT Name FROM %Dictionary.CompiledClass',
    prefix ? [prefix] : [],
  );
  const candidates = closest(
    trimmed,
    pool.map((r) => r.Name),
    5,
  ).map((c) => c.name);

  return { input: name, exists: false, candidates };
}

/**
 * List a class's foreign keys (name, referenced class, and the local column(s)
 * that carry the reference). Used at deploy time to warn that a target's
 * referenced parent rows must already exist, or `%Save()` fails with `#5829`
 * and those records are skipped. Returns [] when the class declares none.
 *
 * `%Dictionary.CompiledForeignKey.Properties` is a comma-separated list of the
 * local property names (usually one). Tolerant of a class with no FKs.
 */
export async function listForeignKeys(q: SqlQuerier, className: string): Promise<ForeignKeyInfo[]> {
  const rows = await q.query<{ Name: string; ReferencedClass?: string; Properties?: string }>(
    'SELECT Name, ReferencedClass, Properties FROM %Dictionary.CompiledForeignKey WHERE parent = ?',
    [className],
  );
  return rows
    .filter((r) => r.Name && !r.Name.startsWith('%'))
    .map((r) => ({
      name: r.Name,
      referencedClass: r.ReferencedClass ?? '',
      columns: (r.Properties ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    }));
}

/** List the (non-system) properties of a compiled class. */
export async function listProperties(q: SqlQuerier, className: string): Promise<PropertyInfo[]> {
  const rows = await q.query<{ Name: string; RuntimeType?: string; Type?: string }>(
    'SELECT Name, RuntimeType, Type FROM %Dictionary.CompiledProperty WHERE parent = ? ORDER BY SequenceNumber',
    [className],
  );
  return rows
    .filter((r) => r.Name && !r.Name.startsWith('%'))
    .map((r) => {
      const type = r.RuntimeType || r.Type || '';
      return { name: r.Name, type, isReference: isReferenceType(type) };
    });
}

/**
 * List the (non-system) methods of a compiled class. Used so the agent can find
 * a real helper for a cube level's `sourceExpression` — e.g. discovering
 * `SC.Core.Util.CubeUtil.getCustomerName(id)` instead of inventing a lookup.
 * ClassMethods are the callable ones (`##class(X).Method(...)`); instance methods
 * are included but flagged. System/generated `%…` methods are filtered out.
 */
export async function listMethods(q: SqlQuerier, className: string): Promise<MethodInfo[]> {
  const rows = await q.query<{
    Name: string;
    ClassMethod?: unknown;
    FormalSpec?: string;
    ReturnType?: string;
    Description?: string;
  }>(
    'SELECT Name, ClassMethod, FormalSpec, ReturnType, Description FROM %Dictionary.CompiledMethod ' +
      'WHERE parent = ? ORDER BY Name',
    [className],
  );
  return rows
    .filter((r) => r.Name && !r.Name.startsWith('%'))
    .map((r) => {
      const returnType = r.ReturnType || '';
      const formal = formatFormalSpec(r.FormalSpec);
      return {
        name: r.Name,
        isClassMethod: truthy(r.ClassMethod),
        signature: `(${formal})${returnType ? ` As ${returnType}` : ''}`,
        returnType,
        description: firstLine(r.Description),
      };
    });
}

/** IRIS booleans come back as 1/0/"1"/"0"/true — normalize. */
function truthy(v: unknown): boolean {
  return v === 1 || v === 1n || v === '1' || v === true;
}

/**
 * Turn a %Dictionary FormalSpec into a readable arg list. The raw form is
 * comma-separated `name:Type` (with extras like `&`/`*`/`=default`); we render it
 * as `name As Type` and tolerate an empty/absent spec.
 */
function formatFormalSpec(spec?: string): string {
  if (!spec || !spec.trim()) return '';
  return spec
    .split(',')
    .map((part) => {
      const [rawName, rawType] = part.split(':');
      const name = (rawName ?? '').replace(/^[&*]/, '').trim();
      const type = (rawType ?? '').split('=')[0]!.trim();
      if (!name) return part.trim();
      return type ? `${name} As ${type}` : name;
    })
    .join(', ');
}

function firstLine(desc?: string): string | undefined {
  if (!desc) return undefined;
  const line = desc.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  return line || undefined;
}

/** Match a requested property name against a class's real properties. */
export async function matchProperty(
  q: SqlQuerier,
  className: string,
  requested: string,
): Promise<MatchResult> {
  const props = await listProperties(q, className);
  const names = props.map((p) => p.name);
  const exact = names.find((n) => n === requested.trim());
  return {
    className,
    requested,
    exact,
    closest: closest(requested, names, 5),
  };
}

/**
 * Rank `candidates` by closeness to `target`: case-insensitive equality and
 * substring matches score highest, then normalized Levenshtein similarity.
 * Returns up to `limit` best matches with a 0..1 score (1 = exact).
 */
export function closest(
  target: string,
  candidates: string[],
  limit = 5,
): Array<{ name: string; score: number }> {
  const t = target.trim().toLowerCase();
  const scored = candidates.map((name) => {
    const c = name.toLowerCase();
    let score: number;
    if (c === t) score = 1;
    else if (c.includes(t) || t.includes(c)) score = 0.9 - Math.abs(c.length - t.length) / 100;
    else {
      const dist = levenshtein(c, t);
      score = 1 - dist / Math.max(c.length, t.length, 1);
    }
    return { name, score: Math.max(0, Math.min(1, score)) };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** A type is a reference if it's a persistent class, not a %Library.* datatype. */
function isReferenceType(type: string): boolean {
  if (!type) return false;
  if (type.startsWith('%')) return false; // %Library.String, %Numeric, etc.
  return type.includes('.'); // e.g. SC.Data.Customer
}

function sqlName(row: { SqlSchemaName?: string; SqlTableName?: string }): string | undefined {
  if (!row.SqlTableName) return undefined;
  return row.SqlSchemaName ? `${row.SqlSchemaName}.${row.SqlTableName}` : row.SqlTableName;
}

/** Standard iterative Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
