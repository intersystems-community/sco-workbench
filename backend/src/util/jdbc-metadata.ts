import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * JDBC metadata introspection for the Data Integration "database" (JDBC) source,
 * used by the Data Entity step to drill schema → table → column.
 *
 * REAL JDBC, database-agnostic: a tiny Java helper (compiled from
 * jdbc-helper/JdbcMetadata.java) loads the requested JDBC driver from the JARs in
 * JDBC_LIB_DIR, opens a genuine `DriverManager.getConnection(dsn, user, pwd)`, and
 * reads from the standard `DatabaseMetaData` API (no vendor-specific SQL). Node
 * spawns that helper per request (a manual step; JVM startup cost is irrelevant),
 * writes the config to its stdin (so the password never appears in argv/process
 * list) and reads the JSON back. The requested operation is selected by a single
 * CLI "action" argument (schemas | tables | columns).
 *
 * This mirrors jdbc-test.ts on purpose (same spawn seam, classpath, timeout and
 * java-missing handling); the three exported functions share one spawn core.
 */

/** A source table column: its name, JDBC data-type name, and whether it's part
 *  of the table's row-tracking key (declared PRIMARY KEY, or a single-column
 *  UNIQUE index when there's no PK). Drives the SQL pipeline's `KeyFieldName`. */
export interface JdbcColumn {
  name: string;
  dataType: string;
  /** True if this column is the table's primary/unique key (row-tracking key). */
  primaryKey: boolean;
}

/** The connection config every introspection call needs — same shape as the test. */
export interface JdbcConnectionConfig {
  /** JDBC URL, e.g. `jdbc:IRIS://host:1972/SC` or `jdbc:postgresql://host:5432/db`. */
  dsn: string;
  username: string;
  password: string;
  /** Fully-qualified JDBC driver class, e.g. `com.intersystems.jdbc.IRISDriver`. */
  driverClass: string;
}

/** Outcome of a metadata fetch — a `payload` key present only when `ok`. A failed
 *  fetch (bad host/credentials) is a normal result the UI renders, not a reject. */
export type MetadataResult<TKey extends string, TValue> =
  | ({ ok: true } & Record<TKey, TValue>)
  | { ok: false; message: string };

export type SchemasResult = MetadataResult<'schemas', string[]>;
export type TablesResult = MetadataResult<'tables', string[]>;
export type ColumnsResult = MetadataResult<'columns', JdbcColumn[]>;

/** How long to wait for the helper before killing it. */
const FETCH_TIMEOUT_MS = 12_000;

/** The compiled helper's class name and (relative) location under the backend. */
const HELPER_CLASS = 'JdbcMetadata';
// From dist/util/jdbc-metadata.js (Docker) or src/util/jdbc-metadata.ts (dev), the
// compiled helper lives at backend/jdbc-helper — two levels up (both dist/ and
// src/ sit directly under backend/).
const HELPER_DIR_FROM_DIST = '../../jdbc-helper';

/**
 * Spawner seam so unit tests can inject a fake process instead of launching a
 * real JVM. Mirrors the subset of child_process.spawn we use.
 */
export type Spawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

const defaultSpawner: Spawner = (command, args) => spawn(command, args);

/** Resolve the java binary + classpath (JAR dir + compiled helper dir) from env.
 *  Reads its two vars directly from process.env (with the same defaults as the
 *  schema) so this doesn't pull in full env validation. */
function resolveJavaInvocation(): { javaBin: string; classpath: string } {
  const javaBin = process.env.JAVA_BIN || 'java';
  const jdbcLibDir = process.env.JDBC_LIB_DIR || '/app/backend/jdbc-lib';
  const helperDir = new URL(HELPER_DIR_FROM_DIST, import.meta.url).pathname;
  // Classpath: every JAR in the lib dir, plus the helper's own dir. The `*`
  // glob is expanded by the JVM itself (must be passed as a single entry).
  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = [`${jdbcLibDir}/*`, helperDir].join(sep);
  return { javaBin, classpath };
}

/**
 * Shared spawn core: run the helper for `action`, feed `payload` (config + any
 * schema/table) on stdin, and hand the parsed helper JSON to `shape` — which
 * validates the success payload and returns the caller's result shape. Failure
 * (`ok:false`), java-missing, timeout and unparseable output are handled here.
 */
function runMetadata<T extends { ok: boolean }>(
  action: string,
  payload: Record<string, string>,
  shape: (parsed: unknown) => T | null,
  onFail: (message: string) => T,
  spawner: Spawner,
): Promise<T> {
  const { javaBin, classpath } = resolveJavaInvocation();

  return new Promise<T>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawner(javaBin, ['-cp', classpath, HELPER_CLASS, action]);
    } catch {
      resolve(onFail(JAVA_UNAVAILABLE_MSG));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish(onFail(`Metadata fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s.`)),
      FETCH_TIMEOUT_MS,
    );

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // `java` missing entirely surfaces as an ENOENT spawn error.
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? onFail(JAVA_UNAVAILABLE_MSG) : onFail(`Metadata fetch failed: ${err.message}`));
    });

    child.on('close', () => {
      // The helper prints a single JSON object on stdout for both success and
      // handled errors. Anything unparseable is an environment/setup problem.
      try {
        const parsed = JSON.parse(stdout.trim()) as { ok?: unknown; message?: unknown };
        const shaped = shape(parsed);
        if (shaped) {
          finish(shaped);
          return;
        }
        if (parsed?.ok === false && typeof parsed.message === 'string') {
          finish(onFail(parsed.message));
          return;
        }
      } catch {
        // fall through to the diagnostic below
      }
      const detail = stderr.trim() || stdout.trim() || 'no output from the JDBC helper';
      finish(onFail(`Metadata fetch could not run: ${detail}`));
    });

    // Feed the config (+ schema/table) as JSON on stdin (keeps password out of argv).
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      // If the process already died, `close`/`error` handles the result.
    }
  });
}

/** Base config JSON fields every action sends. */
function basePayload(config: JdbcConnectionConfig): Record<string, string> {
  return {
    dsn: config.dsn?.trim() ?? '',
    username: config.username ?? '',
    password: config.password ?? '',
    driverClass: config.driverClass?.trim() ?? '',
  };
}

/** Validate the shared connection fields; returns an error message or null. */
function validateConfig(config: JdbcConnectionConfig): string | null {
  if (!config.dsn?.trim()) return 'a JDBC URL (DSN) is required.';
  if (!config.driverClass?.trim()) return 'a database type (driver) is required.';
  return null;
}

/** List the connected database's schemas. */
export function fetchJdbcSchemas(
  config: JdbcConnectionConfig,
  spawner: Spawner = defaultSpawner,
): Promise<SchemasResult> {
  const err = validateConfig(config);
  if (err) return Promise.resolve({ ok: false, message: `Schema fetch failed: ${err}` });
  return runMetadata<SchemasResult>(
    'schemas',
    basePayload(config),
    (p) => {
      const parsed = p as { ok?: unknown; schemas?: unknown };
      return parsed?.ok === true && Array.isArray(parsed.schemas)
        ? { ok: true, schemas: parsed.schemas as string[] }
        : null;
    },
    (message) => ({ ok: false, message }),
    spawner,
  );
}

/** List the tables/views in a schema. */
export function fetchJdbcTables(
  config: JdbcConnectionConfig,
  schema: string,
  spawner: Spawner = defaultSpawner,
): Promise<TablesResult> {
  const err = validateConfig(config);
  if (err) return Promise.resolve({ ok: false, message: `Table fetch failed: ${err}` });
  if (!schema?.trim()) return Promise.resolve({ ok: false, message: 'Table fetch failed: a schema is required.' });
  return runMetadata<TablesResult>(
    'tables',
    { ...basePayload(config), schema: schema.trim() },
    (p) => {
      const parsed = p as { ok?: unknown; tables?: unknown };
      return parsed?.ok === true && Array.isArray(parsed.tables)
        ? { ok: true, tables: parsed.tables as string[] }
        : null;
    },
    (message) => ({ ok: false, message }),
    spawner,
  );
}

/** List a table's columns (name + JDBC data-type name). */
export function fetchJdbcColumns(
  config: JdbcConnectionConfig,
  schema: string,
  table: string,
  spawner: Spawner = defaultSpawner,
): Promise<ColumnsResult> {
  const err = validateConfig(config);
  if (err) return Promise.resolve({ ok: false, message: `Column fetch failed: ${err}` });
  if (!schema?.trim()) return Promise.resolve({ ok: false, message: 'Column fetch failed: a schema is required.' });
  if (!table?.trim()) return Promise.resolve({ ok: false, message: 'Column fetch failed: a table is required.' });
  return runMetadata<ColumnsResult>(
    'columns',
    { ...basePayload(config), schema: schema.trim(), table: table.trim() },
    (p) => {
      const parsed = p as { ok?: unknown; columns?: unknown };
      if (parsed?.ok !== true || !Array.isArray(parsed.columns)) return null;
      // Normalize: coerce each row to { name, dataType, primaryKey:boolean }. The
      // primaryKey flag is defaulted to false if an older helper build omits it.
      const columns: JdbcColumn[] = (parsed.columns as Array<Record<string, unknown>>).map((c) => ({
        name: typeof c.name === 'string' ? c.name : '',
        dataType: typeof c.dataType === 'string' ? c.dataType : '',
        primaryKey: c.primaryKey === true,
      }));
      return { ok: true, columns };
    },
    (message) => ({ ok: false, message }),
    spawner,
  );
}

/** The friendly message when no JVM is available (e.g. dev machine without Java). */
const JAVA_UNAVAILABLE_MSG =
  'Java runtime not available for the metadata fetch — install a JRE or run via Docker.';
