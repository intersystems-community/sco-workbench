/**
 * S3 end to end: the whole Data Integration flow a user actually performs, against
 * a REAL bucket and a REAL IRIS.
 *
 *   1. upload the AWS credentials file the wizard asks for
 *   2. Test Connection with it (and the two mistakes users make)
 *   3. drop a CSV in the bucket, then browse + preview it as the wizard does
 *   4. Deploy: materialize the credentials into IRIS, compile the generated
 *      pipeline, register its hosts, enable them (service LAST)
 *   5. wait for the adapter to poll, and assert the ROWS AND FIELD VALUES that
 *      landed in the target object
 *   6. drop a second file: the new row is inserted and the changed row is upserted
 *
 * Everything goes through the product's own seams — the upload/materialize routes,
 * the Test Connection route, the introspect routes, the deterministic generator, and
 * `production-ops` — so this proves the deployed pipeline INGESTS, which no other
 * tier does (the unit tier injects fakes, and no live tier ever enables an adapter).
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
import { makeSeeder } from './helpers/s3-seed.js';
import { describeIfConfigured, resolveS3, RUN_KEY, s3Prefix } from './helpers/sources.js';

/**
 * The file the user drops in their bucket. Plain commas only: the generated BPL
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

describeIfConfigured('S3 → IRIS: the whole Data Integration flow', resolveS3, (config) => {
  const seeder = makeSeeder(config);
  const prefix = s3Prefix(); // ci/<RUN_KEY>/ — the only place this run writes
  const salesKey = `${prefix}sales.csv`;
  const updateKey = `${prefix}sales-update.csv`;
  const notesKey = `${prefix}notes.txt`;

  /**
   * The credentials file as a user's AWS console hands it to them: a NAMED profile,
   * not `[default]`. The Cloud adapter's Java SDK reads only `[default]`, so the
   * upload route rewrites it — staging this exact shape is what proves that.
   */
  const credentialsFile = [
    '[123_SomeSsoRole]',
    `aws_access_key_id=${config.accessKeyId}`,
    `aws_secret_access_key=${config.secretAccessKey}`,
    ...(config.sessionToken ? [`aws_session_token=${config.sessionToken}`] : []),
  ].join('\n');

  const env = loadEnv();
  let app: BootedApp;
  let cleanups: Cleanup[] = [];
  let target: CustomObject;
  /** Carried between steps: the upload's id and the path it takes inside IRIS. */
  let credFileId = '';
  let credIrisPath = '';
  /** Ens log high-water mark, taken before the pipeline is enabled. */
  let sinceLogId = 0;

  beforeAll(async () => {
    app = bootApp();
    cleanups = [];
    // The user's data, already in their bucket before they open the wizard. The
    // .txt is here so the deployed adapter's BlobNamePattern is provably filtering
    // rather than ingesting everything it finds.
    await seeder.put(salesKey, SALES_CSV);
    await seeder.put(notesKey, 'not a csv\n');
  });

  afterAll(async () => {
    // The bucket goes first. Emptying it is the only teardown step whose target
    // outlives the job, and the IRIS steps below can take minutes (see the
    // hookTimeout note in vitest.config.ts) — so it must not be behind them.
    const removed = await seeder.removePrefix(prefix);
    try {
      // Reverse order: disable the service → remove config items → delete classes →
      // stop the production → delete the credentials file from IRIS → drop the target.
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
      // Teardown must actually empty the prefix — a bucket that grows per merge
      // request is the thing total-view-for-supply-chain got wrong.
      expect(removed).toBeGreaterThanOrEqual(3);
      expect(await seeder.listAll(prefix)).toEqual([]);
    }
  });

  // ── 1. The user supplies their credentials ────────────────────────────────

  it('F1: the uploaded AWS credentials file is held for a 0600 path in the IRIS KEY dir, not written yet', async () => {
    const form = new FormData();
    form.set('file', new Blob([credentialsFile], { type: 'text/plain' }), 'credentials');
    form.set('kind', 'aws-cred');
    const res = await fetch(`${app.base}/api/data-integration/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ fileId: string; irisPath: string; kind: string }>(res);

    expect(body.kind).toBe('aws-cred');
    // Credentials are a secret: the key dir (0600 on materialize), never the CSV dir.
    expect(body.irisPath.startsWith(`${env.SCO_UPLOAD_KEY_DIR}/`)).toBe(true);
    expect(body.irisPath.endsWith('_credentials')).toBe(true);
    // Nothing reaches IRIS at upload time — that only happens at Deploy (F5).
    expect(fileExistsInIris(app.iris.native, body.irisPath)).toBe(false);

    credFileId = body.fileId;
    credIrisPath = body.irisPath;
    cleanups.push(async () => {
      await fetch(`${app.base}/api/data-integration/uploads/materialize/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: [credFileId] }),
      });
    });
  });

  it('F2: Test Connection accepts the named-profile file and names the bucket + region', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { bucket: config.bucket, region: config.region, credentialsFileContent: credentialsFile },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok, body.message).toBe(true);
    expect(body.message).toContain(config.bucket);
    expect(body.message).toContain(config.region);
  });

  it('F3: a mistyped secret in that file is a failed TEST (200), with S3\'s own signature wording', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          bucket: config.bucket,
          region: config.region,
          credentialsFileContent: credentialsFile.replace(
            config.secretAccessKey,
            'x'.repeat(config.secretAccessKey.length),
          ),
        },
      }),
    });
    // A wrong password is a normal wizard outcome, not an HTTP error.
    expect(res.status).toBe(200);
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    // Pinned live wording (2026-09-04). The AWS error CODE never reaches the user:
    // `friendly()` in s3-fs.ts uses err.message, which carries only this sentence.
    expect(body.message).toBe(
      'Connection or authentication failed: The request signature we calculated does not '
        + 'match the signature you provided. Check your key and signing method.',
    );
  });

  it('F4: a typo in the bucket name reads as a missing bucket, NOT as a credential problem', async () => {
    const res = await fetch(`${app.base}/api/data-integration/test-connection/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          bucket: `${config.bucket}-absent-${RUN_KEY}`.toLowerCase(),
          region: config.region,
          credentialsFileContent: credentialsFile,
        },
      }),
    });
    const body = await jsonOf<{ ok: boolean; message: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.message).toBe('Connection or authentication failed: The specified bucket does not exist');
    expect(body.message).not.toMatch(/signature|access key/i);
  });

  // ── 2. The user browses the bucket and picks the file ─────────────────────

  it('F5: browsing the run prefix shows the seeded objects, and preview returns the real rows', async () => {
    const listRes = await fetch(`${app.base}/api/data-integration/introspect/s3/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { bucket: config.bucket, region: config.region, credentialsFileContent: credentialsFile },
        path: `/${prefix}`,
      }),
    });
    const listed = await jsonOf<{ ok: boolean; message?: string; entries: { name: string; type: string }[] }>(
      listRes,
    );
    expect(listed.ok, listed.message ?? '').toBe(true);
    const byName = new Map(listed.entries.map((e) => [e.name, e.type]));
    expect(byName.get('sales.csv')).toBe('csv');
    expect(byName.get('notes.txt')).toBe('file');

    const pvRes = await fetch(`${app.base}/api/data-integration/introspect/s3/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { bucket: config.bucket, region: config.region, credentialsFileContent: credentialsFile },
        path: `/${salesKey}`,
      }),
    });
    const pv = await jsonOf<{ ok: boolean; message?: string; rows: string[][] }>(pvRes);
    expect(pv.ok, pv.message ?? '').toBe(true);
    // The header the mapping step will offer, plus the first data row, as real bytes.
    expect(pv.rows[0]).toEqual(['ID', 'Name', 'Region', 'Amount']);
    expect(pv.rows[1]).toEqual(['S1', 'widget alpha', 'North', '100']);
    expect(pv.rows).toHaveLength(4);
  });

  // ── 3. Deploy ─────────────────────────────────────────────────────────────

  it('F6: Deploy materializes the credentials into IRIS and enables the pipeline (service last)', async () => {
    // The target the user maps onto: a real SCO custom object, with the `uid` key
    // index the BPL upserts on.
    target = await createCustomObject(app, [
      { name: 'name', dataType: 'String' },
      { name: 'region', dataType: 'String' },
      { name: 'amount', dataType: 'Integer' },
    ]);
    cleanups.push(target.cleanup);
    expect(target.props).toContain('uid');

    // Materialize: the held bytes are written into the IRIS container over the
    // Native SDK, normalized to a [default] profile on the way in (the Cloud
    // adapter hands the file to a Java SDK that reads only that profile — F2
    // already proved the rewritten credentials still authenticate).
    const matRes = await fetch(`${app.base}/api/data-integration/uploads/materialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: [credFileId] }),
    });
    const mat = await jsonOf<{ results: { ok: boolean; error?: string; irisPath: string }[] }>(matRes);
    expect(mat.results[0]?.ok, mat.results[0]?.error ?? '').toBe(true);
    expect(fileExistsInIris(app.iris.native, credIrisPath)).toBe(true);

    // The wizard's state at the moment Deploy is pressed. deployViaAgent turns this
    // into the same prompt the button sends and runs a real agent turn — the key
    // index and request property are NOT given, the agent resolves them.
    const job: WizardJob = {
      id: `s3${RUN_KEY}`.replace(/[^A-Za-z0-9]/g, ''),
      name: 'S3SalesFlow',
      source: {
        type: 'cloud',
        adapterType: 'Cloud',
        cloudBucket: config.bucket,
        cloudRegion: config.region,
        cloudCredentialsFile: credIrisPath,
        cloudBlobPrefix: prefix,
        // Wildcards ? and * are supported ("Blob name pattern, used to filter blobs
        // on client"), so notes.txt must never be handed to the parser.
        cloudBlobPattern: '*.csv',
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

  it('F7: the adapter polls S3 and the CSV lands in the target with the MAPPED values', async () => {
    const rows = await waitForRows<TargetRow>(app.iris, target.className, {
      until: (r) => r.length >= 3,
      label: 'the 3 rows of sales.csv',
      sinceLogId,
      orderBy: 'uid',
    });

    // Exactly the CSV's rows — notes.txt was excluded by BlobNamePattern, so no
    // fourth row and no parse error from a non-CSV blob.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.uid)).toEqual(['S1', 'S2', 'S3']);
    // Field values, not just a count: a count-only assertion passes even when the
    // DTL maps every column to the wrong property. ToUpper proves the transform ran.
    expect(rows[0]).toMatchObject({ uid: 'S1', name: 'WIDGET ALPHA', region: 'North' });
    expect(Number(rows[0]!.amount)).toBe(100);
    expect(rows[1]).toMatchObject({ uid: 'S2', name: 'WIDGET BETA', region: 'South' });
    expect(Number(rows[2]!.amount)).toBe(375);
  });

  it('F8: a second file dropped later is picked up: the changed row upserts, the new row inserts', async () => {
    // The pipeline is still enabled and polling, so this exercises the steady state
    // a user lives with — not just the first poll after deploy.
    await seeder.put(updateKey, SALES_UPDATE_CSV);

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
