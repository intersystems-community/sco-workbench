/**
 * Load one sample-data CSV into its EXISTING `SC_Data` table, using IRIS's own
 * `LOAD DATA`.
 *
 * The SC_Data tables are the SCO data model — installed with the product, with real
 * PRIMARY KEY (`uid`) and FOREIGN KEY constraints. Nothing here creates, drops or
 * alters a table: a load only ADDS ROWS, and a row whose `uid` is already in the
 * table is skipped so pressing Load twice cannot double the data or fail.
 *
 * HOW THE ROWS GET IN (every point below measured on the user's IRIS 2025.2, 2026-09-08):
 *  1. `LOAD DATA FROM FILE` reads a path on the IRIS INSTANCE's filesystem, and the
 *     backend is a separate container with no shared mount — so the CSV is first
 *     materialized inside IRIS with `putFileToIris` (the same Native-SDK staging the
 *     upload routes use), then deleted in a `finally`.
 *  2. The staged file is REWRITTEN rather than copied: its header row is the TARGET
 *     COLUMN NAMES and its columns are in target order. That removes the whole class
 *     of header-mapping failures at the SQL layer — a header containing a space
 *     ("Start Date") needs a quoted identifier in `VALUES` and a header the file does
 *     not have fails the statement outright with SQLCODE -400 — and it is where rows
 *     with a duplicate `uid` are dropped.
 *  3. Duplicates are filtered HERE, not left to IRIS. `LOAD DATA` does survive a
 *     duplicate key (it skips the row and still reports `status: Complete`), but it
 *     writes ~2 `%SQL_Diag.Message` rows per rejected row — ~31,000 of them for a
 *     re-load of the shipped set — and reports `inputRecordCount: 0`, so we would
 *     have no honest count to show the user either.
 *  4. Column names are resolved from `INFORMATION_SCHEMA.COLUMNS`, never from a list
 *     kept here: the sample sets are built so that a HEADER IS ITS COLUMN'S NAME, so
 *     the installed table is the only thing worth asking. That is also the only way to
 *     get the spelling right — the product's own loader spells some columns differently
 *     from the class definition (`customerID` vs `customerId`) — and a column the
 *     installed model does not have must be skipped, not sent. The same query says which
 *     columns may be WRITTEN to (see `planScDataColumns`).
 *  5. Rows whose FOREIGN KEY has no parent are dropped here as well, for the same
 *     reason duplicates are, only more so. `LOAD DATA` enforces SC_Data's foreign keys
 *     and rejects a violating row with SQLCODE -121 — while STILL reporting
 *     `status: Complete` — and its `maxErrorCount` option is silently ignored, so there
 *     is no fail-fast to ask for. Left to IRIS, a `customers.csv` whose locations are
 *     absent spent 57 SECONDS rejecting all 1,019 of its rows (measured 2026-09-08),
 *     which blew the HTTP timeout and cost the user the whole set's report. Checked
 *     first, the same file is refused in well under a second with the reason in it.
 *     See `dropOrphanRows`.
 *  6. The same query reports each column's TYPE, because a value can be right for the
 *     column's name and still wrong for its type. `SC_Data.BOM.isAlternate` is a `BIT`,
 *     which accepts only 1 or 0, while the generator's `BOM.csv` writes `Yes`/`No` —
 *     so IRIS failed validation on all 5,103 rows, one message each, until the web
 *     gateway abandoned the request with an HTTP 504. Boolean words are converted for
 *     a boolean column before staging; see `coerceScDataCell`.
 *  7. Whatever is left over is REPORTED rather than dropped quietly: a header no column
 *     of the table took means that column's values did not load, and the user has to
 *     hear it even though the load itself succeeded (see `unmatchedHeaders`). This is the
 *     price of resolving everything by name — a respelled header is not guessed at — and
 *     it is only a fair price if it is said out loud.
 *  8. The other two things read from the schema are exposed here as well
 *     (`listScDataTables`, `describeScDataDependencies`), so which table a CSV belongs
 *     in and the ORDER a set of them loads in are facts about the installed model rather
 *     than a hand-kept list: see `sc-data-mapping.ts`, which has no such list left.
 *
 * Injection: the values ride inside the staged CSV, never in SQL text. The only
 * interpolated strings are the table name and column names — both resolved from
 * INFORMATION_SCHEMA, i.e. names IRIS itself reports — and the staged file path,
 * which is asserted quote-free below.
 */
import { posix as posixPath } from "node:path";
import type { SqlQuerier } from "./schema-ops.js";
import type { NativeClient } from "./native-client.js";
import { deleteFileFromIris, putFileToIris } from "./file-ops.js";
import { parseCsv } from "../util/csv-inspect.js";
import { KEY_HEADERS, SC_DATA_SCHEMA, UID_COLUMN } from "../util/sc-data-mapping.js";

/**
 * Hard cap on rows parsed from one CSV (header included). The shipped sets top out
 * at ~3,000 rows per file; this is far above that but still bounds the memory a
 * hand-dropped file can cost. A file that hits the cap is rejected, not truncated —
 * silently loading the first 200,000 rows of a bigger file would be a lie.
 */
export const MAX_CSV_ROWS = 200_000;

/**
 * `uid`s probed per round trip when checking which rows are already in the table.
 * We ask only about the uids in the FILE (`WHERE uid IN (?,…)`, index-backed) rather
 * than reading the table's whole uid column, so the cost scales with the CSV and not
 * with however much real data the user's table already holds. Kept well under the
 * ~300-placeholder point where the Atelier query wrapper's ObjectScript stack gives
 * out (measured 2026-09-07).
 */
export const UID_PROBE_CHUNK = 200;

/**
 * Most distinct values one foreign-key column is checked row by row. Above this the
 * per-row check is skipped and IRIS's own constraint is left to do the work — 5,000
 * values is 25 round trips, and a file with more distinct parents than that is not the
 * shape of file this check exists for (a whole set pointing at parents that are not
 * there). The cheap "is the parent table EMPTY?" test still runs at any size, and that
 * is the case that actually costs minutes.
 */
const FK_PROBE_LIMIT = 5_000;

/**
 * How long ONE `LOAD DATA` may take before the request is abandoned. A bulk load is not
 * a schema query: the default 30s HTTP timeout is shorter than a single 1,000-row file
 * took on the reference instance. Fixed rather than configurable — ten minutes is more
 * than any set needs (rows IRIS ACCEPTS go in fast; it is the ones it REJECTS, one
 * logged diagnostic each, that take the time), and the gateway's own timeout would cap
 * a larger value anyway.
 */
export const LOAD_TIMEOUT_MS = 600_000;

/** Subdirectory under the IRIS CSV staging dir that holds the rewritten files. */
const STAGE_SUBDIR = "sample-data";

export interface ScDataLoadDeps {
    /** SQL port — `iris.atelier`; `/action/query` runs `LOAD DATA` and DML, not just SELECT. */
    sql: SqlQuerier;
    /** Native SDK client, used only to materialize and delete the staged CSV inside IRIS. */
    native: NativeClient;
    /** Directory INSIDE the IRIS container to stage CSVs in (`env.SCO_UPLOAD_CSV_DIR`). */
    stageDir: string;
}

/** What one CSV's load did. A union so "skipped" can never read as "loaded 0 rows". */
export type ScDataLoadResult =
    | {
          loaded: true;
          /** Table as INFORMATION_SCHEMA spells it. */
          table: string;
          /** Target columns actually loaded, in staged order. */
          columns: string[];
          /** Rows added, verified by counting the table before and after. */
          rows: number;
          /** Rows in the file that were not sent: uid already present, repeated, or blank. */
          skippedRows: number;
          /**
           * Rows left out because a FOREIGN KEY value of theirs has no parent row — the row
           * references something this namespace does not have. Counted apart from
           * `skippedRows` because it means the opposite thing: a skipped row is already
           * loaded, an orphan row is DATA THAT DID NOT LOAD and will not until its parent
           * does.
           */
          orphanRows: number;
          /** Which references were missing, when `orphanRows` is non-zero. */
          orphanReason?: string;
          /**
           * Headers the file has that no column of the table took, so their values did NOT
           * load. Never an error — a set may legitimately carry a column SC_Data has no home
           * for — but reported, because a respelled header would otherwise go missing behind
           * a successful load. See `unmatchedHeaders`.
           */
          ignoredHeaders: string[];
          /** Data rows the file holds (blank lines excluded). */
          totalRows: number;
      }
    | { loaded: false; table: string; reason: string };

/** A table's real name and its columns, keyed lowercase → as IRIS spells them. */
export interface ScDataTableInfo {
    table: string;
    /** Every column the table has. */
    columns: Map<string, string>;
    /**
     * The subset a load may write to: not the identity/auto-increment `ID`, not a
     * system-generated column (`lastUpdatedTime`, `recordCreatedTime`), not a read-only
     * one. This subset is what a CSV header is matched against.
     */
    writable: Map<string, string>;
    /**
     * Each column's SQL type, UPPERCASED (`VARCHAR`, `BIT`, `TIMESTAMP`, …) and keyed
     * lowercase. Read because a value that is right for the column's NAME can still be
     * wrong for its TYPE — see `coerceScDataCell`.
     */
    types: Map<string, string>;
}

/** One target column, the header feeding it, and that header's index in the file. */
export interface ScDataColumnPlan {
    column: string;
    header: string;
    index: number;
}

/**
 * The installed table's real name and columns, or undefined when `SC_Data` has no
 * such table — which is the user-visible "skip this CSV and report it" case, not an
 * error, so it is a return value rather than a throw.
 */
export async function describeScDataTable(sql: SqlQuerier, table: string): Promise<ScDataTableInfo | undefined> {
    const rows = await sql.query<ScDataColumnRow>(
        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_IDENTITY, IS_GENERATED, IS_UPDATABLE, AUTO_INCREMENT " +
            "FROM INFORMATION_SCHEMA.COLUMNS " +
            "WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)",
        [SC_DATA_SCHEMA, table],
    );
    if (!rows.length) return undefined;

    const columns = new Map<string, string>();
    const writable = new Map<string, string>();
    const types = new Map<string, string>();
    for (const row of rows) {
        const name = String(row.COLUMN_NAME ?? "").trim();
        if (!name) continue;
        columns.set(name.toLowerCase(), name);
        if (isWritableColumn(row)) writable.set(name.toLowerCase(), name);
        // IRIS reports the type in either case depending on the query's collation, so it
        // is normalized here rather than at every comparison.
        types.set(
            name.toLowerCase(),
            String(row.DATA_TYPE ?? "")
                .trim()
                .toUpperCase(),
        );
    }
    return { table: String(rows[0]?.TABLE_NAME ?? "").trim() || table, columns, writable, types };
}

/**
 * Every table `SC_Data` has in this namespace, as IRIS spells them.
 *
 * Read once per load, and the only thing a CSV's table is resolved against
 * (`resolveScDataTable`) — so a set may carry a file for any installed table. Views are
 * left out: `LOAD DATA` needs a real table.
 */
export async function listScDataTables(sql: SqlQuerier): Promise<string[]> {
    const rows = await sql.query<{ TABLE_NAME?: string }>(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES " +
            "WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_TYPE) = 'BASE TABLE' " +
            "ORDER BY TABLE_NAME",
        [SC_DATA_SCHEMA],
    );
    return rows.map((row) => String(row.TABLE_NAME ?? "").trim()).filter(Boolean);
}

/**
 * The whole schema's FOREIGN KEY graph in one query: table → the tables it references.
 *
 * This is what makes the LOAD ORDER a fact about the installed schema rather than a list
 * someone maintains. Keys and values are LOWERCASED, deliberately: this query returns
 * names in whatever case its collation feels like (measured: `SALESSHIPMENT` here,
 * `SalesShipment` from the per-table query), so they are only ever compared, never used
 * as an identifier. Self-references are kept — the caller decides what they mean, and for
 * one file's rows they resolve inside that file.
 *
 * Composite keys are included here, unlike in `describeScDataForeignKeys`: a composite
 * still means the parent must load first, even though its columns cannot be pre-flighted
 * one at a time.
 */
export async function describeScDataDependencies(sql: SqlQuerier): Promise<Map<string, string[]>> {
    const rows = await sql.query<{ TABLE_NAME?: string; REFERENCED_TABLE_NAME?: string }>(
        "SELECT DISTINCT TABLE_NAME, REFERENCED_TABLE_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE " +
            "WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(REFERENCED_TABLE_SCHEMA) = UPPER(?) " +
            "AND CONSTRAINT_TYPE = 'FOREIGN KEY'",
        [SC_DATA_SCHEMA, SC_DATA_SCHEMA],
    );

    const parents = new Map<string, string[]>();
    for (const row of rows) {
        const child = String(row.TABLE_NAME ?? "")
            .trim()
            .toLowerCase();
        const parent = String(row.REFERENCED_TABLE_NAME ?? "")
            .trim()
            .toLowerCase();
        if (!child || !parent) continue;
        const held = parents.get(child);
        if (held) {
            if (!held.includes(parent)) held.push(parent);
        } else parents.set(child, [parent]);
    }
    return parents;
}

/** One `INFORMATION_SCHEMA.COLUMNS` row, as IRIS 2025.2 returns it. */
interface ScDataColumnRow {
    TABLE_NAME?: string;
    COLUMN_NAME?: string;
    DATA_TYPE?: string;
    IS_IDENTITY?: string;
    IS_GENERATED?: string;
    IS_UPDATABLE?: string;
    AUTO_INCREMENT?: string;
}

/**
 * Whether a load may put a value in this column. Measured on `SC_Data.Location`
 * (2026-09-08): `ID` is `IS_IDENTITY = YES` / `AUTO_INCREMENT = YES` and is filled by
 * `$i(^SC.Data.LocationD)`, while `lastUpdatedTime` and `recordCreatedTime` are
 * `IS_GENERATED = YES` ("read-only after insert"). Writing any of them would either be
 * refused or would overwrite bookkeeping the product maintains.
 *
 * Only `NO`/`YES` are treated as meaningful: a column an older IRIS reports nothing for
 * stays writable, because the alternative is silently refusing to load a real column.
 */
function isWritableColumn(row: ScDataColumnRow): boolean {
    const is = (value: string | undefined, want: string) =>
        String(value ?? "")
            .trim()
            .toUpperCase() === want;
    return (
        !is(row.IS_IDENTITY, "YES") &&
        !is(row.AUTO_INCREMENT, "YES") &&
        !is(row.IS_GENERATED, "YES") &&
        !is(row.IS_UPDATABLE, "NO")
    );
}

/** One foreign key of a table being loaded: this column must match a row over there. */
interface ScDataForeignKey {
    /** Constraint name, as IRIS reports it in its own -121 message. */
    constraint: string;
    /** Column in the table being loaded. */
    column: string;
    /** Table in `SC_DATA_SCHEMA` the value must exist in. */
    parentTable: string;
    /** Column of the parent it is matched against (`uid`, throughout SC_Data). */
    parentColumn: string;
}

/**
 * The table's foreign keys, as IRIS itself will enforce them during the load.
 *
 * `KEY_COLUMN_USAGE` carries the whole relationship in one row — the referencing
 * column plus `REFERENCED_TABLE_NAME`/`REFERENCED_COLUMN_NAME` — so no join is needed
 * (the obvious `REFERENTIAL_CONSTRAINTS` + `CONSTRAINT_COLUMN_USAGE` join produces a
 * cross product on this instance).
 *
 * Two kinds are deliberately left out, and are simply enforced by IRIS instead:
 *  - keys pointing OUTSIDE `SC_Data`, which are not this loader's business;
 *  - COMPOSITE keys, whose columns are only meaningful together. Checking a composite
 *    column by column would pass a row whose values exist separately but not as a pair.
 *    SC_Data has no composite key today; if one appears, being silently un-preflighted
 *    is the safe direction — IRIS still rejects the row, and the diagnosis is read back
 *    from `%SQL_Diag` (see `describeLoadDiagnostics`).
 */
async function describeScDataForeignKeys(sql: SqlQuerier, table: string): Promise<ScDataForeignKey[]> {
    const rows = await sql.query<ScDataKeyColumnRow>(
        "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME " +
            "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE " +
            "WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?) " +
            "AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND UPPER(REFERENCED_TABLE_SCHEMA) = UPPER(?)",
        [SC_DATA_SCHEMA, table, SC_DATA_SCHEMA],
    );

    const byConstraint = new Map<string, ScDataForeignKey[]>();
    for (const row of rows) {
        const key: ScDataForeignKey = {
            constraint: String(row.CONSTRAINT_NAME ?? "").trim(),
            column: String(row.COLUMN_NAME ?? "").trim(),
            parentTable: String(row.REFERENCED_TABLE_NAME ?? "").trim(),
            parentColumn: String(row.REFERENCED_COLUMN_NAME ?? "").trim(),
        };
        if (!key.column || !key.parentTable || !key.parentColumn) continue;
        const group = byConstraint.get(key.constraint.toLowerCase());
        if (group) group.push(key);
        else byConstraint.set(key.constraint.toLowerCase(), [key]);
    }
    return [...byConstraint.values()].filter((group) => group.length === 1).flat();
}

/** One `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` row, as IRIS 2025.2 returns it. */
interface ScDataKeyColumnRow {
    CONSTRAINT_NAME?: string;
    COLUMN_NAME?: string;
    REFERENCED_TABLE_NAME?: string;
    REFERENCED_COLUMN_NAME?: string;
}

/**
 * Pair the file's header row with the table's columns, BY NAME — each target column is
 * read from wherever its header sits, so the file's column order does not matter. The
 * returned plan is in TARGET order (the key column first, then the file's own order),
 * which is the order the staged file is written in.
 *
 * TWO passes, in this order:
 *  1. The PRIMARY KEY, `uid`, which is the one column whose header may be spelled
 *     differently from it (`KEY_HEADERS`) and the one the whole load turns on: it is
 *     what makes a re-load idempotent. It goes first so that a file carrying both `uid`
 *     and `ID` keys on `uid` rather than on whichever came first in the file.
 *  2. Every other header, matched against the table's WRITABLE columns by name. This is
 *     the whole mapping: a header IS the column's name, so a set can carry any column
 *     the installed table has — `SC_Data.Location` has `region`, `latitude`,
 *     `longitude`, `gln`, … — without anything here being told about it first.
 *
 * A header is only taken when the table has a column of that name AND that column may
 * be written to — never the identity `ID` or a generated timestamp (see
 * `isWritableColumn`), never a column pass 1 already filled. A header that matches
 * nothing is ignored IN PLACE, without shifting the columns after it, and reported
 * (`unmatchedHeaders`) so its values are not lost quietly.
 *
 * A column the file has no header for is simply not loaded, which is not an error: the
 * shipped `demandPlan.csv` has no `quantityUom`, and refusing 738 good rows over one
 * absent optional column would serve nobody. The `uid` column is the exception — with no
 * key there is nothing to make the load idempotent, so its absence throws.
 */
export function planScDataColumns(file: string, header: readonly string[], info: ScDataTableInfo): ScDataColumnPlan[] {
    const at = new Map<string, number>();
    header.forEach((h, i) => {
        const key = h.trim().toLowerCase();
        // First wins: a duplicated header is read from its first column.
        if (key && !at.has(key)) at.set(key, i);
    });

    const plans: ScDataColumnPlan[] = [];
    const usedHeaders = new Set<string>();
    const usedColumns = new Set<string>();
    const take = (column: string, index: number, headerKey: string) => {
        plans.push({ column, header: header[index] ?? column, index });
        usedHeaders.add(headerKey);
        usedColumns.add(column.toLowerCase());
    };

    const uidColumn = info.columns.get(UID_COLUMN);
    if (uidColumn) {
        for (const candidate of KEY_HEADERS) {
            const key = candidate.toLowerCase();
            const index = at.get(key);
            if (index === undefined) continue;
            take(uidColumn, index, key);
            break;
        }
    }

    // Pass 2, in the file's own column order so the staged file is deterministic.
    for (const [key, index] of at) {
        if (usedHeaders.has(key)) continue;
        const column = info.writable.get(key);
        if (!column || usedColumns.has(column.toLowerCase())) continue;
        take(column, index, key);
    }

    if (!plans.some((p) => p.column.toLowerCase() === UID_COLUMN)) {
        throw new Error(
            `${file} has no ${KEY_HEADERS.join(" or ")} column, ` +
                `so its rows have no key for ${SC_DATA_SCHEMA}.${info.table}.`,
        );
    }
    return plans;
}

/**
 * Headers the file has that NOTHING took, in file order and without repeats.
 *
 * Reported because the alternative is silence: neither pass of `planScDataColumns` can
 * place a header the table has no column for, and until this was reported such a column
 * was dropped behind a green "loaded 738 rows". That is the failure mode of a header
 * being respelled — in the shipped sets, `products.csv` carries `ImageUrl` and
 * `salesOrders.csv` carries `Type`, and `SC_Data` has no column for either.
 *
 * A blank header is not reported: an empty trailing column is a spreadsheet artefact,
 * not a value someone meant to load.
 */
export function unmatchedHeaders(header: readonly string[], plans: readonly ScDataColumnPlan[]): string[] {
    const taken = new Set(plans.map((p) => p.header.trim().toLowerCase()));
    const seen = new Set<string>();
    const left: string[] = [];
    for (const cell of header) {
        const name = cell.trim();
        const key = name.toLowerCase();
        if (!name || taken.has(key) || seen.has(key)) continue;
        seen.add(key);
        left.push(name);
    }
    return left;
}

/**
 * SQL types IRIS validates as a BOOLEAN: the stored value may only be 1 or 0, and
 * anything else — `Yes`, `true`, `Y` — fails validation rather than being converted.
 */
const BOOLEAN_TYPES = new Set(["BIT", "BOOLEAN"]);

/** Spellings of true and false a CSV writes for a boolean column. */
const TRUE_WORDS = new Set(["1", "Y", "YES", "T", "TRUE", "ON"]);
const FALSE_WORDS = new Set(["0", "N", "NO", "F", "FALSE", "OFF"]);

/**
 * One cell, put in the form the target COLUMN'S TYPE requires.
 *
 * Today that means exactly one thing: a `BIT` column takes 1 or 0, and IRIS rejects
 * every other spelling of a boolean per row — `Field 'SC_Data.BOM.isAlternate' (value
 * 'No') failed validation`, measured 2026-09-08 on `SCO_Data_Generator/BOM.csv`, whose
 * `Is Alternate` column is `Yes`/`No` for all 5,103 rows. That is not a corrupt file,
 * it is the ordinary way a CSV writes a boolean, and one such column must not cost the
 * whole file: the load ground through it row by row for minutes until the IRIS web
 * gateway gave up with an HTTP 504.
 *
 * A value that is NOT a recognised boolean is passed through untouched, deliberately:
 * inventing a 0 for it would silently store data the file never contained, whereas
 * leaving it makes IRIS reject that row and say why (see `describeLoadDiagnostics`).
 * An EMPTY cell — including one holding nothing but spaces, which is not a boolean
 * either — is staged empty, exactly as for every other column. IRIS then decides what
 * that means: measured on a nullable `bit`, its `LOAD DATA` stores 0 rather than NULL.
 */
function coerceScDataCell(value: string, dataType: string | undefined): string {
    if (!dataType || !BOOLEAN_TYPES.has(dataType.toUpperCase())) return value;
    const word = value.trim().toUpperCase();
    // Nothing to convert: leave the cell empty and let IRIS apply its own rule.
    if (!word) return "";
    if (TRUE_WORDS.has(word)) return "1";
    if (FALSE_WORDS.has(word)) return "0";
    return value;
}

/** One CSV field, quoted only when it has to be (RFC 4180). */
export function csvCell(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One CSV line from its cells. */
export function csvRow(cells: readonly string[]): string {
    return cells.map(csvCell).join(",");
}

/**
 * The file to stage: a header of TARGET column names, then the kept rows. Always
 * newline-terminated so `LOAD DATA` sees a complete last record.
 */
export function buildStagedCsv(columns: readonly string[], rows: readonly string[][]): string {
    return [csvRow(columns), ...rows.map(csvRow)].join("\n") + "\n";
}

/**
 * Load `csv` into its SC_Data table.
 *
 * Returns `{ loaded: false, reason }` only when the table is not installed. Anything
 * else that goes wrong — an unusable header, a `LOAD DATA` failure, a row count that
 * does not match what we sent — throws, so the route reports that file as failed
 * rather than as a quiet success.
 */
export async function loadScDataCsv(
    deps: ScDataLoadDeps,
    args: { file: string; table: string; csv: string },
): Promise<ScDataLoadResult> {
    const { sql, native, stageDir } = deps;
    const { file, table, csv } = args;

    const info = await describeScDataTable(sql, table);
    if (!info) {
        return {
            loaded: false,
            table,
            reason: `${SC_DATA_SCHEMA}.${table} does not exist in this namespace, so ${file} was skipped.`,
        };
    }

    const parsed = parseCsv(csv, MAX_CSV_ROWS);
    if (parsed.length >= MAX_CSV_ROWS) {
        throw new Error(`${file} has more than ${MAX_CSV_ROWS - 1} rows.`);
    }
    // A file of nothing but blank lines has "rows" but no header names, which is empty
    // rather than a header-matching failure.
    const header = parsed[0];
    if (!header?.some((cell) => cell.trim() !== "")) throw new Error(`${file} is empty.`);

    const plans = planScDataColumns(file, header, info);
    const columns = plans.map((p) => p.column);
    const ignoredHeaders = unmatchedHeaders(header, plans);
    const uidAt = plans.findIndex((p) => p.column.toLowerCase() === UID_COLUMN);

    // Blank lines are not rows; everything else counts, however ragged.
    const dataRows = parsed.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));
    // Each target column's type, so a cell can be put in the form that column accepts.
    const types = plans.map((p) => info.types.get(p.column.toLowerCase()));
    const picked = dataRows.map((row) => plans.map((p, i) => coerceScDataCell(row[p.index] ?? "", types[i])));

    // Rows already in the table, plus repeats inside the file itself, are dropped: the
    // user's rule is "if a uid exists, ignore that row and continue with the others".
    // A blank uid goes too — it cannot satisfy the NOT NULL primary key.
    const existing = await findExistingUids(
        sql,
        info,
        picked.map((row) => row[uidAt] ?? ""),
    );
    const seen = new Set<string>();
    const fresh = picked.filter((row) => {
        const uid = (row[uidAt] ?? "").trim();
        if (!uid || existing.has(uid) || seen.has(uid)) return false;
        seen.add(uid);
        return true;
    });

    // Rows referencing a parent that is not there go too — see point 5 in the module
    // comment. This is where a set with a missing locations.csv is refused in under a
    // second instead of being ground through row by row by IRIS.
    const orphans = await dropOrphanRows(sql, { info, columns, rows: fresh, uidAt });
    const kept = orphans.rows;
    const skippedRows = dataRows.length - fresh.length;

    if (!kept.length) {
        return {
            loaded: true,
            table: info.table,
            columns,
            rows: 0,
            skippedRows,
            orphanRows: orphans.dropped,
            ...(orphans.reason ? { orphanReason: orphans.reason } : {}),
            ignoredHeaders,
            totalRows: dataRows.length,
        };
    }

    const irisPath = stagedPath(stageDir, info.table);
    const before = await countRows(sql, info.table);
    const diagFrom = await latestDiagResultId(sql);
    try {
        putFileToIris(native, {
            irisPath,
            bytes: Buffer.from(buildStagedCsv(columns, kept), "utf8"),
        });
        // The one statement here that runs for minutes, and the one that must not be
        // retried: a `LOAD DATA` that timed out on our side may still be writing inside
        // IRIS, so a second attempt would race the first. (It was the RETRY, three times
        // over a 57s statement, that turned one slow file into a page-level 504.)
        await sql.query(buildLoadDataSql(irisPath, info.table, columns), [], {
            timeoutMs: LOAD_TIMEOUT_MS,
            attempts: 1,
        });
    } finally {
        // Never leave the user's data lying in a temp file inside their IRIS, even when
        // the load failed.
        try {
            deleteFileFromIris(native, irisPath);
        } catch {
            // Cleanup only — the load's own outcome is what the caller must hear about.
        }
    }

    // `LOAD DATA` reports `status: Complete` even when it silently rejected rows, so
    // the count is READ BACK rather than assumed. (A concurrent writer on the same
    // table would skew this; that is worth a false alarm to never claim rows landed
    // when they did not.)
    const rows = (await countRows(sql, info.table)) - before;
    if (rows !== kept.length) {
        // What happened first, on one line; WHY on the next, and only when there is a
        // why. `LOAD DATA` reports success and writes its real verdict to %SQL_Diag, so
        // the reason is worth a line of its own — but when the diagnostics say nothing
        // usable, nothing is appended: a sentence about SCO's silence is one more thing
        // to read and still leaves the user exactly where the first line left them.
        const diagnosis = await describeLoadDiagnostics(sql, diagFrom);
        throw new Error(
            `Sent ${kept.length} row(s) to ${SC_DATA_SCHEMA}.${info.table}, ${rows} loaded. ` +
                `Data loading for this table failed.` +
                (diagnosis ? `\n${diagnosis}` : ""),
        );
    }
    return {
        loaded: true,
        table: info.table,
        columns,
        rows,
        skippedRows,
        orphanRows: orphans.dropped,
        ...(orphans.reason ? { orphanReason: orphans.reason } : {}),
        ignoredHeaders,
        totalRows: dataRows.length,
    };
}

/** `LOAD DATA FROM FILE '…' INTO SC_Data."Location"("uid",…) VALUES ("uid",…) USING …`. */
export function buildLoadDataSql(irisPath: string, table: string, columns: readonly string[]): string {
    const list = columns.map(quoteIdent).join(",");
    return (
        `LOAD DATA FROM FILE '${irisPath}' INTO ${SC_DATA_SCHEMA}.${quoteIdent(table)}(${list}) ` +
        // Both sides are the same names because the staged file's header IS the target
        // column list — see the module comment.
        `VALUES (${list}) USING {"from":{"file":{"header":"1"}}}`
    );
}

/** Which of `uids` the table already holds, asked in index-backed chunks. */
async function findExistingUids(sql: SqlQuerier, info: ScDataTableInfo, uids: readonly string[]): Promise<Set<string>> {
    const uidColumn = info.columns.get(UID_COLUMN);
    if (!uidColumn) {
        throw new Error(`${SC_DATA_SCHEMA}.${info.table} has no ${UID_COLUMN} column.`);
    }
    return findExistingValues(sql, info.table, uidColumn, uids);
}

/** Which of `values` the table holds in `column`, asked in index-backed chunks. */
async function findExistingValues(
    sql: SqlQuerier,
    table: string,
    column: string,
    values: readonly string[],
): Promise<Set<string>> {
    const wanted = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
    const found = new Set<string>();
    for (let start = 0; start < wanted.length; start += UID_PROBE_CHUNK) {
        const chunk = wanted.slice(start, start + UID_PROBE_CHUNK);
        const rows = await sql.query<Record<string, unknown>>(
            `SELECT ${quoteIdent(column)} AS value FROM ${SC_DATA_SCHEMA}.${quoteIdent(table)} ` +
                `WHERE ${quoteIdent(column)} IN (${chunk.map(() => "?").join(",")})`,
            chunk,
        );
        for (const row of rows) {
            const value = String(row.value ?? "").trim();
            if (value) found.add(value);
        }
    }
    return found;
}

/** What the foreign-key pass kept, what it dropped, and how to explain the drop. */
interface OrphanFilterResult {
    /** The rows still worth sending, in order. */
    rows: string[][];
    /** How many rows were dropped (a row failing two keys is counted once). */
    dropped: number;
    /** Human reason naming each key that came up short, or undefined when none did. */
    reason?: string;
}

/**
 * Drop the rows IRIS would reject for referential integrity, and say which reference
 * was missing.
 *
 * Only the foreign keys whose column this load actually fills are checked — a column
 * the file has no header for is left NULL, and a NULL foreign key is allowed
 * throughout SC_Data. A BLANK value is treated the same way for the same reason.
 *
 * Cost is bounded deliberately (`FK_PROBE_LIMIT`), and the empty-parent case is
 * answered without probing at all, because that is the expensive one in practice: a set
 * missing its `locations.csv` has every row of every location-referencing file orphaned.
 *
 * A SELF-reference (`SalesShipment.parentShipmentId` → `SalesShipment.uid`) also
 * accepts a uid from THIS file: its parent lands in the same load. A row referencing
 * one that appears LATER in the file is still rejected by IRIS, which loads in file
 * order — accepting it here only means IRIS gets the last word on it, which is better
 * than dropping a row that would have loaded.
 */
async function dropOrphanRows(
    sql: SqlQuerier,
    args: {
        info: ScDataTableInfo;
        columns: readonly string[];
        rows: readonly string[][];
        uidAt: number;
    },
): Promise<OrphanFilterResult> {
    const { info, rows, uidAt } = args;
    const at = new Map(args.columns.map((column, i) => [column.toLowerCase(), i]));
    const keys = (await describeScDataForeignKeys(sql, info.table)).filter((fk) => at.has(fk.column.toLowerCase()));
    if (!keys.length || !rows.length) return { rows: [...rows], dropped: 0 };

    const doomed = new Set<number>();
    const reasons: string[] = [];
    for (const fk of keys) {
        const index = at.get(fk.column.toLowerCase());
        if (index === undefined) continue;
        const values = rows.map((row) => (row[index] ?? "").trim());
        const referenced = [...new Set(values.filter(Boolean))];
        if (!referenced.length) continue;

        const parentHasRows = await hasAnyRow(sql, fk.parentTable, fk.parentColumn);
        let present: Set<string>;
        if (!parentHasRows) {
            present = new Set<string>();
        } else if (referenced.length > FK_PROBE_LIMIT) {
            continue; // Too many to check one by one; IRIS's own constraint has it.
        } else {
            present = await findExistingValues(sql, fk.parentTable, fk.parentColumn, referenced);
        }
        if (fk.parentTable.toLowerCase() === info.table.toLowerCase()) {
            for (const row of rows) {
                const uid = (row[uidAt] ?? "").trim();
                if (uid) present.add(uid);
            }
        }

        let missing = 0;
        let example = "";
        values.forEach((value, i) => {
            if (!value || present.has(value)) return;
            doomed.add(i);
            missing++;
            if (!example) example = value;
        });
        if (missing) {
            reasons.push(
                `${missing} row(s) name a ${SC_DATA_SCHEMA}.${fk.parentTable} that is not in this ` +
                    `namespace (${fk.column} "${example}"), so ${fk.constraint} would reject them`,
            );
        }
    }

    if (!doomed.size) return { rows: [...rows], dropped: 0 };
    return {
        rows: rows.filter((_row, i) => !doomed.has(i)),
        dropped: doomed.size,
        reason: reasons.join("; "),
    };
}

/**
 * The newest `%SQL_Diag.Result` id, captured BEFORE a load so the load's own diagnosis
 * can be told from every earlier one's. Zero when the table cannot be read, which only
 * costs us the diagnosis, not the load.
 */
async function latestDiagResultId(sql: SqlQuerier): Promise<number> {
    try {
        const rows = await sql.query<{ id?: number | string }>(
            "SELECT TOP 1 ID AS id FROM %SQL_Diag.Result ORDER BY ID DESC",
        );
        return Number(rows[0]?.id ?? 0) || 0;
    } catch {
        return 0;
    }
}

/**
 * What IRIS says went wrong in the load that just ran — its error count and the first
 * couple of distinct messages, e.g. "Table 'SC_Data.Customer', Foreign Key Constraint
 * 'primaryLocationIdFK', Field(s) PRIMARYLOCATIONID failed referential integrity check".
 *
 * `LOAD DATA` reports `status: Complete` and `sqlcode: 0` even when it rejected every
 * row, and writes the truth to `%SQL_Diag` instead — so this is the only place the real
 * reason exists. Best-effort throughout, and '' whenever there is no reason to give — an
 * unreadable diag table, no diag result for this load, or a result whose messages are all
 * narration. The caller's own complaint stands on its own; this only ever adds to it.
 *
 * `%SQL_Diag.Message` has no `messageId` column (SQLCODE -29 if you ask for one), and
 * `SELECT DISTINCT message` comes back UPPERCASED by the field's collation, so rows are
 * ordered by `%ID` and de-duplicated here instead.
 *
 * NOTHING that carries a reason is filtered out in SQL any more, because "IRIS rejected
 * 104 row(s), without saying why" turned out to be this function's own doing rather than
 * IRIS's silence: a batched load can log its rejection ONLY as `Batch row: 7 [SQLCODE:
 * <-104>…] …` lines, and the old pair of filters — `sqlcode <> 0` in the WHERE, plus
 * "drop every batch-row line" here — threw every one of those away and left the user with
 * a bare number. So the sqlcode is READ rather than filtered on, the `Batch row: N`
 * prefix is STRIPPED rather than used to discard the line, and the prefixed form is
 * reported only when no unprefixed message says the same thing (it repeats the message
 * below it once per rejected row, so it is the noisier of two wordings, not a reason of
 * its own).
 */
async function describeLoadDiagnostics(sql: SqlQuerier, sinceId: number): Promise<string> {
    try {
        const results = await sql.query<{ id?: number | string; errors?: number | string }>(
            "SELECT TOP 1 ID AS id, errorCount AS errors FROM %SQL_Diag.Result " + "WHERE ID > ? ORDER BY ID DESC",
            [sinceId],
        );
        const result = results[0];
        if (!result) return "";

        // Preferred wording first, fallback wording second; a line that says the same
        // thing in both forms is only counted once, in whichever form came first.
        const plain: string[] = [];
        const batched: string[] = [];
        const seen = new Set<string>();
        for (const row of await readDiagMessages(sql, result.id)) {
            const text = String(row.message ?? "").trim();
            const detail = text.replace(BATCH_ROW_PREFIX, "").trim();
            if (!detail || seen.has(detail)) continue;
            // A progress line ("Loading …") is filed under sqlcode 0 and carries no
            // bracketed code; a REASON carries one or the other, and which of the two
            // IRIS uses depends on the failure — so either one is enough to keep it.
            if (!Number(row.sqlcode ?? 0) && !SQLCODE_IN_MESSAGE.test(detail)) continue;
            seen.add(detail);
            (BATCH_ROW_PREFIX.test(text) ? batched : plain).push(detail);
        }

        // No reason found is no line at all. Reporting the count on its own ("rejected
        // 104 row(s), without saying why") only restated what the caller's first line
        // already said, in a form that read like a second, separate finding.
        const distinct = plain.length ? plain : batched;
        if (!distinct.length) return "";

        // "at least", because this is the error count of the load's NEWEST diag result
        // only, and a batch IRIS throws out can cost more rows than it logs errors for.
        // Stated flatly it invites "then where are the other 1,341 rows?" — which is the
        // one question the number cannot answer. An absent count is simply left out.
        const errors = Number(result.errors ?? 0);
        const reason = distinct.slice(0, 2).join(" / ");
        return errors ? `SCO rejected at least ${errors} row(s): ${reason}` : reason;
    } catch {
        return "";
    }
}

/** The `Batch row: 7 ` prefix IRIS puts on a batched load's per-row diagnostics. */
const BATCH_ROW_PREFIX = /^batch row:\s*\d+\s*/i;

/** A code inside the message TEXT, which is where a batch-row line carries it. */
const SQLCODE_IN_MESSAGE = /\[SQLCODE:/i;

/**
 * One diag result's messages, in the order IRIS logged them, each with the sqlcode it
 * was filed under.
 *
 * `sqlcode` is selected in a first attempt and dropped in a second: the field is what
 * separates a rejection from a progress line, but an instance that will not project it
 * must cost us that one field rather than the whole diagnosis.
 */
async function readDiagMessages(
    sql: SqlQuerier,
    diagResult: number | string | undefined,
): Promise<Array<{ message?: string; sqlcode?: number | string }>> {
    const from = "FROM %SQL_Diag.Message WHERE diagResult = ? ORDER BY %ID";
    try {
        return await sql.query(`SELECT TOP ${DIAG_MESSAGE_LIMIT} message AS message, sqlcode AS sqlcode ${from}`, [
            diagResult,
        ]);
    } catch {
        return await sql.query(`SELECT TOP ${DIAG_MESSAGE_LIMIT} message AS message ${from}`, [diagResult]);
    }
}

/**
 * Messages read from one diag result. Generous because they are DE-DUPLICATED before
 * anything is shown and a rejected row costs ~2 of them: a file that fails for two
 * reasons can bury the second one under a hundred repetitions of the first.
 */
const DIAG_MESSAGE_LIMIT = 200;

/**
 * Does the table hold ANY row? Asked with `TOP 1` rather than `COUNT(*)` because the
 * answer is wanted for a parent table that may be the biggest one in the namespace, and
 * "is it empty" is the cheap question. An empty parent is the whole reason this check
 * exists: it makes every non-blank reference in the file an orphan, at once, for free.
 */
async function hasAnyRow(sql: SqlQuerier, table: string, column: string): Promise<boolean> {
    const rows = await sql.query(
        `SELECT TOP 1 ${quoteIdent(column)} AS value FROM ${SC_DATA_SCHEMA}.${quoteIdent(table)}`,
    );
    return rows.length > 0;
}

/** Current row count of an SC_Data table. */
async function countRows(sql: SqlQuerier, table: string): Promise<number> {
    const rows = await sql.query<{ n?: number | string }>(
        `SELECT COUNT(*) AS n FROM ${SC_DATA_SCHEMA}.${quoteIdent(table)}`,
    );
    return Number(rows[0]?.n ?? 0);
}

/**
 * Where to stage this table's CSV inside IRIS. The path is interpolated into the
 * `LOAD DATA` string literal, so a quote anywhere in it is refused rather than
 * escaped — `stageDir` is operator-configured (`SCO_UPLOAD_CSV_DIR`) and a table
 * name comes from INFORMATION_SCHEMA, so neither should ever contain one.
 */
function stagedPath(stageDir: string, table: string): string {
    const path = posixPath.join(stageDir, STAGE_SUBDIR, `${table}.csv`);
    if (/['\r\n]/.test(path)) {
        throw new Error(`Cannot stage the CSV: "${path}" is not a usable path inside SCO.`);
    }
    return path;
}

/** Delimited SQL identifier, so case and any awkward character survive. */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}
