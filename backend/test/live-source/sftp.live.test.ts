/**
 * SFTP end to end: the whole Data Integration flow a user actually performs, against
 * a REAL SSH/SFTP server and a REAL IRIS.
 *
 *   1. upload the private key the wizard asks for (plus the public half IRIS needs)
 *   2. Test Connection with it (and the two mistakes users make)
 *   3. drop a CSV on the server, then browse + preview it as the wizard does
 *   4. Deploy: create the IRIS Credentials entry, materialize both keys into IRIS,
 *      compile the generated pipeline, register its hosts, enable them (service LAST)
 *   5. wait for the adapter to poll, and assert the ROWS AND FIELD VALUES that
 *      landed in the target object
 *   6. drop a second file: the new row is inserted and the changed row is upserted
 *
 * Two DIFFERENT SFTP clients are proven here, and that is the point: the wizard's
 * Test Connection / browse / preview run in Node over `ssh2`, while the deployed
 * pipeline runs inside IRIS over `%Net.SSH` (libssh2) with a key file on the IRIS
 * filesystem. Only this tier exercises the second one.
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
import { basename } from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { fileExistsInIris } from '../../src/iris/file-ops.js';
import { bootApp, jsonOf, type BootedApp } from '../integration/helpers/iris-app.js';
import {
  createCustomObject,
  runCleanups,
  type Cleanup,
  type CustomObject,
} from '../integration/helpers/provision.js';
import type { WizardJob } from './helpers/deploy-prompt.js';
import { deployViaAgent, ensLogHighWater, forceStopDeployedHosts, waitForRows } from './helpers/ingest.js';
import { makeSftpSeeder } from './helpers/sftp-seed.js';
import { describeIfConfigured, resolveSftp, RUN_KEY } from './helpers/sources.js';

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

describeIfConfigured('SFTP → IRIS: the whole Data Integration flow', resolveSftp, (config) => {
  const seeder = makeSftpSeeder(config);
  /**
   * The drop directory is SHARED between runs (unlike the S3 bucket, where the run
   * owns a prefix), so this run gets its own subdirectory. The adapter's FilePath
   * points at it, so a concurrent pipeline's files are not even visible.
   */
  const runDir = `${config.dir.replace(/\/+$/, '')}/${RUN_KEY}`;
  const salesPath = `${runDir}/sales.csv`;
  const updatePath = `${runDir}/sales-update.csv`;
  const notesPath = `${runDir}/notes.txt`;
  /** Port as the HTTP routes take it (they read config.port as a string). */
  const port = String(config.port);

  const env = loadEnv();
  let app: BootedApp;
  let cleanups: Cleanup[] = [];
  let target: CustomObject;
  /** Carried between steps: each upload's id and the path it takes inside IRIS. */
  let keyFileId = '';
  let keyIrisPath = '';
  let pubFileId = '';
  let pubIrisPath = '';
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
      // stop the production → delete the credential → delete the keys from IRIS →
      // drop the target.
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
      await expect(seeder.listAll(runDir)).rejects.toThrow();
    }
  });

  // ── 1. The user supplies their key ────────────────────────────────────────

  it('K1: the uploaded private key is held for a 0600 path in the IRIS KEY dir, not written yet', async () => {
    const upload = async (name: string, body: string) => {
      const form = new FormData();
      form.set('file', new Blob([body], { type: 'application/octet-stream' }), name);
      form.set('kind', 'ssh-key');
      const res = await fetch(`${app.base}/api/data-integration/uploads`, { method: 'POST', body: form });
      expect(res.status).toBe(200);
      return jsonOf<{ fileId: string; irisPath: string; kind: string }>(res);
    };

    const keyName = basename(config.privateKeyPath);
    const key = await upload(keyName, seeder.privateKey);
    expect(key.kind).toBe('ssh-key');
    // Key material is a secret: the key dir (0600 on materialize), never the CSV dir.
    expect(key.irisPath.startsWith(`${env.SCO_UPLOAD_KEY_DIR}/`)).toBe(true);
    expect(key.irisPath.endsWith(`_${keyName}`)).toBe(true);
    // Nothing reaches IRIS at upload time — that only happens at Deploy (K6).
    expect(fileExistsInIris(app.iris.native, key.irisPath)).toBe(false);

    // IRIS authenticates with the key PAIR (%Net.SSH.Session.AuthenticateWithKeyPair
    // takes both halves), so the public key is staged too. The Node-side client needs
    // only the private half — which is why the wizard asks for both.
    const pub = await upload(`${keyName}.pub`, seeder.publicKey);
    expect(pub.irisPath.startsWith(`${env.SCO_UPLOAD_KEY_DIR}/`)).toBe(true);

    keyFileId = key.fileId;
    keyIrisPath = key.irisPath;
    pubFileId = pub.fileId;
    pubIrisPath = pub.irisPath;
    cleanups.push(async () => {
      await fetch(`${app.base}/api/data-integration/uploads/materialize/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: [keyFileId, pubFileId] }),
      });
    });
  });

  it('K2: Test Connection accepts the key and names the host + user', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { host: config.host, port, username: config.user, privateKey: seeder.privateKey } }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok, body.message).toBe(true);
    expect(body.message).toBe(`SFTP connection to ${config.host} as ${config.user} succeeded.`);
  });

  it('K3: a mistyped username is a failed TEST (200), with ssh2\'s own auth wording', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { host: config.host, port, username: `${config.user}-nope`, privateKey: seeder.privateKey },
      }),
    });
    // A rejected login is a normal wizard outcome, not an HTTP error.
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // Pinned live wording (2026-09-14). A key-only server cannot distinguish "no such
    // user" from "wrong key" — it just refuses every method it offered.
    expect(body.message).toBe('Connection or authentication failed: All configured authentication methods failed');
  });

  it('K4: a wrong port reads as an unreachable host, NOT as an auth problem', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/sftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { host: config.host, port: String(config.port + 1), username: config.user, privateKey: seeder.privateKey },
      }),
    });
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // Not pinned to one message. A closed port sends RST, so ssh2 reports
    // "ECONNREFUSED <host>:<port>". A port a firewall drops instead races the OS TCP
    // timeout against ssh2's 10s readyTimeout, giving either "connect ETIMEDOUT
    // <host>:<port>" or "Timed out while waiting for handshake" — which has no
    // host:port in it. The point of the test is the line below: whichever arrives, it
    // must not read as a rejected login. That the port is used at all is proven by K2.
    expect(body.message).toMatch(/refused|timed out|ETIMEDOUT|ECONNREFUSED/i);
    expect(body.message).not.toMatch(/authentication methods/i);
  });

  // ── 2. The user browses the server and picks the file ─────────────────────

  it('K5: browsing the run directory shows the seeded files, and preview returns the real rows', async () => {
    const listBody = (path: string) =>
      JSON.stringify({
        config: { host: config.host, port, username: config.user, privateKey: seeder.privateKey },
        path,
      });

    const listRes = await fetch(`${app.base}/api/data-integration/introspect/sftp/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: listBody(runDir),
    });
    const listed = await jsonOf<{ ok: boolean; message?: string; entries: { name: string; type: string }[] }>(
      listRes,
    );
    expect(listed.ok, listed.message ?? '').toBe(true);
    const byName = new Map(listed.entries.map((e) => [e.name, e.type]));
    expect(byName.get('sales.csv')).toBe('csv');
    expect(byName.get('notes.txt')).toBe('file');

    // A good key against a path that does not exist must read as a PATH problem —
    // the mistake a user makes after their connection already tested OK.
    const missingRes = await fetch(`${app.base}/api/data-integration/introspect/sftp/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: listBody(`${runDir}-absent`),
    });
    const missing = await jsonOf<{ ok: boolean; message: string }>(missingRes);
    expect(missing.ok).toBe(false);
    expect(missing.message).toBe(`Could not read "${runDir}-absent": No such file`);

    const pvRes = await fetch(`${app.base}/api/data-integration/introspect/sftp/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: listBody(salesPath),
    });
    const pv = await jsonOf<{ ok: boolean; message?: string; rows: string[][] }>(pvRes);
    expect(pv.ok, pv.message ?? '').toBe(true);
    // The header the mapping step will offer, plus the first data row, as real bytes.
    expect(pv.rows[0]).toEqual(['ID', 'Name', 'Region', 'Amount']);
    expect(pv.rows[1]).toEqual(['S1', 'widget alpha', 'North', '100']);
    expect(pv.rows).toHaveLength(4);
  });

  // ── 3. Deploy ─────────────────────────────────────────────────────────────

  it('K6: Deploy stages the keys + credential into IRIS and enables the pipeline (service last)', async () => {
    // The target the user maps onto: a real SCO custom object, with the `uid` key
    // index the BPL upserts on.
    target = await createCustomObject(app, [
      { name: 'name', dataType: 'String' },
      { name: 'region', dataType: 'String' },
      { name: 'amount', dataType: 'Integer' },
    ]);
    cleanups.push(target.cleanup);
    expect(target.props).toContain('uid');

    // The adapter references a Credentials ENTRY, never a raw username. For key-pair
    // auth IRIS uses the entry's Username to log in and its Password as the key's
    // passphrase — this key has none, so the password is blank.
    const credName = `WorkbenchTestSftp${RUN_KEY}`;
    const credRes = await fetch(`${app.base}/api/data-integration/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: credName, username: config.user, password: '' }),
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

    // Materialize: the held bytes are written into the IRIS container over the Native
    // SDK, 0600. Key material is staged VERBATIM — only an aws-cred file is rewritten.
    const matRes = await fetch(`${app.base}/api/data-integration/uploads/materialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: [keyFileId, pubFileId] }),
    });
    const mat = await jsonOf<{ results: { ok: boolean; error?: string }[] }>(matRes);
    expect(mat.results.map((r) => r.ok), JSON.stringify(mat.results)).toEqual([true, true]);
    expect(fileExistsInIris(app.iris.native, keyIrisPath)).toBe(true);
    expect(fileExistsInIris(app.iris.native, pubIrisPath)).toBe(true);

    // The wizard's state at the moment Deploy is pressed. deployViaAgent turns this
    // into the same prompt the button sends and runs a real agent turn — the key
    // index and request property are NOT given, the agent resolves them.
    const job: WizardJob = {
      id: `sftp${RUN_KEY}`.replace(/[^A-Za-z0-9]/g, ''),
      name: 'SftpSalesFlow',
      source: {
        type: 'ftp',
        adapterType: 'FTP',
        ftpSftp: true,
        ftpHost: config.host,
        ftpPort: port,
        ftpPath: `${runDir}/`,
        // FileSpec is the FTP adapter's wildcard filter, so notes.txt must never be
        // handed to the parser.
        ftpFileSpec: '*.csv',
        ftpCredentialName: credName,
        sftpPublicKeyFile: pubIrisPath,
        sftpPrivateKeyFile: keyIrisPath,
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

  // ── 4. Verify the data actually arrived ───────────────────────────────────

  it('K7: IRIS polls the SFTP server and the CSV lands in the target with the MAPPED values', async () => {
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

  it('K8: the source file is left EXACTLY as it was — nothing is deleted or renamed', async () => {
    // DeleteFromServer=0 and no RenameFilename: the user's file must survive being
    // ingested. This is the assertion the S3 suite cannot make (the bucket is emptied
    // by teardown either way) and the one an adapter default would silently break.
    const names = await seeder.listAll(runDir);
    expect(names.sort()).toEqual(['notes.txt', 'sales.csv']);
  });

  it('K9: a second file dropped later is picked up: the changed row upserts, the new row inserts', async () => {
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
