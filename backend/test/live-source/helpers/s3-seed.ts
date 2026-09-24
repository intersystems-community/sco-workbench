/**
 * Fixture writer for the real S3 bucket.
 *
 * The product's S3 seam (`util/remote-fs/s3-fs.ts`) is read-only by design — it
 * exposes only `list` and `getRange`, because the Workbench never writes to a
 * customer bucket. Seeding is therefore a test concern with its own client, and
 * deliberately does NOT go through `makeS3Api`: a fixture that shared the code
 * under test could hide a defect in it.
 *
 * Everything written lives under one prefix owned by the run (`ci/<RUN_KEY>/`), so
 * `removePrefix` is a complete teardown and concurrent pipelines cannot collide.
 */
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Config } from '../../../src/util/remote-fs/s3-fs.js';

export interface S3Seeder {
  /** Write one object. `key` is a full key, not relative to any prefix. */
  put(key: string, body: string): Promise<void>;
  /** Every key under `prefix`, recursively, paginated. */
  listAll(prefix: string): Promise<string[]>;
  /** Delete everything under `prefix`. Returns how many keys were removed. */
  removePrefix(prefix: string): Promise<number>;
}

export const makeSeeder = (config: S3Config): S3Seeder => {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken || undefined,
    },
  });
  const bucket = config.bucket;

  const listAll = async (prefix: string): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const c of out.Contents ?? []) if (c.Key) keys.push(c.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  };

  return {
    async put(key, body) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/csv' }),
      );
    },
    listAll,
    async removePrefix(prefix) {
      const keys = await listAll(prefix);
      // DeleteObjects caps at 1000 keys per call; a fixture never approaches that,
      // but chunking costs one line and removes the cap as a thing to remember.
      for (let i = 0; i < keys.length; i += 1000) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
          }),
        );
      }
      return keys.length;
    },
  };
};
