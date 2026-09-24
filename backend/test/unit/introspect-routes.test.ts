// backend/test/unit/introspect-routes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createIntrospectRouter, type FileSystemFactories } from '../../src/server/introspect-routes.js';
import type { RemoteFileSystem, ListResult, PreviewResult } from '../../src/util/remote-fs/types.js';
import type { S3Config } from '../../src/util/remote-fs/s3-fs.js';

/** A fake RemoteFileSystem returning canned list/preview results. */
function fakeFs(list: ListResult, preview: PreviewResult): RemoteFileSystem {
  return { listDir: async () => list, readPreview: async () => preview };
}

/** Point every protocol at one fake FS — a test hits only the route it targets. */
function factoriesFor(fs: RemoteFileSystem): FileSystemFactories {
  return { sftp: () => fs, ftp: () => fs, s3: () => fs };
}

/** Mount ONLY the introspect router with injected factories (and an optional cases
 *  repo, needed by local/preview-stored) on an ephemeral port. */
async function startApp(
  factories: FileSystemFactories,
  cases?: Parameters<typeof createIntrospectRouter>[1],
): Promise<{ server: Server; baseUrl: string }> {
  const app: Express = express();
  app.use(express.json());
  app.use('/introspect', createIntrospectRouter(factories, cases));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const rawCsv: PreviewResult = {
  ok: true,
  rows: [['customer_id', 'name'], ['1001', 'Acme'], ['1002', 'Beta']],
};

const sftpBody = { config: { host: 'h', username: 'u', privateKey: 'k' }, path: '/data/x.csv' };

describe('introspect sftp (raw-row contract, Part 1)', () => {
  it('sftp/list returns the injected fake FS entries', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [{ name: 'x.csv', type: 'csv' }] }, rawCsv)));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/sftp/list', sftpBody);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, entries: [{ name: 'x.csv', type: 'csv' }] });
  });

  it('sftp/preview returns RAW rows unchanged (no inspection in Part 1)', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/sftp/preview', sftpBody);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, rows: rawCsv.ok ? rawCsv.rows : [] });
    // Part 1 must NOT inspect: no header interpretation on the wire.
    expect(body.detectedHasHeader).toBeUndefined();
    expect(body.headered).toBeUndefined();
  });

  it('sftp/preview passes a failed read straight through as { ok:false, message }', async () => {
    const app = await startApp(
      factoriesFor(fakeFs({ ok: true, entries: [] }, { ok: false, message: 'Could not read "/data/x.csv": boom' })),
    );
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/sftp/preview', sftpBody);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, message: 'Could not read "/data/x.csv": boom' });
  });

  it('sftp/preview 400s when the config is malformed (no fake FS built)', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, { ok: true, rows: [] })));
    server = app.server;
    const { status } = await post(app.baseUrl, '/introspect/sftp/preview', { config: { host: '' }, path: '/x.csv' });
    expect(status).toBe(400);
  });
});

describe('introspect ftp routes (raw rows)', () => {
  it('ftp/list returns the injected fake FS entries', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [{ name: 'x.csv', type: 'csv' }] }, rawCsv)));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/ftp/list', { config: { host: 'h', username: 'u' }, path: '/data' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, entries: [{ name: 'x.csv', type: 'csv' }] });
  });

  it('ftp/preview returns raw rows (no inspection)', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/ftp/preview', { config: { host: 'h', username: 'u' }, path: '/data/x.csv' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, rows: rawCsv.ok ? rawCsv.rows : [] });
    expect(body.detectedHasHeader).toBeUndefined();
  });

  it('400s when the FTP config is missing required fields (no FS built)', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status } = await post(app.baseUrl, '/introspect/ftp/list', { config: { host: '' }, path: '/' });
    expect(status).toBe(400);
  });

  it('400s FTP preview when the path is blank', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status } = await post(app.baseUrl, '/introspect/ftp/preview', { config: { host: 'h', username: 'u' }, path: '  ' });
    expect(status).toBe(400);
  });
});

describe('introspect s3 routes (raw rows)', () => {
  it('s3/list returns the injected fake FS entries', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [{ name: 'raw', type: 'folder' }] }, rawCsv)));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/s3/list', {
      config: { bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'sk' }, path: '/',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, entries: [{ name: 'raw', type: 'folder' }] });
  });

  it('s3/preview returns raw rows', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/s3/preview', {
      config: { bucket: 'b', region: 'r', accessKeyId: 'AK', secretAccessKey: 'sk' }, path: '/raw/x.csv',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, rows: rawCsv.ok ? rawCsv.rows : [] });
  });

  it('400s when the S3 config is missing bucket/region/keys', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status } = await post(app.baseUrl, '/introspect/s3/list', { config: { bucket: 'b' }, path: '/' });
    expect(status).toBe(400);
    // Bucket + region present but NO credentials at all is equally malformed.
    const bare = await post(app.baseUrl, '/introspect/s3/list', { config: { bucket: 'b', region: 'r' }, path: '/' });
    expect(bare.status).toBe(400);
  });

  it('accepts the uploaded credentials FILE contents and passes the parsed keys to the client', async () => {
    // The wizard collects a credentials file (the IRIS adapter needs a path), so
    // browse authenticates with its CONTENTS — the same resolver the cloud Test
    // Connection route uses, which is what makes "tested OK" imply "can browse".
    const seen: S3Config[] = [];
    const fs = fakeFs({ ok: true, entries: [{ name: 'raw', type: 'folder' }] }, rawCsv);
    const app = await startApp({
      sftp: () => fs,
      ftp: () => fs,
      s3: (config) => { seen.push(config); return fs; },
    });
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/s3/list', {
      config: {
        bucket: 'b',
        region: 'us-east-1',
        credentialsFileContent: '[default]\naws_access_key_id=AKFILE\naws_secret_access_key=filesecret\n',
      },
      path: '/',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, entries: [{ name: 'raw', type: 'folder' }] });
    expect(seen).toEqual([
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'AKFILE', secretAccessKey: 'filesecret', sessionToken: undefined },
    ]);
  });

  it('reports an UNREADABLE credentials file as a failed listing/preview, not a 4xx', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const config = { bucket: 'b', region: 'r', credentialsFileContent: 'not a credentials file' };
    // The body was well-formed — the file's CONTENTS are the problem, which is a
    // normal outcome the browser renders inline (same rule as a dead host).
    const list = await post(app.baseUrl, '/introspect/s3/list', { config, path: '/' });
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(false);
    expect(list.body.message).toContain('Listing failed');

    const preview = await post(app.baseUrl, '/introspect/s3/preview', { config, path: '/raw/x.csv' });
    expect(preview.status).toBe(200);
    expect(preview.body.ok).toBe(false);
    expect(preview.body.message).toContain('Preview failed');
  });
});

describe('introspect local/preview (raw rows)', () => {
  it('parses posted CSV text into raw rows (no FS, no inspection)', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const text = 'customer_id,customer_name\n1001,Acme\n1002,Beta\n';
    const { status, body } = await post(app.baseUrl, '/introspect/local/preview', { text });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      rows: [['customer_id', 'customer_name'], ['1001', 'Acme'], ['1002', 'Beta']],
    });
    expect(body.detectedHasHeader).toBeUndefined();
  });

  it('400s when text is missing', async () => {
    const app = await startApp(factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv)));
    server = app.server;
    const { status } = await post(app.baseUrl, '/introspect/local/preview', {});
    expect(status).toBe(400);
  });
});

describe('introspect local/preview-stored (reopened case, bytes from SQLite)', () => {
  /** A cases repo stub exposing only getFileBytesBySlot — all this route needs. No
   *  live DB/FTP: the route reads persisted bytes, so a fake repo fully exercises it. */
  function casesWith(bytes: Buffer | null, encrypted = false): Parameters<typeof createIntrospectRouter>[1] {
    return {
      getFileBytesBySlot: (_caseId: string, slot: string) =>
        bytes && slot === 'localFile'
          ? { fileId: 'f1', slot, kind: 'csv', originalName: 'x.csv', irisPath: '/p/x.csv', secret: false, encrypted, bytes }
          : null,
    } as unknown as Parameters<typeof createIntrospectRouter>[1];
  }

  const factories = factoriesFor(fakeFs({ ok: true, entries: [] }, rawCsv));

  it('parses the stored file bytes into raw rows (why: a refreshed browser has no File to read)', async () => {
    const csv = Buffer.from('customer_id,customer_name\n1001,Acme\n1002,Beta\n', 'utf8');
    const app = await startApp(factories, casesWith(csv));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/local/preview-stored', { caseId: 'c1' });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      rows: [['customer_id', 'customer_name'], ['1001', 'Acme'], ['1002', 'Beta']],
    });
  });

  it('reports a missing stored slot inline as { ok:false }, not a 4xx', async () => {
    const app = await startApp(factories, casesWith(null));
    server = app.server;
    const { status, body } = await post(app.baseUrl, '/introspect/local/preview-stored', { caseId: 'c1' });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('re-upload');
  });

  it('400s when caseId is missing (malformed request)', async () => {
    const app = await startApp(factories, casesWith(Buffer.from('a\n', 'utf8')));
    server = app.server;
    const { status } = await post(app.baseUrl, '/introspect/local/preview-stored', {});
    expect(status).toBe(400);
  });
});
