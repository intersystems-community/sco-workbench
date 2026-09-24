// backend/src/util/sc-data-mapping.ts
//
// Which SC_Data table an sample-data CSV belongs in, and what ORDER a set of them
// loads in. Both are read out of the installed schema — the table names IRIS reports
// and the FOREIGN KEY graph it enforces — so nothing here is a hand-kept list of files,
// tables or columns that an SCO upgrade could quietly invalidate.
//
// The tables already exist (they are the SCO data model, installed with SCO); the load
// only ADDS ROWS to them — nothing here creates or alters a table.
//
// It rests on the guarantee the sample sets are built to: a CSV is NAMED AFTER ITS
// TABLE and its headers are named after that table's COLUMNS. So a file finds its table
// by name (`resolveScDataTable`, against `INFORMATION_SCHEMA.TABLES`) and each header
// finds its column by name (`planScDataColumns`, against `INFORMATION_SCHEMA.COLUMNS`).
// Neither is ever guessed at beyond that: a file name that matches no table is skipped
// and reported, and a header that matches no column is reported, because loading
// someone's rows into the wrong table and dropping a column behind a green tick are the
// two outcomes worth ruling out.
//
// The one ALIAS left is the primary key, `uid`, which a file may spell `UID` or `ID` —
// see `KEY_HEADERS` for why both have to be read and why `UID` wins.
import { basename } from 'node:path';

/** SQL schema of the SCO data model. The tables here are its, not ours. */
export const SC_DATA_SCHEMA = 'SC_Data';

/**
 * The business key every SC_Data table declares as its PRIMARY KEY. A row can only be
 * loaded — or recognized as already present — through it, so a file with no header for
 * it is refused rather than loaded blind.
 */
export const UID_COLUMN = 'uid';

/**
 * Header spellings accepted for the key column, best first. The only place a header is
 * not simply the column's own name, and it has to be: the shipped sets spell the key
 * `ID`, while a set exported straight out of SC_Data spells it `uid`.
 *
 * `UID` comes FIRST because a file that has both means two different things by them: an
 * export carries the business key in `uid` and the internal row id in `ID` (the identity
 * column), so taking `ID` there would put "47" in the primary key and break every
 * foreign key in the rest of the set. A file with only `ID` — every shipped set — is
 * unaffected, since then `ID` is the only match. The leftover `ID` column is not loaded
 * at all: it is IS_IDENTITY, which the loader refuses to write, and says so.
 */
export const KEY_HEADERS = ['UID', 'ID'] as const;

/**
 * The SC_Data table a CSV loads into, resolved against `tables` — the tables the
 * namespace ACTUALLY has (`listScDataTables`).
 *
 * Matched on the NAME only, two ways, each stricter than a guess: identical ignoring
 * case and separators (`mfg_orders` = `MfgOrders`), then either side made singular
 * (`mfgOrders.csv` → `MfgOrder`, `Issues.csv` → `Issue`). Nothing else is inferred, so a
 * set can add a file for any of the installed tables without a code change here, and a
 * file for none of them is skipped and reported rather than loaded somewhere plausible.
 *
 * An AMBIGUOUS name resolves to nothing rather than to a coin toss: two installed tables
 * normalizing alike means the file could go in either, and putting the user's rows in
 * the wrong one is far worse than reporting the file as skipped.
 */
export function resolveScDataTable(
  file: string,
  tables: readonly string[],
): string | undefined {
  const wanted = normalizeName(basename(file).replace(/\.csv$/i, ''));
  if (!wanted) return undefined;

  const keyed = tables
    .map((table) => ({ table, key: normalizeName(table) }))
    .filter((e) => e.key);
  const only = (matches: Array<{ table: string }>) =>
    matches.length === 1 ? matches[0]?.table : undefined;

  return (
    only(keyed.filter((e) => e.key === wanted)) ??
    only(keyed.filter((e) => singular(e.key) === singular(wanted)))
  );
}

/** Lowercased with separators and punctuation removed, so only the name itself is left. */
function normalizeName(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A crude singular of an already-normalized name: enough for the plural a CSV file name
 * uses (`locations`, `salesOrderLines`, `inventoryThresholds`, `deliveries`), and
 * deliberately not a linguistic one. `SLA`/`sla` and `status` keep their `s` (a name
 * ending `ss` is not a plural), so nothing that is already singular is mangled.
 */
function singular(key: string): string {
  if (key.endsWith('ies') && key.length > 3) return `${key.slice(0, -3)}y`;
  if (/(?:ch|sh|s|x|z)es$/.test(key)) return key.slice(0, -2);
  if (key.endsWith('s') && !key.endsWith('ss')) return key.slice(0, -1);
  return key;
}

/** What `orderSampleCsvFiles` needs to know about the set and the installed schema. */
export interface ScDataOrderOptions {
  /** The table a file loads into — `resolveScDataTable`, in practice. */
  tableOf?: (file: string) => string | undefined;
  /**
   * The tables whose rows must be in before this table's can be — its FOREIGN KEY
   * parents, as IRIS reports them (`describeScDataDependencies`). Given this, the order
   * is a fact about the installed model rather than a list someone maintains.
   */
  parentsOf?: (table: string) => readonly string[];
}

/**
 * `files` in load order: parents before the files that reference them.
 *
 * With `parentsOf` this is a topological sort of the set's real FOREIGN KEY graph, with
 * the order the files were GIVEN in as the tie-break — so a new file lands where its own
 * keys say it must, and two files with nothing between them stay in the order the caller
 * listed them (`listSampleDataCsvFiles` sorts, so that is alphabetical and stable).
 *
 * Without `parentsOf` the files are returned as given: there is nothing else to order
 * them by, and inventing an order would be worse than the caller's.
 *
 * A file that resolves to no table is KEPT, in place — the caller reports it as skipped
 * rather than dropping it silently. A parent whose file is not in this set is not waited
 * for: it cannot arrive, and rows needing it are reported as orphans by the load itself.
 * A SELF-reference is not waited for either (one file's rows satisfy it internally), and
 * a CYCLE — which SC_Data does not have beyond those self-references — falls back to the
 * tie-break order rather than dropping the files involved.
 */
export function orderSampleCsvFiles(
  files: readonly string[],
  options: ScDataOrderOptions = {},
): string[] {
  const { parentsOf, tableOf } = options;
  if (!parentsOf) return [...files];

  const nodes = files.map((file, i) => ({
    file,
    i,
    table: (tableOf?.(file) ?? '').toLowerCase(),
  }));
  /** The order the caller gave, which is the tie-break between unrelated files. */
  const preferred = (a: (typeof nodes)[number], b: (typeof nodes)[number]) => a.i - b.i;

  const present = new Set(nodes.map((n) => n.table).filter(Boolean));
  const waiting = (node: (typeof nodes)[number], loaded: Set<string>) =>
    (node.table ? parentsOf(node.table) : [])
      .map((parent) => parent.toLowerCase())
      // Not itself, and not a parent this set does not bring or has already loaded.
      .filter((parent) => parent !== node.table && present.has(parent) && !loaded.has(parent));

  const remaining = new Set(nodes);
  const loaded = new Set<string>();
  const ordered: string[] = [];
  while (remaining.size) {
    const left = [...remaining].sort(preferred);
    const next = left.find((node) => waiting(node, loaded).length === 0) ?? left[0];
    if (!next) break;
    remaining.delete(next);
    if (next.table) loaded.add(next.table);
    ordered.push(next.file);
  }
  return ordered;
}
