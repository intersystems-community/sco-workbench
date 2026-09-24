import { describe, it, expect, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  createIntegrationCaseRouter,
  decryptCasePasswords,
} from '../../src/server/integration-case-routes.js';
import { IntegrationCaseRepository } from '../../src/db/integration-cases.js';
import { PendingUploadStore } from '../../src/server/upload-store.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';

function startApp(): { server: Server; base: string; repo: IntegrationCaseRepository; store: PendingUploadStore } {
  const app: Express = express();
  app.use(express.json());
  const repo = new IntegrationCaseRepository(openDatabase(':memory:'));
  const store = new PendingUploadStore();
  app.use('/api/data-integration/cases', createIntegrationCaseRouter(repo, store));
  app.use(errorEnvelope(false));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, repo, store };
}

async function req(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const SENTINEL = '__saved__';

describe('integration-case routes', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('encrypts passwords at rest, redacts them on read, and keeps everything else', async () => {
    const app = startApp();
    server = app.server;

    const caseObj = {
      id: 'job1',
      name: 'My SQL',
      sourceType: 'database',
      source: { type: 'database', dbDsn: 'jdbc:IRIS://h:1972/SC', dbUsername: 'u', dbPassword: 'secret-pw' },
      targetClass: 'BOM',
    };
    const saved = await req(app.base, 'POST', '/api/data-integration/cases/save', { case: caseObj });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, id: 'job1', status: 'draft' });

    // At rest: the password is encrypted, not the plaintext.
    const stored = app.repo.get('job1')!;
    expect((stored.definition.source as any).dbPassword).not.toBe('secret-pw');
    expect((stored.definition.source as any).dbPassword.startsWith('gcm:')).toBe(true);
    // Non-secret fields are untouched.
    expect((stored.definition.source as any).dbDsn).toBe('jdbc:IRIS://h:1972/SC');
    expect(stored.definition.targetClass).toBe('BOM');

    // On read (GET): the password is the sentinel, never the plaintext or ciphertext.
    const got = await req(app.base, 'GET', '/api/data-integration/cases/job1');
    expect(got.body.case.definition.source.dbPassword).toBe(SENTINEL);
    expect(got.body.case.definition.source.dbUsername).toBe('u');

    // Decryption recovers the original plaintext (deploy path).
    const decrypted = decryptCasePasswords(stored);
    expect((decrypted.definition.source as any).dbPassword).toBe('secret-pw');
  });

  it('keeps the stored ciphertext when a save echoes the sentinel (password not retyped)', async () => {
    const app = startApp();
    server = app.server;

    await req(app.base, 'POST', '/api/data-integration/cases/save', {
      case: { id: 'job1', name: 'n', source: { type: 'ftp', ftpPassword: 'orig' } },
    });
    const first = (app.repo.get('job1')!.definition.source as any).ftpPassword;

    // Re-save with the sentinel (user edited another field, left password alone).
    await req(app.base, 'POST', '/api/data-integration/cases/save', {
      case: { id: 'job1', name: 'n2', source: { type: 'ftp', ftpPassword: SENTINEL } },
    });
    const second = (app.repo.get('job1')!.definition.source as any).ftpPassword;
    expect(second).toBe(first); // unchanged ciphertext
    expect(decryptCasePasswords(app.repo.get('job1')!).definition.source as any).toMatchObject({ ftpPassword: 'orig' });
  });

  it('refuses to delete a deployed case (409) but allows deleting a draft', async () => {
    const app = startApp();
    server = app.server;

    await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { id: 'job1', name: 'n', source: {} } });
    app.repo.setStatus('job1', 'deployed');
    const blocked = await req(app.base, 'DELETE', '/api/data-integration/cases/job1');
    expect(blocked.status).toBe(409);
    expect(app.repo.get('job1')).not.toBeNull();

    await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { id: 'job2', name: 'n', source: {} } });
    const ok = await req(app.base, 'DELETE', '/api/data-integration/cases/job2');
    expect(ok.status).toBe(200);
    expect(app.repo.get('job2')).toBeNull();
  });

  it('keeps a deployed case deployed when a re-save changes NOTHING', async () => {
    // Pressing Save on a wizard step without editing anything must not demote it: what
    // is stored is still exactly what is live in SCO.
    const app = startApp();
    server = app.server;
    await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { id: 'job1', name: 'n', source: {} } });
    app.repo.setStatus('job1', 'deployed');
    const resaved = await req(app.base, 'POST', '/api/data-integration/cases/save', {
      case: { id: 'job1', name: 'n', source: {} },
    });
    expect(resaved.body.status).toBe('deployed');
  });

  /**
   * A `deployed` status asserts that the STORED definition is what is live in SCO, so a
   * save that changes the definition invalidates that claim — the case goes back to
   * draft and the UI's badge follows. `everDeployed` is the separate, permanent fact
   * ("its classes exist in SCO") that keeps the delete guard honest afterwards.
   */
  describe('a save that CHANGES a deployed case', () => {
    /** Deploy job1 through the real status route, so everDeployed is stamped as it is
     *  in production (rather than poking the repository). */
    async function deployed(app: ReturnType<typeof startApp>, def: Record<string, unknown>) {
      await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { id: 'job1', name: 'n', ...def } });
      await req(app.base, 'POST', '/api/data-integration/cases/job1/status', { status: 'deployed' });
    }

    it('demotes it to draft when the definition changes', async () => {
      const app = startApp();
      server = app.server;
      await deployed(app, { source: { type: 'ftp', ftpHost: 'a.example.com' } });

      const resaved = await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { id: 'job1', name: 'n', source: { type: 'ftp', ftpHost: 'b.example.com' } },
      });

      expect(resaved.body.status).toBe('draft');
      expect(app.repo.get('job1')?.status).toBe('draft');
    });

    it('demotes it when only the NAME changes', async () => {
      const app = startApp();
      server = app.server;
      await deployed(app, { source: {} });

      const resaved = await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { id: 'job1', name: 'renamed', source: {} },
      });

      expect(resaved.body.status).toBe('draft');
    });

    it('is NOT fooled by a different key order (that is the same definition)', async () => {
      // Otherwise a client that merely built the object differently would demote a
      // deployed case on every save.
      const app = startApp();
      server = app.server;
      await deployed(app, { sourceType: 'ftp', targetClass: 'BOM', source: { type: 'ftp', ftpHost: 'a' } });

      const resaved = await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { targetClass: 'BOM', source: { ftpHost: 'a', type: 'ftp' }, name: 'n', sourceType: 'ftp', id: 'job1' },
      });

      expect(resaved.body.status).toBe('deployed');
    });

    it('STILL refuses to delete it — its classes are live in SCO', async () => {
      // The whole reason everDeployed exists: the demotion must not open a way to
      // orphan the generated classes and production hosts.
      const app = startApp();
      server = app.server;
      await deployed(app, { source: { type: 'ftp', ftpHost: 'a' } });
      await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { id: 'job1', name: 'n', source: { type: 'ftp', ftpHost: 'b' } },
      });
      expect(app.repo.get('job1')?.status).toBe('draft');

      const blocked = await req(app.base, 'DELETE', '/api/data-integration/cases/job1');

      expect(blocked.status).toBe(409);
      expect(app.repo.get('job1')).not.toBeNull();
    });

    it('reports everDeployed to the client, and a client cannot forge or clear it', async () => {
      const app = startApp();
      server = app.server;
      // Forged on the way in: a case that was never deployed must not become
      // undeletable just because the browser said so.
      await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { id: 'job2', name: 'n', source: {}, everDeployed: true },
      });
      expect(app.repo.get('job2')?.definition?.everDeployed).toBeUndefined();
      expect((await req(app.base, 'DELETE', '/api/data-integration/cases/job2')).status).toBe(200);

      // Cleared on the way in: a deployed case stays marked.
      await deployed(app, { source: {} });
      await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { id: 'job1', name: 'n', source: {}, everDeployed: false },
      });
      expect(app.repo.get('job1')?.definition?.everDeployed).toBe(true);
      const read = await req(app.base, 'GET', '/api/data-integration/cases/job1');
      expect(read.body.case.definition.everDeployed).toBe(true);
    });

    it('a case that was never deployed simply stays a draft', async () => {
      const app = startApp();
      server = app.server;
      await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { id: 'job1', name: 'n', source: {} } });
      const resaved = await req(app.base, 'POST', '/api/data-integration/cases/save', {
        case: { id: 'job1', name: 'n', source: { type: 'ftp' } },
      });
      expect(resaved.body.status).toBe('draft');
      expect(app.repo.get('job1')?.definition?.everDeployed).toBeUndefined();
    });
  });

  it('persists an uploaded file (secret slot → encrypted at rest) and lists it on GET', async () => {
    const app = startApp();
    server = app.server;
    await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { id: 'job1', name: 'n', source: {} } });

    // Seed a pending upload as the upload router would.
    app.store.set({
      fileId: 'f1',
      originalName: 'id_rsa',
      kind: 'ssh-key',
      irisPath: '/tmp/keys/f1_id_rsa',
      secret: true,
      bytes: Buffer.from('PRIVATE-KEY-BYTES'),
      addedAt: Date.now(),
    });

    const persisted = await req(app.base, 'POST', '/api/data-integration/cases/job1/files', {
      slot: 'privateKey',
      fileId: 'f1',
    });
    expect(persisted.status).toBe(200);

    // Stored encrypted (secret slot); metadata surfaces on GET.
    const stored = app.repo.getFileBytes('f1')!;
    expect(stored.encrypted).toBe(true);
    expect(stored.bytes.equals(Buffer.from('PRIVATE-KEY-BYTES'))).toBe(false);

    const got = await req(app.base, 'GET', '/api/data-integration/cases/job1');
    expect(got.body.files).toHaveLength(1);
    expect(got.body.files[0]).toMatchObject({ slot: 'privateKey', kind: 'ssh-key', originalName: 'id_rsa', encrypted: true });
  });

  it('rejects a save without an id', async () => {
    const app = startApp();
    server = app.server;
    const res = await req(app.base, 'POST', '/api/data-integration/cases/save', { case: { name: 'no id' } });
    expect(res.status).toBe(400);
  });
});
