/**
 * Fixture writer for the real PostgreSQL server.
 *
 * Unlike the file-family sources there is nothing to "drop in a directory": the
 * fixture IS a table. Each run creates its own `sales_<RUN_KEY>` in the `public`
 * schema and drops it at teardown, so concurrent MR pipelines share one database
 * without sharing rows — the same isolation the S3 prefix and the SFTP/FTP run
 * subdirectory give.
 *
 * Seeding uses `pg` (a backend devDependency) rather than the product's own JDBC
 * seam, for two reasons: the seam is read-only (the Workbench never writes to a
 * customer's database), and it spawns a JVM per call, which is far too slow for a
 * fixture. Using a different client also means a defect in the JDBC path cannot
 * hide behind a fixture that shares it.
 *
 * The account needs CREATE on the schema, which on PostgreSQL 15 and later is NOT
 * granted to ordinary users by default — either make the test user the database
 * owner or `GRANT CREATE ON SCHEMA public TO <user>`.
 */
import { Client } from 'pg';
import type { PgConfig } from './sources.js';

/** One row of the source table, in the shape the CSV-based suites also use. */
export interface SalesRow {
  id: string;
  name: string;
  region: string;
  amount: number;
  /**
   * A `text` column, which `EnsLib.SQL` CANNOT read — see the ingestible-vs-text
   * split in {@link makePgSeeder}. Seeded, never in the polled query.
   */
  notes: string;
}

export interface PgSeeder {
  /** Bare table name, e.g. `sales_local1234`. */
  readonly table: string;
  /** Schema-qualified name, as the polled query and introspection use it. */
  readonly qualified: string;
  /** Create the run's table. Dropped first, so a leaked table cannot poison a run. */
  createTable(): Promise<void>;
  /** Insert rows. */
  insert(rows: SalesRow[]): Promise<void>;
  /** Change one row's amount, to test what the adapter does with an UPDATE. */
  setAmount(id: string, amount: number): Promise<void>;
  /** Every row, ordered by id — used to prove the source is left untouched. */
  readAll(): Promise<SalesRow[]>;
  /** Drop the table. Returns false if it was already gone. */
  dropTable(): Promise<boolean>;
}

const CONNECT_TIMEOUT_MS = 15_000;
/** Schema of the fixture table. Fixed, so the polled query can be a literal. */
export const PG_SCHEMA = 'public';

/**
 * The columns the deployed pipeline polls, in query order. Excludes `notes`.
 */
export const INGESTIBLE_COLUMNS = ['id', 'name', 'region', 'amount'] as const;

/** The `text` column, kept out of the polled query. See the note in createTable. */
export const TEXT_COLUMN = 'notes';

export const makePgSeeder = (config: PgConfig, runKey: string): PgSeeder => {
  // RUN_KEY is `<pipelineId>` or `local<pid>` — digits and lowercase letters only,
  // so it needs no quoting and the table name stays a valid bare identifier.
  const table = `sales_${runKey.replace(/[^A-Za-z0-9]/g, '')}`.toLowerCase();
  const qualified = `${PG_SCHEMA}.${table}`;
  const columns = [...INGESTIBLE_COLUMNS, TEXT_COLUMN].join(', ');

  /** Connect, run `work`, always end the connection. */
  const run = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  return {
    table,
    qualified,
    createTable: () =>
      run(async (client) => {
        // Unquoted identifiers, so PostgreSQL folds them to lower case and the
        // result set's column names are `id`/`name`/`region`/`amount`. The message
        // class's properties are named to match, because the SQL GenericService
        // populates the typed message by pairing result-set columns with
        // properties of the same name.
        //
        // The string columns are `varchar(n)` and NOT `text`, even though `text` is
        // the idiomatic PostgreSQL string type, because `EnsLib.SQL` cannot read a
        // `text` column at all — the driver reports its precision as 2147483647, and
        // `EnsLib.SQL.GatewayResultSet.%isLOB` classifies any declarable-size column
        // wider than MaxVarCharLengthAsString as a LOB (which IRIS caps at
        // $$$MaxStringLength, so no setting avoids it). The fetch then calls
        // getClob(), which the PostgreSQL driver only implements for OID large
        // objects. `notes` exists to hold that case: it is seeded but excluded from
        // the polled query, and postgres.live.test.ts points a query at it to
        // document the failure.
        await client.query(`DROP TABLE IF EXISTS ${qualified}`);
        await client.query(
          `CREATE TABLE ${qualified} (
             id varchar(64) PRIMARY KEY,
             name varchar(255) NOT NULL,
             region varchar(64) NOT NULL,
             amount integer NOT NULL,
             ${TEXT_COLUMN} text NOT NULL
           )`,
        );
      }),
    insert: (rows) =>
      run(async (client) => {
        for (const r of rows) {
          await client.query(`INSERT INTO ${qualified} (${columns}) VALUES ($1, $2, $3, $4, $5)`, [
            r.id,
            r.name,
            r.region,
            r.amount,
            r.notes,
          ]);
        }
      }),
    setAmount: (id, amount) =>
      run(async (client) => {
        await client.query(`UPDATE ${qualified} SET amount = $1 WHERE id = $2`, [amount, id]);
      }),
    readAll: () =>
      run(async (client) => {
        const res = await client.query<SalesRow>(`SELECT ${columns} FROM ${qualified} ORDER BY id`);
        return res.rows;
      }),
    dropTable: () =>
      run(async (client) => {
        const before = await client.query<{ oid: string | null }>(`SELECT to_regclass($1) AS oid`, [qualified]);
        const existed = before.rows[0]?.oid !== null;
        await client.query(`DROP TABLE IF EXISTS ${qualified}`);
        return existed;
      }),
  };
};
