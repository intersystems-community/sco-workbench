/**
 * Exact row counts for a persistent class, over the `SqlQuerier` port.
 *
 * Why this exists at all: scdata sends no total-count header. `DataApiBase`
 * sets exactly five headers (`ORDERBY`, `PAGEINDEX`, `PAGESIZE`, `RETURNCOUNT`,
 * `WHERECLAUSE`) and none of them is a total, so a correct total needs SQL.
 * `ScDataService.getCount()` read a `totalcount` header that has never existed
 * and therefore always returned null.
 *
 * Injection is closed by construction, not by escaping: the caller's name never
 * reaches the SQL string. `resolveClass` looks it up in `%Dictionary` and
 * returns the real `sqlTableName`; anything that fails to resolve throws before
 * a count query is built, so `Foo; DROP TABLE Bar` simply does not resolve.
 *
 * No Express, no Atelier, no HTTP — the port only.
 */
import { resolveClass, type SqlQuerier } from './schema-ops.js';
import { NotFoundError } from './iris-error.js';

export interface RowCount {
  /** The real ObjectScript class name, e.g. `SC.Data.BOM`. */
  className: string;
  /** The SQL table that was counted, e.g. `SC_Data.BOM`. */
  sqlTableName: string;
  total: number;
}

/**
 * Thrown when the requested name is not a compiled class or SQL table. A
 * subclass of `NotFoundError` so the error middleware maps it to 404 and the
 * nearest-match candidates ride along in `details.candidates` (kept also as a
 * top-level `.candidates` for existing callers/tests).
 */
export class ClassNotFoundError extends NotFoundError {
  readonly candidates: string[];

  constructor(input: string, candidates: string[]) {
    super(`Class "${input}" not found.`, { details: { candidates } });
    this.candidates = candidates;
  }
}

/**
 * Count the rows of `name`, which may be either form: `SC.Data.BOM` (class) or
 * `SC_Data.BOM` (SQL table). `resolveClass` accepts both.
 */
export async function countRows(q: SqlQuerier, name: string): Promise<RowCount> {
  const resolved = await resolveClass(q, name);
  if (!resolved.exists || !resolved.className || !resolved.sqlTableName) {
    throw new ClassNotFoundError(name, resolved.candidates ?? []);
  }

  // The alias case is preserved by IRIS: `AS total` comes back as key `total`
  // (measured 2026-08-14 — an unaliased COUNT(*) comes back as `Aggregate_1`,
  // which is why the alias is not optional).
  const rows = await q.query<{ total?: number | string }>(
    `SELECT COUNT(*) AS total FROM ${resolved.sqlTableName}`,
  );
  const first = rows[0];
  if (!first || first.total === undefined || first.total === null) {
    throw new Error(`COUNT(*) on ${resolved.sqlTableName} returned no usable row.`);
  }

  return {
    className: resolved.className,
    sqlTableName: resolved.sqlTableName,
    total: Number(first.total),
  };
}

/**
 * The per-name outcome of a bulk count. Unlike `RowCount` (the single-count
 * return) this omits `className`: in the batch that is the MAP KEY, so repeating
 * it in the value would be redundant. A failure carries only a message — the
 * batch is fed exact class names, so nearest-match candidates make no sense here.
 */
export type RowCountResult =
  | { ok: true; total: number; sqlTableName: string }
  | { ok: false; error: string };

/**
 * Count many classes in one call, keyed by the input name. Each name is counted
 * independently via `countRows`; a name that fails to resolve or whose count
 * errors yields `{ ok: false }` for THAT entry only and never sinks the batch.
 * Sequential over the shared connection — ~33 COUNT(*)s on the SC demo model is
 * acceptable for a dashboard load; a single grouped query is a later option, not
 * this one. Injection stays closed exactly as in `countRows`: an unresolved name
 * throws inside `countRows` before any count query is built, and is caught here.
 */
export async function countRowsMany(
  q: SqlQuerier,
  names: string[],
): Promise<Record<string, RowCountResult>> {
  const out: Record<string, RowCountResult> = {};
  for (const name of names) {
    try {
      const { total, sqlTableName } = await countRows(q, name);
      out[name] = { ok: true, total, sqlTableName };
    } catch (err) {
      out[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}
