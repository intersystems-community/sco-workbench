/**
 * Sample data sets — the listing behind the "Load sample data" page's dropdown, and the
 * load that puts one set's CSVs into the user's IRIS.
 *
 * The CSVs go into the SCO data model's OWN tables: `SC_Data.Location`,
 * `SC_Data.SalesOrder`, … in the configured namespace (`SCO_NAMESPACE`). Those tables
 * are installed with SCO and the load only adds rows to them — it never creates,
 * drops or empties a table, and a row whose `uid` is already there is skipped. So the
 * load is safe to repeat and safe to run on an instance that already has data.
 *
 * Takes the directory to list plus the IRIS ports it needs (SQL for the load, Native
 * for staging the CSV inside IRIS, and the staging directory), so its tests need only
 * a temp folder and fakes.
 *
 * NOTE for anyone adding a route here: `/api/sample-data` must stay listed in
 * `LOCAL_API_PREFIXES` in `iris-proxy.ts`. The catch-all IRIS proxy mounts before
 * the local routers, so an unlisted local path is silently forwarded to IRIS and
 * 404s.
 */
import { Router } from 'express';
import {
  isSampleDataSetName,
  listSampleDataCsvFiles,
  listSampleDataFolders,
  readSampleDataCsv,
  readSampleDataIntro,
  sampleDataSetPath,
} from '../util/sample-data.js';
import {
  SC_DATA_SCHEMA,
  orderSampleCsvFiles,
  resolveScDataTable,
} from '../util/sc-data-mapping.js';
import {
  describeScDataDependencies,
  listScDataTables,
  loadScDataCsv,
  type ScDataLoadDeps,
} from '../iris/sc-data-load-ops.js';
import { toIrisError } from '../iris/normalize-error.js';
import {
  IrisAuthError,
  IrisTimeoutError,
  IrisUnreachableError,
  NotFoundError,
  ValidationError,
} from '../iris/iris-error.js';

/**
 * One CSV's outcome. A three-way union so the page can tell "loaded", "nothing to do
 * here" and "this file failed" apart — none of them can be misread as another.
 */
type SampleTableResult =
  | {
      file: string;
      table: string;
      ok: true;
      skipped?: false;
      /** Target columns loaded (a column the file has no header for is not loaded). */
      columns: number;
      /** Rows added, counted in IRIS after the load. */
      rows: number;
      /** Rows the file held that were not added, because their `uid` was already there. */
      skippedRows: number;
      /** Rows left out because something they reference is not in this namespace. */
      orphanRows: number;
      /** Which references were missing, when `orphanRows` is non-zero. */
      orphanReason?: string;
      /**
       * Columns the file has that the table does not, so their values did not load.
       * Present only when there are any — a successful load must not be made to look
       * incomplete, but a header that landed nowhere has to be visible.
       */
      ignoredHeaders?: string[];
    }
  | { file: string; table: string; ok: true; skipped: true; reason: string }
  | { file: string; table: string; ok: false; error: string };

/**
 * One CSV in the "what would this set load?" preview. `willLoad` false is the same
 * outcome the load reports as `skipped`: no installed table is named after the file.
 */
interface SamplePreviewTable {
  file: string;
  /** The `SC_Data` table the file's rows would go into, or the file's own name. */
  table: string;
  /** False when no installed table takes this file, so a Load would skip it. */
  willLoad: boolean;
}

interface SamplePreviewResponse {
  folder: string;
  /** SQL schema the rows would go into, so the UI can name it. */
  schema: string;
  /**
   * What the set says about itself — its `intro.txt`, whoever assembled the set having
   * written it. Absent when the set has none, which is not a fault: it is a description,
   * and the table list stands on its own without one.
   */
  intro?: string;
  /** One entry per CSV, in the order a Load would go through them. */
  tables: SamplePreviewTable[];
  /**
   * True when the entries were checked against the tables this namespace actually
   * has. False means IRIS could not be asked, so the names come from the file names
   * alone and a table may not be installed — the page has to say so rather than
   * present a guess as a fact.
   */
  verified: boolean;
  /** Why the set could not be checked, when `verified` is false. */
  reason?: string;
}

interface SampleLoadResponse {
  folder: string;
  /** SQL schema the rows went into, so the UI can name it. */
  schema: string;
  /** One entry per CSV, in the order the files were loaded. */
  tables: SampleTableResult[];
  /** Rows added across every table. */
  totalRows: number;
  /** Rows skipped because their `uid` was already in the table. */
  totalSkippedRows: number;
  /** Rows left out across every table because what they reference is not there. */
  totalOrphanRows: number;
  /**
   * How many CSV columns across the set landed in no table column. Not a failure, but
   * the one number that tells the user a file has moved on from the data model.
   */
  totalIgnoredHeaders: number;
  /**
   * Set when the run stopped before the end of the set — IRIS stopped answering. Says
   * which file it gave up on, so the tables listed above can be read as "what did land"
   * rather than as the whole set.
   */
  aborted?: string;
  /** True only when there was at least one CSV, none of them failed, and none was left. */
  ok: boolean;
}

export function createSampleDataRouter(sampleDataDir: string, iris: ScDataLoadDeps): Router {
  const router = Router();

  /**
   * GET /folders — `{ folders: string[] }`, one entry per sample data set, sorted.
   * No input, so no 400 branch. An ABSENT directory answers `{ folders: [] }`
   * (SampleData/ isn't in git — a fresh clone has none), which the page renders as
   * "no sample data available"; a genuinely unreadable directory throws and gets
   * the shared error envelope's 500.
   */
  router.get('/folders', async (_req, res, next) => {
    try {
      return res.json({ folders: await listSampleDataFolders(sampleDataDir) });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * GET /tables?folder=NAME — what the set says about itself plus which `SC_Data` tables
   * a Load of it would put rows in, WITHOUT loading anything. Answered for the dropdown,
   * so the user reads the set's own description and sees what is about to be written to
   * before pressing a button that writes to their own tables.
   *
   * The description is the set's `intro.txt` (`readSampleDataIntro`), sent as `intro` and
   * omitted when the set has none.
   *
   * Resolved and ordered exactly the way `/load` does it (same table list, same FK
   * graph, same name matching), so the list is the load's own plan rather than a second
   * guess at it — including the files no installed table takes, which come back as
   * `willLoad: false` and are exactly the ones a Load would report as skipped.
   *
   * 400 for a missing `folder`, 404 when it is not one of the listed sets. An IRIS that
   * cannot be reached is NOT an error here: the file names alone still say which tables
   * the set is FOR, so those are answered with `verified: false` and the reason. Failing
   * outright would leave the page unable to say anything about a set it can see.
   */
  router.get('/tables', async (req, res, next) => {
    const requested = (req.query as { folder?: unknown }).folder;
    if (typeof requested !== 'string' || !requested.trim()) {
      return next(new ValidationError('folder must be the name of a sample data set.'));
    }
    const folder = requested.trim();

    try {
      const setDir = await resolveSetDir(sampleDataDir, folder);
      const present = await listSampleDataCsvFiles(setDir);
      // Read from the FILES, so it is answered whether or not IRIS can be asked
      // anything: the set's own description does not depend on the namespace.
      const intro = await readSampleDataIntro(setDir);

      let plan: SetPlan;
      try {
        plan = await planSet(iris, present);
      } catch (err) {
        const body: SamplePreviewResponse = {
          folder,
          schema: SC_DATA_SCHEMA,
          ...(intro ? { intro } : {}),
          tables: present.map((file) => ({ file, table: tableLabel(file), willLoad: true })),
          verified: false,
          reason: message(toIrisError(err, { op: 'sample data preview' })),
        };
        return res.json(body);
      }

      const body: SamplePreviewResponse = {
        folder,
        schema: SC_DATA_SCHEMA,
        ...(intro ? { intro } : {}),
        tables: plan.files.map((file) => {
          const table = plan.tableFor(file);
          return table
            ? { file, table, willLoad: true }
            : { file, table: tableLabel(file), willLoad: false };
        }),
        verified: true,
      };
      return res.json(body);
    } catch (err) {
      return next(toIrisError(err, { op: 'sample data preview' }));
    }
  });

  /**
   * POST /load — `{ folder }` → add every CSV in that data set to its `SC_Data` table.
   *
   * NOT destructive: rows are appended, and a row whose `uid` the table already holds
   * is left out (reported per table as `skippedRows`), so pressing Load twice does not
   * double the data and does not fail.
   *
   * The files are loaded in the SCO data model's own order — Location, Product,
   * Customer before the orders and shipments that reference them — because SC_Data has
   * real FOREIGN KEY constraints. Nothing about the set is known in advance: the
   * installed table list and FK graph are read ONCE up front (two queries), each CSV
   * finds its table by NAME in that list, and the order comes from the constraints this
   * namespace actually has. So a set may carry a file for any installed table, and a CSV
   * matching no table of any name is `{ ok: true, skipped: true, reason }`: reported, not
   * treated as a failure.
   *
   * A header the target table has no column for is likewise reported, per file as
   * `ignoredHeaders` and in total as `totalIgnoredHeaders`, on an otherwise successful
   * load: those values did not go in, and silence there is how a renamed column loses
   * data without anyone noticing.
   *
   * Rows whose foreign key has no parent in this namespace are reported per table as
   * `orphanRows` — separately from `skippedRows`, because a skipped row is already in
   * the table while an orphan row is data that did NOT load (a set missing its
   * `locations.csv` orphans every customer in it).
   *
   * Status codes: 400 when `folder` is missing or not a string; 404 when it is not
   * one of the listed sets (a traversal attempt lands here too, since the name is
   * checked against the listing); 502/504 when IRIS is unreachable, times out or
   * rejects our credentials BEFORE anything loaded. Anything else is PER FILE: a
   * malformed CSV or a SQL error is that file's `{ ok: false, error }` and the remaining
   * files still load, because a partly loaded set the user can see beats an
   * all-or-nothing 500. A connection failure PART WAY through is that same 200 report
   * with `aborted` set — the files that landed are exactly what the user needs to know
   * at that point, and a 504 would throw them away.
   */
  router.post('/load', async (req, res, next) => {
    const requested = (req.body as { folder?: unknown } | undefined)?.folder;
    if (typeof requested !== 'string' || !requested.trim()) {
      return next(new ValidationError('folder must be the name of a sample data set.'));
    }
    const folder = requested.trim();

    try {
      const setDir = await resolveSetDir(sampleDataDir, folder);
      const present = await listSampleDataCsvFiles(setDir);
      const { files, tableFor } = await planSet(iris, present);
      const tables: SampleTableResult[] = [];
      let aborted: string | undefined;
      for (const file of files) {
        const table = tableFor(file);
        if (!table) {
          tables.push({
            file,
            table: tableLabel(file),
            ok: true,
            skipped: true,
            reason: `No ${SC_DATA_SCHEMA} table takes ${file}, so it was skipped.`,
          });
          continue;
        }

        try {
          const result = await loadScDataCsv(iris, {
            file,
            table,
            csv: await readSampleDataCsv(setDir, file),
          });
          tables.push(
            result.loaded
              ? {
                  file,
                  table: result.table,
                  ok: true,
                  columns: result.columns.length,
                  rows: result.rows,
                  skippedRows: result.skippedRows,
                  orphanRows: result.orphanRows,
                  ...(result.orphanReason ? { orphanReason: result.orphanReason } : {}),
                  ...(result.ignoredHeaders.length
                    ? { ignoredHeaders: result.ignoredHeaders }
                    : {}),
                }
              : { file, table: result.table, ok: true, skipped: true, reason: result.reason },
          );
        } catch (err) {
          if (isConnectionFailure(err)) {
            // A dead, unauthenticated or unresponsive IRIS would fail EVERY remaining
            // file the same way, each with its own timeout. Stop.
            //
            // What to ANSWER with then depends on whether anything landed. With nothing
            // loaded, the connection failure is the whole story and belongs in the error
            // envelope (502/504). Once some files are in, throwing would discard the one
            // thing the user now needs — which tables got their rows — so the partial
            // report is returned instead, with `aborted` naming where it stopped. That
            // is the bug behind "request timed out after 30000ms" with no report at all.
            if (!tables.some(isLoadedTable)) throw err;
            tables.push({ file, table, ok: false, error: message(err) });
            aborted = `Stopped at ${file}: ${message(err)}`;
            break;
          }
          tables.push({ file, table, ok: false, error: message(err) });
        }
      }

      const loaded = tables.filter(isLoadedTable);
      const body: SampleLoadResponse = {
        folder,
        schema: SC_DATA_SCHEMA,
        tables,
        totalRows: loaded.reduce((sum, t) => sum + t.rows, 0),
        totalSkippedRows: loaded.reduce((sum, t) => sum + t.skippedRows, 0),
        totalOrphanRows: loaded.reduce((sum, t) => sum + t.orphanRows, 0),
        totalIgnoredHeaders: loaded.reduce((sum, t) => sum + (t.ignoredHeaders?.length ?? 0), 0),
        ...(aborted ? { aborted } : {}),
        // An empty set is NOT a success: nothing was loaded, and the page has to
        // say so rather than show a green "done".
        ok: tables.length > 0 && tables.every((t) => t.ok) && !aborted,
      };
      return res.json(body);
    } catch (err) {
      return next(toIrisError(err, { op: 'sample data load' }));
    }
  });

  return router;
}

/**
 * The directory for one sample data set, checked the way both routes need it.
 *
 * The name must be one the listing actually offers. That is both the "unknown set"
 * answer and the traversal guard: a listed name is always a single real subdirectory,
 * so `../..` can never resolve.
 */
async function resolveSetDir(sampleDataDir: string, folder: string): Promise<string> {
  const folders = await listSampleDataFolders(sampleDataDir);
  const setDir = isSampleDataSetName(folder) ? sampleDataSetPath(sampleDataDir, folder) : null;
  if (!setDir || !folders.includes(folder)) {
    throw new NotFoundError(`Sample data set "${folder}" was not found.`);
  }
  return setDir;
}

/** One set's CSVs, resolved to tables and put in the order they can be loaded in. */
interface SetPlan {
  /** The files, in load order. */
  files: string[];
  /** The table a file goes into, or undefined when no installed table takes it. */
  tableFor: (file: string) => string | undefined;
}

/**
 * Work out what a set would load, from the schema this namespace ACTUALLY has.
 *
 * The installed schema is read once for the whole set: the table names a file can be
 * matched against, and the FK graph the order comes from. Two queries, before any load —
 * so an IRIS that is not answering says so here, plainly, instead of once per file.
 *
 * Shared by `/tables` and `/load` on purpose: a preview that resolved or ordered files
 * differently from the load it describes would be worse than no preview at all.
 */
async function planSet(iris: ScDataLoadDeps, present: readonly string[]): Promise<SetPlan> {
  const installed = await listScDataTables(iris.sql);
  const parents = await describeScDataDependencies(iris.sql);
  // Memoized because the ordering asks for every file's table and then the caller asks
  // again, and resolving is pure string work over the same installed list.
  const resolved = new Map<string, string | undefined>();
  const tableFor = (file: string): string | undefined => {
    if (!resolved.has(file)) resolved.set(file, resolveScDataTable(file, installed));
    return resolved.get(file);
  };
  const files = orderSampleCsvFiles(present, {
    tableOf: tableFor,
    parentsOf: (table) => parents.get(table.toLowerCase()) ?? [],
  });
  return { files, tableFor };
}

/** Narrow to the entries that actually put rows in a table. */
function isLoadedTable(
  t: SampleTableResult,
): t is Extract<SampleTableResult, { ok: true; skipped?: false }> {
  return t.ok && t.skipped !== true;
}

/** Failures that mean "IRIS itself is not answering", so the rest of the set is pointless. */
function isConnectionFailure(err: unknown): boolean {
  return (
    err instanceof IrisUnreachableError ||
    err instanceof IrisTimeoutError ||
    err instanceof IrisAuthError
  );
}

/** The label to report for a file that maps to no table at all. */
function tableLabel(file: string): string {
  return file.replace(/\.csv$/i, '').trim() || file;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
