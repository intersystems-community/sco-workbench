import { makeS3Api, type S3ApiFactory, type S3Config } from './remote-fs/s3-fs.js';

/**
 * Connection-test logic for the Data Integration cloud (AWS S3) source.
 *
 * Like the FTP and SFTP tests, the Node backend talks to the target DIRECTLY —
 * here through the AWS SDK v3 client behind the narrow `S3Api` seam that the
 * bucket browser already uses (util/remote-fs/s3-fs.ts). No IRIS involvement, and
 * only ONE S3 code path in the estate, so a connection that tests OK is by
 * construction one the Data Entity browser can list.
 *
 * The test lists the BUCKET ROOT: that single call proves the region resolves,
 * the credentials authenticate, and the identity is authorized on this bucket
 * (`s3:ListBucket`) — the same three things the browse step then depends on. It is
 * the S3 analogue of FTP's login + `PWD`. An empty bucket is a SUCCESS: nothing
 * to list is not a failure to connect.
 *
 * Credentials reach us as key values, resolved from the wizard's uploaded
 * credentials file by util/aws-credentials.ts. They are used for this one request
 * and never logged.
 */

/** Outcome of a connection test — the shape the frontend renders directly. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** Give up rather than let the SDK's retry chain hang the button. */
const TEST_TIMEOUT_MS = 15_000;

/** Reject-free timeout wrapper: resolves to `null` when `promise` outlasts `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Test an S3 connection: build a client for the region + credentials and list the
 * bucket root. Resolves to a friendly `{ ok, message }` either way — a failed test
 * is a normal outcome, not a reject.
 *
 * `factory` is injectable so unit tests exercise success / empty-bucket /
 * bad-credentials / no-such-bucket / timeout paths without a live bucket.
 */
export async function testS3Connection(
  config: S3Config,
  factory: S3ApiFactory = makeS3Api,
): Promise<ConnectionTestResult> {
  const bucket = config.bucket?.trim() ?? '';
  const region = config.region?.trim() ?? '';
  if (!bucket) return { ok: false, message: 'Connection failed: Bucket Name is required.' };
  if (!region) return { ok: false, message: 'Connection failed: Storage Region is required.' };
  if (!config.accessKeyId?.trim() || !config.secretAccessKey?.trim()) {
    return { ok: false, message: 'Connection failed: an access key id and secret access key are required.' };
  }

  try {
    const api = factory({ ...config, bucket, region });
    const listed = await withTimeout(api.list(''), TEST_TIMEOUT_MS);
    if (!listed) {
      return { ok: false, message: `Connection failed: no response from S3 in ${TEST_TIMEOUT_MS / 1000}s.` };
    }
    const count = listed.prefixes.length + listed.keys.length;
    // An empty bucket still proves reachability + authorization — report it as such
    // rather than implying nothing was found because something went wrong.
    const detail = count
      ? `${count} object${count === 1 ? '' : 's'} or folder${count === 1 ? '' : 's'} at the bucket root`
      : 'the bucket root is empty';
    return { ok: true, message: `S3 connection to bucket "${bucket}" in ${region} succeeded (${detail}).` };
  } catch (err) {
    // The SDK throws for bad credentials (InvalidAccessKeyId / SignatureDoesNotMatch),
    // a missing bucket (NoSuchBucket), a wrong region (PermanentRedirect) and network
    // problems alike — all of them are a failed test, not a crash.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Connection or authentication failed: ${detail}` };
  }
}
