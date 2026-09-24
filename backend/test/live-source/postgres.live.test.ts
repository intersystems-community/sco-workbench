/**
 * PostgreSQL end to end: the whole Data Integration flow a user actually performs,
 * against a REAL PostgreSQL server and a REAL IRIS.
 *
 *   1. Test Connection over JDBC (and the three mistakes users make)
 *   2. drill schema → table → column, as the wizard's SQL picker does
 *   3. stage the PostgreSQL JDBC driver into the IRIS container
 *   4. Deploy: create the IRIS Credentials entry, compile the generated pipeline,
 *      register its hosts — BP, the shared Java Gateway, the GenericService —
 *      and enable them (service LAST)
 *   5. wait for the adapter to poll, and assert the ROWS AND FIELD VALUES that
 *      landed in the target object
 *   6. change the source: a NEW row is ingested, and an UPDATE to an
 *      already-processed key is NOT (the adapter's documented row-tracking)
 *   7. point the polled query at a `text` column, which IRIS cannot read at all
 *
 * This is the only test anywhere that proves the SQL adapter against a NON-IRIS
 * database, and therefore the only one that proves the three pieces a PostgreSQL
 * deploy needs and an IRIS-to-IRIS deploy does not: the staged driver JAR
 * (`JDBCClasspath`), `JDBCDriver=org.postgresql.Driver`, and a live Java Gateway.
 *
 * It also pins three behaviours of `EnsLib.SQL` that the pipeline depends on and that
 * only a real non-IRIS database can show:
 *   - column→property matching is by EXACT NAME (`GenericService.OnProcessInput`
 *     assigns a column only `If $$$defMemberDefined(..MessageClass,$$$cCLASSproperty,
 *     tColName)`), so the fixture uses UNQUOTED PostgreSQL identifiers — folded to
 *     lower case — and the mappings' `sourceField`s are lower case to match.
 *   - with `KeyFieldName` set and no `DeleteQuery`, a row is processed ONCE ever
 *     (`InboundAdapter.OnTask`: `Continue:..CheckAgainstDone(tOneRow)`), so an
 *     UPDATE is never re-ingested (Q10).
 *   - a PostgreSQL `text` column cannot be ingested at all (Q11) — which is why the
 *     fixture's string columns are `varchar(n)`.
 *
 * The tests are ORDERED and share state: each one is a step of the same flow, so a
 * failure in an early step will fail the rest. That is deliberate — the flow is the
 * unit under test, not the individual calls.
 *
 * Configuration comes from `ci/live-source.env.example` → `.env.live-source` locally,
 * or GitLab CI/CD variables in the job. Absent credentials skip locally and throw in
 * CI (see helpers/sources.ts).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import type { IntegrationDefinition } from '../../src/integration/integration-definition.model.js';
import { generateConfigItems } from '../../src/integration/integration-generator.js';
import { fileExistsInIris } from '../../src/iris/file-ops.js';
import { addOrUpdateConfigItem, enableConfigItem, removeConfigItem } from '../../src/iris/production-ops.js';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import {
  createCustomObject,
  runCleanups,
  type Cleanup,
  type CustomObject,
} from '../integration/helpers/provision.js';
import type { WizardJob } from './helpers/deploy-prompt.js';
import {
  deployViaAgent,
  ensLogHighWater,
  ensLogSince,
  forceStopDeployedHosts,
  registerDeployedItem,
  sqlTableFor,
  waitForRows,
  type AgentDeployedPipeline,
} from './helpers/ingest.js';
import { INGESTIBLE_COLUMNS, makePgSeeder, PG_SCHEMA, TEXT_COLUMN, type SalesRow } from './helpers/pg-seed.js';
import { describeIfConfigured, resolvePg, RUN_KEY } from './helpers/sources.js';

/** The PostgreSQL JDBC driver class, as the frontend's DB_DRIVER_CLASS map has it. */
const PG_DRIVER_CLASS = 'org.postgresql.Driver';
/** The JAR `driver-jar-routes.ts` stages for `dbType: 'PostgreSQL'`. */
const PG_DRIVER_JAR = 'postgresql-42.7.13.jar';

/** The rows the user already has in their table before they open the wizard. */
const SALES_ROWS: SalesRow[] = [
  { id: 'S1', name: 'widget alpha', region: 'North', amount: 100, notes: 'first note' },
  { id: 'S2', name: 'widget beta', region: 'South', amount: 250, notes: 'second note' },
  { id: 'S3', name: 'widget gamma', region: 'East', amount: 375, notes: 'third note' },
];

/** One row of the target object, as SELECT * returns it. */
interface TargetRow extends Record<string, unknown> {
  uid: string;
  name: string;
  region: string;
  amount: number | string;
}

interface MetaResult {
  ok: boolean;
  message?: string;
  schemas?: string[];
  tables?: string[];
  columns?: { name: string; dataType: string; primaryKey: boolean }[];
}

describeIfConfigured('PostgreSQL → IRIS: the whole Data Integration flow', resolvePg, (config) => {
  const seeder = makePgSeeder(config, RUN_KEY);
  /** The JDBC URL for this database — what the user types, and the adapter's DSN. */
  const dsn = `jdbc:postgresql://${config.host}:${config.port}/${config.database}`;
  /** The connection body every JDBC call sends. */
  const jdbcConfig = {
    dsn,
    username: config.user,
    password: config.password,
    driverClass: PG_DRIVER_CLASS,
  };

  let app: BootedApp;
  let cleanups: Cleanup[] = [];
  let target: CustomObject;
  /** In-container path of the staged driver JAR, from the driver-jar route. */
  let driverClasspath = '';
  /** Ens log high-water mark, taken before the pipeline is enabled. */
  let sinceLogId = 0;
  let deployed: AgentDeployedPipeline;
  /** The IRIS Credentials entry the adapter authenticates with. */
  const credName = `WorkbenchTestPg${RUN_KEY}`;

  /**
   * The deploy payload Q11 builds its extra service from, parameterised on the polled
   * columns so it can add the `text` column. Q7 does not use it — that deploy goes
   * through a real agent turn from the wizard's own job state.
   */
  const makeDef = (columns: readonly string[]): IntegrationDefinition => ({
    id: `pg${RUN_KEY}`.replace(/[^A-Za-z0-9]/g, ''),
    name: 'PgSalesFlow',
    adapter: 'SQL',
    service: {
      dsn,
      // An explicit column list that INCLUDES the key column, because the adapter
      // reads KeyFieldName out of the result set (`..%Row.Get(..KeyFieldName)`). No
      // CAST, so the `text` column reaches IRIS as the LOB Q11 is about.
      query: `SELECT ${columns.join(', ')} FROM ${seeder.qualified}`,
      credentials: credName,
      keyField: 'id',
      driverClass: PG_DRIVER_CLASS,
      driverClasspath,
    },
    process: {
      // No header row to skip: a SQL source arrives as a typed message, already
      // column-addressed, so `hasHeader` is irrelevant to this adapter.
      hasHeader: true,
      targetClass: target.className,
      mappings: [
        // Lower case, matching PostgreSQL's folded identifiers exactly — the
        // GenericService assigns a column only to a property of the SAME name.
        { sourceField: 'id', sourceType: 'string', targetProperty: 'uid' },
        { sourceField: 'name', sourceType: 'string', transform: 'ToUpper', targetProperty: 'name' },
        { sourceField: 'region', sourceType: 'string', targetProperty: 'region' },
        { sourceField: 'amount', sourceType: 'integer', targetProperty: 'amount' },
      ],
    },
    keyIndex: 'uidIndex',
    keyRequestProp: 'id',
  });

  beforeAll(async () => {
    app = bootApp();
    cleanups = [];
    await seeder.createTable();
    await seeder.insert(SALES_ROWS);
  });

  afterAll(async () => {
    // The table goes first. Dropping it is the only teardown step whose target
    // outlives the job, and the IRIS steps below can take minutes (see the
    // hookTimeout note in vitest.config.ts) — so it must not be behind them. The
    // adapter is still polling at this point and will log a failed query for a poll
    // or two; that is preferable to leaking a table per merge request.
    const dropped = await seeder.dropTable();
    try {
      // Reverse order: disable the service → remove config items → delete classes →
      // stop the production → delete the credential → drop the target.
      // Stop the deployed hosts FIRST. Over the Native SDK, disabling or removing an
      // ENABLED host cannot stop its job and burns ~85s per operation — see
      // forceStopDeployedHosts for the mechanism. After this the cleanups below have
      // no running job left to stop.
      const stopWarnings = await forceStopDeployedHosts(app.iris);
      if (stopWarnings.length) console.warn(stopWarnings.join('\n'));
      const errors = await runCleanups(cleanups);
      if (errors.length) console.warn(`live-source teardown warnings:\n${errors.join('\n')}`);
      await app.close();
    } finally {
      expect(dropped).toBe(true);
    }
  });

  // ── 1. The user supplies their connection details ─────────────────────────

  it('Q1: Test Connection succeeds and reports the user it connected as', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: jdbcConfig }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok, body.message).toBe(true);
    // The message names the DSN and the user, because "it works" is not actionable
    // when the user is testing several connections in one sitting. It also confirms
    // a query RAN — a driver that loads and connects can still fail on first use.
    expect(body.message).toBe(`Connected to ${dsn} as ${config.user}; test query succeeded.`);
  });

  it('Q2: a wrong password is a failed TEST (200), quoting the server\'s own FATAL text', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...jdbcConfig, password: `${config.password}-wrong` } }),
    });
    // A wrong password is a normal wizard outcome, not an HTTP error.
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // PostgreSQL's own wording is passed through, naming the rejected user.
    expect(body.message).toBe(
      `Connection or authentication failed: FATAL: password authentication failed for user "${config.user}"`,
    );
  });

  it('Q3: a database that does not exist is distinguishable from a credential failure', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { ...jdbcConfig, dsn: `jdbc:postgresql://${config.host}:${config.port}/nosuchdb` },
      }),
    });
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // A typo in the LAST path segment of the DSN is the most common SQL mistake, and
    // it must not read as "your password is wrong" — that sends the user to the DBA.
    expect(body.message).toBe('Connection or authentication failed: FATAL: database "nosuchdb" does not exist');
    expect(body.message).not.toMatch(/password/i);
  });

  it('Q4: a wrong port reads as an unreachable server, NOT as a credential problem', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { ...jdbcConfig, dsn: `jdbc:postgresql://${config.host}:${config.port + 1}/${config.database}` },
      }),
    });
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // Not pinned to one message. pgjdbc says "Connection to <host>:<port> refused."
    // when the port sends RST, but "The connection attempt failed." when a firewall
    // drops the packets instead. The point of the test is the line below: either way it
    // must not read as a credential problem. Q2 proves the DSN's port is used.
    expect(body.message).toMatch(/refused|connection attempt failed|timed out/i);
    expect(body.message).not.toMatch(/password|FATAL/i);
  });

  // ── 2. The user drills schema → table → column ────────────────────────────

  it('Q5: the SQL picker finds the schema, the table, and the columns with the key flagged', async () => {
    const post = async (path: string, extra: Record<string, unknown> = {}) =>
      jsonOf<MetaResult>(
        await fetch(`${app.base}/api/data-integration/introspect/sql/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: jdbcConfig, ...extra }),
        }),
      );

    const schemas = await post('schemas');
    expect(schemas.ok, schemas.message ?? '').toBe(true);
    expect(schemas.schemas).toContain(PG_SCHEMA);

    const tables = await post('tables', { schema: PG_SCHEMA });
    expect(tables.ok, tables.message ?? '').toBe(true);
    expect(tables.tables).toContain(seeder.table);

    const columns = await post('columns', { schema: PG_SCHEMA, table: seeder.table });
    expect(columns.ok, columns.message ?? '').toBe(true);
    // Exact names, in table order: these become the message-class property names, and
    // the GenericService pairs result-set columns to properties by exact name — so a
    // case difference here would silently drop the column at ingestion time.
    expect(columns.columns).toEqual([
      { name: 'id', dataType: 'varchar', primaryKey: true },
      { name: 'name', dataType: 'varchar', primaryKey: false },
      { name: 'region', dataType: 'varchar', primaryKey: false },
      { name: 'amount', dataType: 'int4', primaryKey: false },
      // Reported like any other column, and offered to the user like any other —
      // but see Q11: a `text` column cannot actually be ingested.
      { name: TEXT_COLUMN, dataType: 'text', primaryKey: false },
    ]);

    // Documented live behaviour, NOT an assertion that this is good: metadata for a
    // schema or table that does not exist comes back as a SUCCESSFUL EMPTY list, not
    // an error — JDBC's DatabaseMetaData simply matches nothing. So the picker cannot
    // tell "no such table" from "a table with no columns", exactly as FTP browse
    // cannot tell a missing directory from an empty one.
    expect(await post('tables', { schema: 'nosuchschema' })).toEqual({ ok: true, tables: [] });
    expect(await post('columns', { schema: PG_SCHEMA, table: 'nosuchtable' })).toEqual({ ok: true, columns: [] });

    // A bad credential on a METADATA call fails the same way the connection test
    // does, so the picker never shows an empty database as if it were connected.
    const denied = await jsonOf<MetaResult>(
      await fetch(`${app.base}/api/data-integration/introspect/sql/schemas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { ...jdbcConfig, password: `${config.password}-wrong` } }),
      }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('password authentication failed');
  });

  // ── 3. Stage the driver the deployed pipeline will load ───────────────────

  it('Q6: the PostgreSQL JDBC driver JAR is staged into the IRIS container, byte for byte', async () => {
    // The deployed GenericService runs INSIDE IRIS and loads the driver through the
    // Java Gateway's JVM, so the JAR has to be in the IRIS container — nothing on the
    // backend host is on that classpath. This is the step an IRIS-to-IRIS pipeline
    // never needs, and it is unproven anywhere else.
    const stage = async () =>
      jsonOf<{ ok: boolean; irisPath: string }>(
        await fetch(`${app.base}/api/data-integration/driver-jar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dbType: 'PostgreSQL' }),
        }),
      );

    const first = await stage();
    expect(first.ok).toBe(true);
    expect(first.irisPath).toMatch(new RegExp(`/${PG_DRIVER_JAR}$`));
    driverClasspath = first.irisPath;
    expect(fileExistsInIris(app.iris.native, driverClasspath)).toBe(true);

    // Size, not just existence: a JAR truncated in transit still "exists" and then
    // fails at deploy with a ClassNotFoundException nothing here would explain.
    const localBytes = (await readFile(join(loadEnv().JDBC_LIB_DIR, PG_DRIVER_JAR))).length;
    const sizeInIris = () => {
      try {
        return Number(app.iris.native.callValue('%File', 'GetFileSize', driverClasspath));
      } finally {
        app.iris.native.drainConnectionState();
      }
    };
    expect(sizeInIris()).toBe(localBytes);

    // Idempotent: a second deploy must not re-push. The route's skip is not directly
    // observable, so what is asserted is the contract that matters — the same path
    // comes back and the staged file is still intact.
    const second = await stage();
    expect(second).toEqual(first);
    expect(sizeInIris()).toBe(localBytes);

    // Deliberately NOT cleaned up. The JAR is shared infrastructure (one per IRIS
    // instance, reused by every PostgreSQL pipeline), and the route is idempotent, so
    // removing it would only slow the next run down. The CI IRIS is thrown away.
  });

  // ── 4. Deploy ─────────────────────────────────────────────────────────────

  it('Q7: Deploy registers BP + the shared Java Gateway + the GenericService, and enables the service last', async () => {
    // The target the user maps onto: a real SCO custom object, with the `uid` key
    // index the BPL upserts on.
    target = await createCustomObject(app, [
      { name: 'name', dataType: 'String' },
      { name: 'region', dataType: 'String' },
      { name: 'amount', dataType: 'Integer' },
    ]);
    cleanups.push(target.cleanup);
    expect(target.props).toContain('uid');

    // The adapter references a Credentials ENTRY, never a raw username/password.
    const credRes = await fetch(`${app.base}/api/data-integration/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: credName, username: config.user, password: config.password }),
    });
    expect((await jsonOf<{ ok: boolean }>(credRes)).ok).toBe(true);
    cleanups.push(() => {
      // No delete route exists (the product only ever upserts), so remove the row
      // directly — SystemName is the class's IDKEY.
      try {
        app.iris.native.callValue('Ens.Config.Credentials', '%DeleteId', credName);
      } finally {
        app.iris.native.drainConnectionState();
      }
    });

    // Take the log mark BEFORE anything is enabled, so a later failure dump shows
    // only what this pipeline logged.
    sinceLogId = await ensLogHighWater(app.iris);

    // The wizard's state at the moment Deploy is pressed. deployViaAgent turns this
    // into the same prompt the button sends and runs a real agent turn — the polled
    // query comes from the wizard's own builder, and the key index and request
    // property are NOT given, the agent resolves them.
    const job: WizardJob = {
      id: `pg${RUN_KEY}`.replace(/[^A-Za-z0-9]/g, ''),
      name: 'PgSalesFlow',
      source: {
        type: 'database',
        adapterType: 'SQL',
        dbType: 'PostgreSQL',
        dbDsn: dsn,
        dbCredentialName: credName,
        // The adapter reads KeyFieldName out of the result set
        // (`..%Row.Get(..KeyFieldName)`), so the builder keeps it in the SELECT.
        dbKeyField: 'id',
        dbDriverClasspath: driverClasspath,
      },
      // Step 2's table pick, which the query builder selects FROM.
      dataEntity: { nameLabel: 'Table', name: seeder.table, sourceLabel: 'Schema', source: PG_SCHEMA },
      targetClass: target.objectName,
      // No header row to skip: a SQL source arrives as a typed message, already
      // column-addressed, so `hasHeader` is irrelevant to this adapter.
      hasHeader: true,
      columns: [
        // Lower case, matching PostgreSQL's folded identifiers exactly — the
        // GenericService assigns a column only to a property of the SAME name.
        { name: 'id', type: 'String', targetProperty: 'uid' },
        { name: 'name', type: 'String', transform: 'ToUpper', targetProperty: 'name' },
        { name: 'region', type: 'String', targetProperty: 'region' },
        { name: 'amount', type: 'Integer', targetProperty: 'amount' },
      ],
    };

    deployed = await deployViaAgent(app, job, { [target.objectName]: target.className }, cleanups);
    expect(deployed.status).toMatchObject({ phase: 'deployed', ok: true });
    // SQL is the only adapter with three items and no generated BS class: the
    // GenericService is a stock IRIS class configured by settings.
    expect(deployed.itemNames).toEqual([
      deployed.names.bpConfigName,
      'JavaGateway',
      deployed.names.bsConfigName,
    ]);
    expect(deployed.serviceName).toBe(deployed.names.bsConfigName);
    // An agent turn takes ~60-90s and its latency is not ours to control, so this step
    // gets more than the tier's 180s. deployViaAgent aborts at 240s with its transcript.
  }, 300_000);

  // ── 5. Verify the data actually arrived ───────────────────────────────────

  it('Q8: IRIS polls the query over JDBC and the rows land in the target with the MAPPED values', async () => {
    const rows = await waitForRows<TargetRow>(app.iris, target.className, {
      until: (r) => r.length >= SALES_ROWS.length,
      label: `the ${SALES_ROWS.length} rows of ${seeder.qualified}`,
      sinceLogId,
      orderBy: 'uid',
      // The Java Gateway has to start and the JVM has to load the driver before the
      // first poll can even connect, which no file-family adapter waits for.
      timeoutMs: 180_000,
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.uid)).toEqual(['S1', 'S2', 'S3']);
    // Field values, not just a count: a count-only assertion passes even when the
    // DTL maps every column to the wrong property. ToUpper proves the transform ran.
    expect(rows[0]).toMatchObject({ uid: 'S1', name: 'WIDGET ALPHA', region: 'North' });
    expect(Number(rows[0]!.amount)).toBe(100);
    expect(rows[1]).toMatchObject({ uid: 'S2', name: 'WIDGET BETA', region: 'South' });
    expect(Number(rows[2]!.amount)).toBe(375);
  });

  it('Q9: the source table is left EXACTLY as it was — no rows deleted, no values changed', async () => {
    // The adapter CAN delete source rows: `DeleteQuery` is a setting, and setting it
    // would destroy a customer's data. The generator never emits it, and this is the
    // assertion that proves the deployed pipeline is read-only.
    expect(await seeder.readAll()).toEqual(SALES_ROWS);
  });

  it('Q10: a NEW source row is ingested; an UPDATE to an already-processed row is NOT', async () => {
    // Documented behaviour of `EnsLib.SQL.InboundAdapter`, not a wish: with
    // `KeyFieldName` set and `DeleteQuery` empty, OnTask does
    // `Continue:..CheckAgainstDone(tOneRow)` against a table keyed by the KEY VALUE,
    // so a key it has already processed is skipped forever — no matter what changed
    // in the row. A user who edits a row in their database will NOT see the edit.
    //
    // Both changes are made in one go, and the assertion waits for the NEW row. Its
    // arrival proves a poll happened AFTER the update, which is what makes the
    // unchanged value evidence of the skip rather than of a dead pipeline.
    await seeder.setAmount('S1', 999);
    await seeder.insert([{ id: 'S4', name: 'widget delta', region: 'West', amount: 42, notes: 'fourth note' }]);

    const rows = await waitForRows<TargetRow>(app.iris, target.className, {
      until: (r) => r.length >= 4,
      label: 'the newly inserted row S4',
      sinceLogId,
      orderBy: 'uid',
    });

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.uid)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(rows[3]).toMatchObject({ uid: 'S4', name: 'WIDGET DELTA', region: 'West' });
    expect(Number(rows[3]!.amount)).toBe(42);

    // The source now says 999 and the target still says 100: the row was skipped.
    expect((await seeder.readAll()).find((r) => r.id === 'S1')?.amount).toBe(999);
    expect(Number(rows[0]!.amount)).toBe(100);
  });

  // ── 7. The limitation this suite found ────────────────────────────────────

  it('Q11: a PostgreSQL `text` column cannot be ingested at all — current behaviour, not desired', async () => {
    // `text` is the idiomatic PostgreSQL string type, the wizard's column picker
    // offers it like any other (Q5), and yet a pipeline that selects one never
    // ingests a single row. Verified live against PostgreSQL 16 / IRIS 2025.2:
    //
    //   ERROR #5023: Remote Gateway Error: JDBC Gateway getClob(0,1) error
    //   Remote JDBC error: Bad value for type long :
    //
    // Why: the driver reports a `text` column's precision as 2147483647, and
    // `EnsLib.SQL.GatewayResultSet.%isLOB` treats a declarable-size column wider than
    // `MaxVarCharLengthAsString` as a LOB. No setting avoids it — %isLOB caps that
    // value at $$$MaxStringLength first ("If ((pMaxVarCharLengthAsString = -1) ||
    // (pMaxVarCharLengthAsString > $$$MaxStringLength)) { Set pMaxVarCharLengthAsString
    // = $$$MaxStringLength }"), which is far below 2147483647. The column is then
    // fetched with getClob(), which the PostgreSQL driver implements only for OID
    // large objects, so it tries to read the text as an OID and fails.
    //
    // The only workaround from our side is a narrower source type (`varchar(n)`),
    // which is why the fixture uses one. This test exists so the limitation is
    // recorded and so we find out if a future IRIS release changes it: it will fail
    // the day `text` starts working, which is the day to widen the fixture. Filed as
    // SC-2717.
    const mark = await ensLogHighWater(app.iris);

    // A SECOND service, identical to the deployed one except that its query also
    // selects the `text` column — so the failure is attributable to that one column.
    // It reuses the deployed BP and message class (both are in the generated
    // settings), so nothing needs recompiling.
    //
    // Deliberately a NEW config item rather than a re-pointed one. Changing a RUNNING
    // inbound service's settings makes Ens.Director stop its job, and over the Native
    // SDK that stop never succeeds — it costs 10+15+25+35s and ends in
    // "<Ens>ErrJobNotStopped: Job 'N' failed to stop within 35 seconds" with the job
    // still running (see forceStopDeployedHosts in helpers/ingest.ts). Adding an item
    // stops nothing, so it is unaffected.
    const items = generateConfigItems(makeDef([...INGESTIBLE_COLUMNS, TEXT_COLUMN]));
    const service = items[items.length - 1]!;
    const textServiceName = `${service.name}Text`;
    // Every production operation runs on a FRESH connection, like the product's own
    // tools: `Ens.Config.Production.%OpenId` is cached per IRIS process, so the shared
    // connection cannot see the items the deploy turn added and Ens.Director throws
    // <INVALID OREF> on them (see productionItems in helpers/ingest.ts).
    cleanups.push(async () => {
      await app.iris.native.withFreshConnection((c) => {
        enableConfigItem(c, textServiceName, false);
      });
      await app.iris.native.withFreshConnection((c) =>
        removeConfigItem(c, app.iris.atelier, deployed.productionName, textServiceName),
      );
    });
    const added = await app.iris.native.withFreshConnection((c) =>
      addOrUpdateConfigItem(c, app.iris.atelier, {
        productionName: deployed.productionName,
        className: service.className,
        name: textServiceName,
        poolSize: service.poolSize,
        enabled: false,
        settings: service.settings,
      }),
    );
    expect(added.ok, added.message).toBe(true);
    registerDeployedItem(textServiceName); // so teardown's force-stop covers it too
    const started = await app.iris.native.withFreshConnection((c) => enableConfigItem(c, textServiceName, true));
    expect(started.ok, started.message).toBe(true);

    const deadline = Date.now() + 120_000;
    let log = '';
    for (;;) {
      log = await ensLogSince(app.iris, mark);
      if (/getClob/.test(log)) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `Expected the second service's query to fail on the "${TEXT_COLUMN}" text column, but no ` +
            `getClob error was logged in 120s. If IRIS now reads PostgreSQL text columns, ` +
            `delete this test and widen the fixture in pg-seed.ts.\nEns.Util.Log since #${mark}:\n${log}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    expect(log).toMatch(/ERROR #5023: Remote Gateway Error: JDBC Gateway getClob/);
    expect(log).toMatch(/Bad value for type long/);

    // And the failure is total: the result set never yields a row, so nothing new
    // reaches the target even though every other column in the query is ingestible.
    const rows = await app.iris.atelier.query<TargetRow>(`SELECT * FROM ${sqlTableFor(target.className)}`);
    expect(rows).toHaveLength(4);
  });
});
