import { describe, it, expect, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createUploadRouter } from '../../src/server/upload-routes.js';
import { PendingUploadStore } from '../../src/server/upload-store.js';
import { IntegrationCaseRepository } from '../../src/db/integration-cases.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import type { IrisServices } from '../../src/iris/index.js';
import type { Env } from '../../src/config/env.js';

/** Records every native call the router drives through file-ops. */
interface FakeCalls {
  streamFilenames: string[];
  writes: number;
  saves: number;
  deletes: string[];
  /** irisPath → the exact bytes staged (reconstructed from the Base64Decode/Write calls). */
  written: Record<string, string>;
}

/**
 * Fake IrisServices whose `native` handles the exact call set file-ops uses:
 * %Stream.FileBinary.%New (→ a fake oref), CreateDirectoryChain, Base64Decode,
 * SetUMask, Delete. `failSaveFor` forces %Save to fail for a given irisPath so we
 * can assert per-file error results.
 */
function fakeIris(opts?: { failSave?: boolean; failSaveForNameContaining?: string }): { iris: IrisServices; calls: FakeCalls } {
  const calls: FakeCalls = { streamFilenames: [], writes: 0, saves: 0, deletes: [], written: {} };
  let currentFilename = '';

  const streamObj = {
    invokeString: (method: string, ...args: unknown[]) => {
      if (method === 'FilenameSet') {
        currentFilename = String(args[0]);
        calls.streamFilenames.push(currentFilename);
        return '1';
      }
      if (method === 'Write') {
        calls.writes += 1;
        // file-ops passes the Base64Decode result (see native.callValue below,
        // which returns the real decoded text) straight into Write — accumulate it
        // so tests can assert the EXACT bytes staged into IRIS.
        calls.written[currentFilename] = (calls.written[currentFilename] ?? '') + String(args[0]);
        return '1';
      }
      if (method === '%Save') {
        calls.saves += 1;
        const failByName = opts?.failSaveForNameContaining && currentFilename.includes(opts.failSaveForNameContaining);
        return opts?.failSave || failByName ? '0 save-failed' : '1';
      }
      return '1';
    },
  };

  const iris = {
    namespace: 'SC',
    close: () => {},
    native: {
      callValue: (_cls: string, method: string, ...args: unknown[]) => {
        if (method === 'CreateDirectoryChain') return 1;
        // Decode for real so `calls.written` reconstructs the exact staged bytes.
        if (method === 'Base64Decode') return Buffer.from(String(args[0]), 'base64').toString('utf8');
        if (method === 'SetUMask') return 18;
        if (method === 'Delete') {
          calls.deletes.push(String(args[0]));
          return 1;
        }
        if (method === 'GetErrorText') return 'ERROR #5001: save-failed';
        return undefined;
      },
      callObject: (cls: string, method: string) =>
        cls === '%Stream.FileBinary' && method === '%New' ? streamObj : null,
      decodeStatus: (status: unknown) =>
        status === '1' || status === 1 ? { ok: true, text: 'OK' } : { ok: false, text: 'ERROR #5001: save-failed' },
    },
  } as unknown as IrisServices;

  return { iris, calls };
}

const ENV = {
  SCO_UPLOAD_CSV_DIR: '/tmp/sco/csv',
  SCO_UPLOAD_KEY_DIR: '/tmp/sco/keys',
} as unknown as Env;

function startApp(iris: IrisServices): { server: Server; base: string } {
  const app: Express = express();
  app.use(express.json());
  const cases = new IntegrationCaseRepository(openDatabase(':memory:'));
  app.use('/api/data-integration/uploads', createUploadRouter(iris, ENV, new PendingUploadStore(), cases));
  app.use(errorEnvelope(false));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** POST a file as multipart/form-data via fetch + FormData. */
async function postUpload(base: string, name: string, kind: string, content = 'a,b,c\n1,2,3\n') {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([content], { type: 'text/plain' }), name);
  const res = await fetch(`${base}/api/data-integration/uploads`, { method: 'POST', body: fd });
  return { status: res.status, body: (await res.json()) as any };
}

async function postJson(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('upload routes', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('accepts a CSV upload and returns a path under the CSV dir', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postUpload(started.base, 'customers.csv', 'csv');
    expect(status).toBe(200);
    expect(body.fileId).toBeTruthy();
    expect(body.kind).toBe('csv');
    expect(body.irisPath).toMatch(/^\/tmp\/sco\/csv\/[0-9a-f-]+_customers\.csv$/);
    expect(body.originalName).toBe('customers.csv');
  });

  it('routes an ssh-key upload to the KEY dir', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { body } = await postUpload(started.base, 'id_rsa.pem', 'ssh-key', 'KEYDATA');
    expect(body.kind).toBe('ssh-key');
    expect(body.irisPath).toMatch(/^\/tmp\/sco\/keys\/[0-9a-f-]+_id_rsa\.pem$/);
  });

  it('accepts any file extension (e.g. a .pem.pub key), not just an allowlist', async () => {
    // Key/credential material comes in many extensions (.pem.pub, .crt, .p8, or
    // none), so uploads are gated by size + filename sanitization, not by type.
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postUpload(started.base, 'SC-Dev-1.pem.pub', 'ssh-key', 'ssh-rsa AAAA');
    expect(status).toBe(200);
    expect(body.kind).toBe('ssh-key');
    expect(body.irisPath).toMatch(/^\/tmp\/sco\/keys\/[0-9a-f-]+_SC-Dev-1\.pem\.pub$/);
  });

  it('sanitizes a traversal-style filename into a single safe segment', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { body } = await postUpload(started.base, '../../etc/passwd.csv', 'csv');
    // No path parts survive; the name is confined under the CSV dir.
    expect(body.irisPath).toMatch(/^\/tmp\/sco\/csv\/[0-9a-f-]+_[A-Za-z0-9._-]+$/);
    expect(body.irisPath).not.toContain('..');
    expect(body.irisPath).not.toContain('/etc/');
  });

  it('materializes an uploaded file into IRIS and reports ok', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const up = await postUpload(started.base, 'data.csv', 'csv');
    const { status, body } = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [up.body.fileId],
    });
    expect(status).toBe(200);
    expect(body.results).toEqual([{ fileId: up.body.fileId, irisPath: up.body.irisPath, ok: true }]);
    expect(calls.streamFilenames).toContain(up.body.irisPath);
    expect(calls.saves).toBe(1);
  });

  it('reports ok:false with a message for an unknown/expired fileId (no throw)', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: ['does-not-exist'],
    });
    expect(status).toBe(200);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/re-upload/i);
  });

  it('reports ok:false when the IRIS save fails, without failing the request', async () => {
    const { iris } = fakeIris({ failSave: true });
    const started = startApp(iris);
    server = started.server;

    const up = await postUpload(started.base, 'data.csv', 'csv');
    const { status, body } = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [up.body.fileId],
    });
    expect(status).toBe(200);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/#5001/);
  });

  it('rejects a materialize with a non-array body as 400', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { status, body } = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: 'nope',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION');
  });

  it('cleanup deletes from IRIS and forgets the file', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const up = await postUpload(started.base, 'data.csv', 'csv');
    // Materialize first so there is something to delete.
    await postJson(started.base, '/api/data-integration/uploads/materialize', { fileIds: [up.body.fileId] });
    const { status, body } = await postJson(started.base, '/api/data-integration/uploads/materialize/cleanup', {
      fileIds: [up.body.fileId],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls.deletes).toContain(up.body.irisPath);

    // After cleanup the file is forgotten: re-materializing reports unknown.
    const again = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [up.body.fileId],
    });
    expect(again.body.results[0].ok).toBe(false);
  });

  it('rolls back the file that landed when another file in the batch fails (no orphan)', async () => {
    // Fail %Save only for the key file; the CSV lands first, then must be rolled back.
    const { iris, calls } = fakeIris({ failSaveForNameContaining: 'id_rsa' });
    const started = startApp(iris);
    server = started.server;

    const csv = await postUpload(started.base, 'data.csv', 'csv');
    const key = await postUpload(started.base, 'id_rsa.pem', 'ssh-key', 'KEYDATA');
    const { status, body } = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [csv.body.fileId, key.body.fileId],
    });
    expect(status).toBe(200);
    // Both reported not-ok: the key failed, the CSV was rolled back.
    expect(body.results.every((r: any) => !r.ok)).toBe(true);
    expect(body.results.find((r: any) => r.fileId === csv.body.fileId).error).toMatch(/rolled back/i);
    // The CSV that landed was deleted from IRIS (no orphan).
    expect(calls.deletes).toContain(csv.body.irisPath);
  });

  it('a rolled-back batch stays retryable (buffers not released on failure)', async () => {
    const { iris } = fakeIris({ failSaveForNameContaining: 'id_rsa' });
    const started = startApp(iris);
    server = started.server;

    const csv = await postUpload(started.base, 'data.csv', 'csv');
    const key = await postUpload(started.base, 'id_rsa.pem', 'ssh-key', 'KEYDATA');
    await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [csv.body.fileId, key.body.fileId],
    });
    // Retry the CSV alone — its buffer was NOT released by the failed batch, so it materializes now.
    const retry = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [csv.body.fileId],
    });
    expect(retry.body.results[0].ok).toBe(true);
  });

  it('releases buffers on full success: re-materializing a succeeded file reports unknown', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const up = await postUpload(started.base, 'data.csv', 'csv');
    const first = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [up.body.fileId],
    });
    expect(first.body.results[0].ok).toBe(true);
    // Buffer released → a second materialize can't re-write it (must re-upload).
    const second = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [up.body.fileId],
    });
    expect(second.body.results[0].ok).toBe(false);
    expect(second.body.results[0].error).toMatch(/re-upload/i);

    // But cleanup can still delete it from IRIS (metadata entry retained).
    const del = await postJson(started.base, '/api/data-integration/uploads/materialize/cleanup', {
      fileIds: [up.body.fileId],
    });
    expect(del.body.ok).toBe(true);
  });

  it('routes an aws-cred upload to the KEY dir (secret, 0600)', async () => {
    const { iris } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const { body } = await postUpload(started.base, 'AWSCredentials', 'aws-cred', '[default]\naws_access_key_id=A\naws_secret_access_key=B\n');
    expect(body.kind).toBe('aws-cred');
    expect(body.irisPath).toMatch(/^\/tmp\/sco\/keys\/[0-9a-f-]+_AWSCredentials$/);
  });

  it('rewrites a named-profile aws-cred file to a [default] profile on materialize', async () => {
    // The IRIS S3 adapter only reads [default]; a file whose sole profile is named
    // must be normalized when staged, or deploy fails with "No AWS profile named 'default'".
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const original = '[590184001786_AWS-CloudTeam-Write]\naws_access_key_id=AKIAEXAMPLE\naws_secret_access_key=SECRETVALUE\naws_session_token=TOKENVALUE\n';
    const up = await postUpload(started.base, 'AWSCredentials', 'aws-cred', original);
    const { body } = await postJson(started.base, '/api/data-integration/uploads/materialize', {
      fileIds: [up.body.fileId],
    });
    expect(body.results[0].ok).toBe(true);

    const staged = calls.written[up.body.irisPath];
    expect(staged).toContain('[default]');
    expect(staged).not.toContain('590184001786');
    expect(staged).toContain('aws_access_key_id=AKIAEXAMPLE');
    expect(staged).toContain('aws_secret_access_key=SECRETVALUE');
    expect(staged).toContain('aws_session_token=TOKENVALUE');
  });

  it('leaves an already-[default] aws-cred file byte-for-byte unchanged', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const original = '[default]\naws_access_key_id=AKIAEXAMPLE\naws_secret_access_key=SECRETVALUE\n';
    const up = await postUpload(started.base, 'AWSCredentials', 'aws-cred', original);
    await postJson(started.base, '/api/data-integration/uploads/materialize', { fileIds: [up.body.fileId] });
    expect(calls.written[up.body.irisPath]).toBe(original);
  });

  it('stages an SSH key (kind "key") verbatim — never parsed or rewritten', async () => {
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA...\n-----END OPENSSH PRIVATE KEY-----\n';
    const up = await postUpload(started.base, 'id_ed25519', 'ssh-key', key);
    await postJson(started.base, '/api/data-integration/uploads/materialize', { fileIds: [up.body.fileId] });
    expect(calls.written[up.body.irisPath]).toBe(key);
  });

  it('trusts the label: an INI-looking file uploaded as "key" is NOT normalized', async () => {
    // We key normalization off the frontend's kind, not content — so a file that
    // parses as AWS creds but was labeled a plain key is staged verbatim.
    const { iris, calls } = fakeIris();
    const started = startApp(iris);
    server = started.server;

    const looksLikeCreds = '[some_profile]\naws_access_key_id=AKIAX\naws_secret_access_key=SEC\n';
    const up = await postUpload(started.base, 'weird.key', 'ssh-key', looksLikeCreds);
    await postJson(started.base, '/api/data-integration/uploads/materialize', { fileIds: [up.body.fileId] });
    expect(calls.written[up.body.irisPath]).toBe(looksLikeCreds);
  });
});
