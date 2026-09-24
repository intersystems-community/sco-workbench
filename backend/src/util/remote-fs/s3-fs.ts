// backend/src/util/remote-fs/s3-fs.ts
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { parseCsv, PREVIEW_ROWS, MAX_PREVIEW_BYTES } from '../csv-inspect.js';
import { classifyEntry, type ListResult, type PreviewResult, type RemoteFileSystem } from './types.js';

/**
 * S3 implementation of RemoteFileSystem over the AWS SDK v3 modular client. FIRST
 * Node AWS dependency in the estate — flag at the MR. Credentials arrive as
 * VALUES (access key id + secret + optional session token), NOT a file path: the
 * wizard's cloudCredentialsFile is the path the file will occupy inside IRIS (for
 * the adapter's ProviderCredentialsFile), which this process cannot open. The
 * routes resolve values from the uploaded file's CONTENTS — see
 * util/aws-credentials.ts. Keys are used server-side only and never logged.
 *
 * All SDK specifics live in makeS3Api; S3FileSystem depends only on the narrow
 * S3Api seam, so tests inject a fake with no live bucket.
 */

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The narrow S3 surface the filesystem needs (injectable for tests). */
export interface S3Api {
  /** List one prefix level: `prefixes` are folder keys, `keys` are object keys. */
  list(prefix: string): Promise<{ prefixes: string[]; keys: string[] }>;
  /** Read the first `maxBytes` of an object as UTF-8 text. */
  getRange(key: string, maxBytes: number): Promise<string>;
}

export type S3ApiFactory = (config: S3Config) => S3Api;

/** Turn '/raw/sales' into the S3 prefix 'raw/sales/' ('' for the bucket root). */
function toPrefix(path: string): string {
  const trimmed = (path ?? '').split('/').filter(Boolean).join('/');
  return trimmed ? `${trimmed}/` : '';
}

/** Turn '/raw/summary.csv' into the S3 object key 'raw/summary.csv'. */
function toKey(path: string): string {
  return (path ?? '').split('/').filter(Boolean).join('/');
}

/** The real adapter — the ONLY place @aws-sdk/client-s3 is used. */
export const makeS3Api: S3ApiFactory = (config) => {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken || undefined,
    },
  });
  return {
    async list(prefix) {
      const out = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        Delimiter: '/',
      }));
      const prefixes = (out.CommonPrefixes ?? [])
        .map((p) => p.Prefix ?? '')
        .filter(Boolean);
      const keys = (out.Contents ?? [])
        .map((c) => c.Key ?? '')
        .filter((k) => k && k !== prefix); // drop the prefix placeholder object
      return { prefixes, keys };
    },
    async getRange(key, maxBytes) {
      const out = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Range: `bytes=0-${maxBytes - 1}`,
      }));
      // Body is a Node Readable in the Node runtime; transformToString reads it.
      const body = out.Body as { transformToString(enc?: string): Promise<string> };
      return body.transformToString('utf-8');
    },
  };
};

function friendly(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return detail;
}

export class S3FileSystem implements RemoteFileSystem {
  private readonly api?: S3Api;
  private readonly configError?: string;

  constructor(config: S3Config, factory: S3ApiFactory = makeS3Api) {
    if (!config.bucket?.trim()) { this.configError = 'Bucket is required.'; return; }
    if (!config.region?.trim()) { this.configError = 'Region is required.'; return; }
    if (!config.accessKeyId?.trim() || !config.secretAccessKey?.trim()) {
      this.configError = 'Access key id and secret access key are required.';
      return;
    }
    this.api = factory(config);
  }

  async listDir(path: string): Promise<ListResult> {
    if (!this.api) return { ok: false, message: `Listing failed: ${this.configError}` };
    try {
      const { prefixes, keys } = await this.api.list(toPrefix(path));
      const folders = prefixes.map((p) => {
        const name = p.replace(/\/$/, '').split('/').pop() ?? p;
        return { name, type: 'folder' as const };
      });
      const objects = keys.map((k) => {
        const name = k.split('/').pop() ?? k;
        return { name, type: classifyEntry(name, false) };
      });
      return { ok: true, entries: [...folders, ...objects] };
    } catch (err) {
      return { ok: false, message: friendly(err) };
    }
  }

  async readPreview(path: string): Promise<PreviewResult> {
    if (!this.api) return { ok: false, message: `Preview failed: ${this.configError}` };
    const key = toKey(path);
    if (!key) return { ok: false, message: 'Preview failed: an object key is required.' };
    try {
      const text = await this.api.getRange(key, MAX_PREVIEW_BYTES);
      return { ok: true, rows: parseCsv(text, PREVIEW_ROWS) };
    } catch (err) {
      return { ok: false, message: friendly(err) };
    }
  }
}
