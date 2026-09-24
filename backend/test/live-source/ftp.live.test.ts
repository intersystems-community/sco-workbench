/**
 * FTP end to end: the whole Data Integration flow a user actually performs, against
 * a REAL FTP server and a REAL IRIS.
 *
 *   1. Test Connection (and the two mistakes users make)
 *   2. prove PASSIVE mode is configured the way both clients need it
 *   3. drop a CSV on the server, then browse + preview it as the wizard does
 *   4. Deploy: create the IRIS Credentials entry, compile the generated pipeline,
 *      register its hosts, enable them (service LAST)
 *   5. wait for the adapter to poll, and assert the ROWS AND FIELD VALUES that
 *      landed in the target object
 *   6. drop a second file: the new row is inserted and the changed row is upserted
 *
 * FTP is the adapter with the largest coverage gap: 20 unit cases, all against an
 * injected fake (`ftp-test.ts` exports an `FtpClientFactory` precisely so the unit
 * tests need no server), and zero live cases before this suite. Two different clients
 * are proven here — `basic-ftp` in Node for the wizard, and IRIS's own
 * `EnsLib.FTP.InboundAdapter` for the deployed pipeline.
 *
 * This suite is what found the adapter's MLSD trap: the generator used to set
 * `MLSD=1`, which fails OnInit outright on a server with no MLST feature (vsftpd)
 * and silently reinterprets FileSpec as a regex, making `*.csv` invalid. Only a live
 * FTP server can catch that — the unit fake accepts any settings.
 *
 * The tests are ORDERED and share state: each one is a step of the same flow, so a
 * failure in an early step will fail the rest. That is deliberate — the flow is the
 * unit under test, not the individual calls.
 *
 * Configuration comes from `ci/live-source.env.example` → `.env.live-source` locally,
 * or GitLab CI/CD variables in the job. Absent credentials skip locally and throw in
 * CI (see helpers/sources.ts).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import {
  createCustomObject,
  runCleanups,
  type Cleanup,
  type CustomObject,
} from '../integration/helpers/provision.js';
import type { WizardJob } from './helpers/deploy-prompt.js';
import { deployViaAgent, ensLogHighWater, forceStopDeployedHosts, waitForRows } from './helpers/ingest.js';
import { makeFtpSeeder } from './helpers/ftp-seed.js';
import { describeIfConfigured, resolveFtp, RUN_KEY } from './helpers/sources.js';

/**
 * The file the user drops on their server. Plain commas only: the generated BPL
 * splits on `$Piece(tLine, ",")`, so a quoted comma is NOT an ingestible fixture
 * (the preview parser handles it, the pipeline does not — see the preview step).
 */
const SALES_CSV = [
  'ID,Name,Region,Amount',
  'S1,widget alpha,North,100',
  'S2,widget beta,South,250',
  'S3,widget gamma,East,375',
].join('\n');

/** A second drop: S1 changed (upsert) and S4 new (insert). */
const SALES_UPDATE_CSV = ['ID,Name,Region,Amount', 'S1,widget alpha,North,999', 'S4,widget delta,West,42'].join(
  '\n',
);

/** One row of the target object, as SELECT * returns it. */
interface TargetRow extends Record<string, unknown> {
  uid: string;
  name: string;
  region: string;
  amount: number | string;
}

describeIfConfigured('FTP → IRIS: the whole Data Integration flow', resolveFtp, (config) => {
  const seeder = makeFtpSeeder(config);
  /** This run's own subdirectory of the shared drop directory (see ftp-seed.ts). */
  const runDir = `${config.dir.replace(/\/+$/, '')}/${RUN_KEY}`;
  const salesPath = `${runDir}/sales.csv`;
  const updatePath = `${runDir}/sales-update.csv`;
  const notesPath = `${runDir}/notes.txt`;
  /** Port as the HTTP routes take it (they read config.port as a string). */
  const port = String(config.port);
  /** The connection body every browse/test call sends. */
  const connConfig = { host: config.host, port, username: config.user, password: config.password };

  let app: BootedApp;
  let cleanups: Cleanup[] = [];
  let target: CustomObject;
  /** Ens log high-water mark, taken before the pipeline is enabled. */
  let sinceLogId = 0;

  beforeAll(async () => {
    app = bootApp();
    cleanups = [];
    // The user's data, already on their server before they open the wizard. The
    // .txt is here so the deployed adapter's FileSpec is provably filtering rather
    // than handing every file it finds to the CSV parser.
    await seeder.mkdir(runDir);
    await seeder.put(salesPath, SALES_CSV);
    await seeder.put(notesPath, 'not a csv\n');
  });

  afterAll(async () => {
    // The remote directory goes first. Removing it is the only teardown step whose
    // target outlives the job, and the IRIS steps below can take minutes (see the
    // hookTimeout note in vitest.config.ts) — so it must not be behind them. The
    // adapter is still polling at this point and will log a listing failure for a
    // poll or two; that is preferable to leaking a directory per merge request.
    const removed = await seeder.removeDir(runDir);
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
      expect(removed).toBeGreaterThanOrEqual(3);
      expect(await seeder.listAll(runDir)).toEqual([]);
    }
  });

  // ── 1. The user supplies their credentials ────────────────────────────────

  it('P1: Test Connection succeeds and reports the working directory it landed in', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/ftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: connConfig }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok, body.message).toBe(true);
    expect(body.message).toContain(`FTP connection to ${config.host} as ${config.user} succeeded`);
    // The cwd is in the message because a chrooted account lands somewhere the user
    // did not type, and that is what their paths will be relative to.
    expect(body.message).toMatch(/working directory: \//);
  });

  it('P2: a wrong password is a failed TEST (200), quoting the server\'s own 530 reply', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/ftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...connConfig, password: `${config.password}-wrong` } }),
    });
    // A wrong password is a normal wizard outcome, not an HTTP error.
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // The server's reply code is passed through verbatim — 530 is the one FTP code a
    // user can act on ("your login was rejected"), so it must not be swallowed.
    expect(body.message).toMatch(/^Connection or authentication failed: 530 /);
  });

  it('P3: a wrong port reads as an unreachable host, NOT as a credential problem', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/ftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...connConfig, port: String(config.port + 1) } }),
    });
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/Connection or authentication failed: /);
    expect(body.message).not.toMatch(/530|password/i);
  });

  // ── 2. Passive mode — the FTP-specific failure ────────────────────────────

  it('P4: the server advertises a passive port inside the declared range, at a reachable address', async () => {
    // Both clients default to PASV, so the 227 reply decides whether any transfer can
    // happen. A server whose pasv_address is its PRIVATE ip, or whose pasv range is
    // not open in the security group, still logs in fine and then hangs on LIST —
    // this turns that into a named mismatch before any transfer is attempted.
    const pasv = await seeder.pasvTarget();
    expect(
      pasv.port,
      `the server advertised passive port ${pasv.port}, outside the declared `
        + `LIVE_SOURCE_FTP_PASV_MIN..MAX range ${config.pasvMin}..${config.pasvMax}. `
        + `vsftpd.conf, the security group and the CI variables must agree.`,
    ).toBeGreaterThanOrEqual(config.pasvMin);
    expect(pasv.port).toBeLessThanOrEqual(config.pasvMax);
    // pasv_address must be an address the CLIENT can reach — on EC2 the public one.
    // The control host is reachable by definition (P1 passed), so requiring a match
    // is the check that catches a private-ip pasv_address.
    expect(
      pasv.host,
      `the server advertised passive address ${pasv.host} but the control connection `
        + `is to ${config.host}; set vsftpd's pasv_address to the address clients use.`,
    ).toBe(config.host);
  });

  // ── 3. The user browses the server and picks the file ─────────────────────

  it('P5: browsing the run directory shows the seeded files, and preview returns the real rows', async () => {
    const listRes = await fetch(`${app.base}/api/data-integration/introspect/ftp/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: connConfig, path: runDir }),
    });
    const listed = await jsonOf<{ ok: boolean; message?: string; entries: { name: string; type: string }[] }>(
      listRes,
    );
    expect(listed.ok, listed.message ?? '').toBe(true);
    const byName = new Map(listed.entries.map((e) => [e.name, e.type]));
    expect(byName.get('sales.csv')).toBe('csv');
    expect(byName.get('notes.txt')).toBe('file');

    // Documented live behaviour, NOT an assertion that this is good: a LIST of a
    // path that does not exist comes back as a successful EMPTY listing, because the
    // argument is treated as a glob that matched nothing. So — unlike SFTP, which
    // reports "No such file" — FTP browse cannot tell a missing directory from an
    // empty one, and the user sees an empty folder either way.
    const missingRes = await fetch(`${app.base}/api/data-integration/introspect/ftp/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: connConfig, path: `${runDir}-absent` }),
    });
    const missing = await jsonOf<{ ok: boolean; entries: unknown[] }>(missingRes);
    expect(missing.ok).toBe(true);
    expect(missing.entries).toEqual([]);

    const pvRes = await fetch(`${app.base}/api/data-integration/introspect/ftp/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: connConfig, path: salesPath }),
    });
    const pv = await jsonOf<{ ok: boolean; message?: string; rows: string[][] }>(pvRes);
    expect(pv.ok, pv.message ?? '').toBe(true);
    // The header the mapping step will offer, plus the first data row, as real bytes.
    expect(pv.rows[0]).toEqual(['ID', 'Name', 'Region', 'Amount']);
    expect(pv.rows[1]).toEqual(['S1', 'widget alpha', 'North', '100']);
    expect(pv.rows).toHaveLength(4);
  });

  // ── 4. Deploy ─────────────────────────────────────────────────────────────

  it('P6: Deploy creates the credential and enables the pipeline (service last)', async () => {
    // The target the user maps onto: a real SCO custom object, with the `uid` key
    // index the BPL upserts on.
    target = await createCustomObject(app, [
      { name: 'name', dataType: 'String' },
      { name: 'region', dataType: 'String' },
      { name: 'amount', dataType: 'Integer' },
    ]);
    cleanups.push(target.cleanup);
    expect(target.props).toContain('uid');

    // The adapter references a Credentials ENTRY, never a raw username/password —
    // that is the whole reason this route exists.
    const credName = `WorkbenchTestFtp${RUN_KEY}`;
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

    // The wizard's state at the moment Deploy is pressed. deployViaAgent turns this
    // into the same prompt the button sends and runs a real agent turn — the key
    // index and request property are NOT given, the agent resolves them.
    const job: WizardJob = {
      id: `ftp${RUN_KEY}`.replace(/[^A-Za-z0-9]/g, ''),
      name: 'FtpSalesFlow',
      source: {
        type: 'ftp',
        adapterType: 'FTP',
        ftpSftp: false,
        ftpHost: config.host,
        ftpPort: port,
        ftpPath: `${runDir}/`,
        // FileSpec is the adapter's wildcard filter, so notes.txt must never be
        // handed to the parser.
        ftpFileSpec: '*.csv',
        ftpCredentialName: credName,
      },
      targetClass: target.objectName,
      hasHeader: true,
      columns: [
        { name: 'ID', type: 'String', targetProperty: 'uid' },
        { name: 'Name', type: 'String', transform: 'ToUpper', targetProperty: 'name' },
        { name: 'Region', type: 'String', targetProperty: 'region' },
        { name: 'Amount', type: 'Integer', targetProperty: 'amount' },
      ],
    };

    // Take the log mark BEFORE anything is enabled, so a later failure dump shows
    // only what this pipeline logged.
    sinceLogId = await ensLogHighWater(app.iris);

    const deployed = await deployViaAgent(app, job, { [target.objectName]: target.className }, cleanups);
    expect(deployed.status).toMatchObject({ phase: 'deployed', ok: true });
    expect(deployed.itemNames).toEqual([deployed.names.bpConfigName, deployed.names.bsConfigName]);
    // The inbound service is the LAST item enabled — enabling it starts the polling.
    expect(deployed.serviceName).toBe(deployed.names.bsConfigName);
    // An agent turn takes ~60-90s and its latency is not ours to control, so this step
    // gets more than the tier's 180s. deployViaAgent aborts at 240s with its transcript.
  }, 300_000);

  // ── 5. Verify the data actually arrived ───────────────────────────────────

  it('P7: IRIS polls the FTP server and the CSV lands in the target with the MAPPED values', async () => {
    const rows = await waitForRows<TargetRow>(app.iris, target.className, {
      until: (r) => r.length >= 3,
      label: 'the 3 rows of sales.csv',
      sinceLogId,
      orderBy: 'uid',
    });

    // Exactly the CSV's rows — notes.txt was excluded by FileSpec, so no fourth row
    // and no parse error from a non-CSV file.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.uid)).toEqual(['S1', 'S2', 'S3']);
    // Field values, not just a count: a count-only assertion passes even when the
    // DTL maps every column to the wrong property. ToUpper proves the transform ran.
    expect(rows[0]).toMatchObject({ uid: 'S1', name: 'WIDGET ALPHA', region: 'North' });
    expect(Number(rows[0]!.amount)).toBe(100);
    expect(rows[1]).toMatchObject({ uid: 'S2', name: 'WIDGET BETA', region: 'South' });
    expect(Number(rows[2]!.amount)).toBe(375);
  });

  it('P8: the source file is left EXACTLY as it was — nothing is deleted or renamed', async () => {
    // DeleteFromServer defaults to 1 on this adapter family, and on FTP the deletion
    // also breaks the NEXT poll (the adapter re-lists a file it just removed). Both
    // are why the generator overrides it to 0; this is the assertion that proves it.
    const names = await seeder.listAll(runDir);
    expect(names.sort()).toEqual(['notes.txt', 'sales.csv']);
  });

  it('P9: a second file dropped later is picked up: the changed row upserts, the new row inserts', async () => {
    // The pipeline is still enabled and polling, so this exercises the steady state
    // a user lives with — not just the first poll after deploy.
    await seeder.put(updatePath, SALES_UPDATE_CSV);

    const rows = await waitForRows<TargetRow>(app.iris, target.className, {
      until: (r) => r.length >= 4 && Number(r.find((x) => x.uid === 'S1')?.amount) === 999,
      label: 'S4 inserted and S1 upserted to 999',
      sinceLogId,
      orderBy: 'uid',
    });

    // 4, not 5: S1 was UPDATED via the uid key index, not duplicated.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.uid)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(Number(rows[0]!.amount)).toBe(999);
    expect(rows[3]).toMatchObject({ uid: 'S4', name: 'WIDGET DELTA', region: 'West' });
    // The untouched rows are still exactly as the first file left them.
    expect(rows[1]).toMatchObject({ uid: 'S2', name: 'WIDGET BETA' });
  });
});
