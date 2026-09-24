// backend/test/unit/remote-fs/ftp-fs.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import {
  FtpFileSystem,
  type FtpBrowseClientLike,
  type FtpBrowseClientFactory,
  type FtpFileInfo,
} from '../../../src/util/remote-fs/ftp-fs.js';

const goodConfig = { host: 'ftp.example.com', port: '21', username: 'ftpuser', password: 's3cret' };

function fakeFactory(
  behavior: {
    accessErr?: Error;
    list?: FtpFileInfo[];
    listErr?: Error;
    content?: string;
    /** Emit content one chunk at a time so the mid-stream abort can be exercised. */
    chunks?: string[];
    downloadErr?: Error;
    /**
     * Reject the download AFTER the client was closed mid-transfer (real basic-ftp
     * can reject `downloadTo` with an ECONNRESET when the socket is torn down under
     * it). Exercises the impl's `catch { if (!aborted) throw err }` swallow branch.
     */
    abortRejects?: Error;
  },
  spies?: { onClose?: () => void; onWrite?: (chunkCount: number) => void },
): FtpBrowseClientFactory {
  return () => {
    let closed = false;
    const client: FtpBrowseClientLike = {
      async access() { if (behavior.accessErr) throw behavior.accessErr; return {}; },
      async list() { if (behavior.listErr) throw behavior.listErr; return behavior.list ?? []; },
      async downloadTo(dest: Writable) {
        if (behavior.downloadErr) throw behavior.downloadErr;
        const parts = behavior.chunks ?? [behavior.content ?? ''];
        let written = 0;
        for (const p of parts) {
          // basic-ftp stops feeding the sink once the client connection is closed;
          // the real abort is client.close() called from inside the sink's write cb.
          // AWAIT each write so the sink's callback (which may call client.close())
          // runs before we decide to feed the next chunk. A synchronous write loop
          // would buffer every chunk before `closed` is ever set (Node keeps
          // state.writing true until nextTick when _write's cb fires sync), so the
          // abort would never be observable and this fake could not exercise it.
          if (closed) break;
          await new Promise<void>((resolve, reject) => {
            dest.write(Buffer.from(p), (err) => (err ? reject(err) : resolve()));
          });
          written++;
          spies?.onWrite?.(written);
        }
        // Real basic-ftp can reject downloadTo when the socket is torn down by an
        // abort mid-transfer; simulate that so the impl's swallow-on-abort branch runs.
        if (closed && behavior.abortRejects) throw behavior.abortRejects;
        dest.end();
        return {};
      },
      close() { closed = true; spies?.onClose?.(); },
    };
    return client;
  };
}

describe('FtpFileSystem.listDir', () => {
  it('classifies folders/csv/files, folders first then sorted, and closes', async () => {
    const onClose = vi.fn();
    const fs = new FtpFileSystem(goodConfig, fakeFactory({
      list: [
        { name: 'b.csv', isDirectory: false },
        { name: 'sub', isDirectory: true },
        { name: 'c.txt', isDirectory: false },
      ],
    }, { onClose }));
    const res = await fs.listDir('/data');
    expect(res).toEqual({
      ok: true,
      entries: [
        { name: 'sub', type: 'folder' },
        { name: 'b.csv', type: 'csv' },
        { name: 'c.txt', type: 'file' },
      ],
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports a friendly failure when login is rejected', async () => {
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ accessErr: new Error('530 Login incorrect') }));
    const res = await fs.listDir('/');
    expect(res).toEqual({
      ok: false,
      message: 'Connection or authentication failed: 530 Login incorrect',
    });
  });

  it('blames the DIRECTORY, not the credentials, when LIST fails after a good login', async () => {
    // The login succeeded, so "Connection or authentication failed" would send the
    // user back to Step 1 to re-check credentials that were never the problem.
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ listErr: new Error('550 No such directory') }));
    const res = await fs.listDir('/nope');
    expect(res).toEqual({ ok: false, message: 'Could not read "/nope": 550 No such directory' });
    if (!res.ok) expect(res.message).not.toContain('authentication');
  });

  it('closes the connection even when LIST fails', async () => {
    const onClose = vi.fn();
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ listErr: new Error('boom') }, { onClose }));
    await fs.listDir('/data');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fails fast when the host is missing (no client built)', async () => {
    const built = vi.fn(fakeFactory({}));
    const res = await new FtpFileSystem({ ...goodConfig, host: '' }, built).listDir('/');
    expect(res.ok).toBe(false);
    expect(built).not.toHaveBeenCalled();
  });
});

describe('FtpFileSystem.readPreview', () => {
  it('downloads a bounded slice and returns raw rows', async () => {
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ content: 'a,b\n1,2\n3,4\n' }));
    const res = await fs.readPreview('/data/x.csv');
    expect(res).toEqual({ ok: true, rows: [['a', 'b'], ['1', '2'], ['3', '4']] });
  });

  it('bounds the transfer: stops feeding after PREVIEW_ROWS lines and never reads the whole file (abort path)', async () => {
    // 20 one-row chunks; the reader should abort well before the 20th. The sink's
    // write cb trips at line 7 (> PREVIEW_ROWS 6), calls client.close(), and the
    // fake stops feeding. onWrite counts how many chunks were actually pushed.
    const onClose = vi.fn();
    const onWrite = vi.fn();
    const chunks = Array.from({ length: 20 }, (_, i) => `r${i},v${i}\n`);
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ chunks }, { onClose, onWrite }));
    const res = await fs.readPreview('/data/big.csv');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows.length).toBe(6); // PREVIEW_ROWS — parseCsv's upper bound
      expect(res.rows[0]).toEqual(['r0', 'v0']);
    }
    // The abort MUST be what stops the read: close() from inside the sink halts the
    // fake's feed, so far fewer than all 20 chunks are written. Without the abort the
    // fake feeds all 20 and rows.length===6 still holds (parseCsv truncates), so that
    // check alone would false-green.
    expect(onWrite.mock.calls.length).toBeLessThan(chunks.length);
    expect(onClose).toHaveBeenCalled(); // aborted, then torn down
  });

  it('swallows a download rejection caused by the abort and still returns the bounded rows', async () => {
    // basic-ftp can reject downloadTo with a socket error when the abort tears the
    // connection down. Once we already have enough bytes (aborted), that rejection
    // is expected — the impl swallows it (`if (!aborted) throw`) and returns the
    // prefix. This exercises the swallow branch, not just the resolve-after-abort path.
    const chunks = Array.from({ length: 20 }, (_, i) => `r${i},v${i}\n`);
    const fs = new FtpFileSystem(
      goodConfig,
      fakeFactory({ chunks, abortRejects: new Error('ECONNRESET: socket closed') }),
    );
    const res = await fs.readPreview('/data/big.csv');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows.length).toBe(6); // bounded prefix, rejection swallowed
  });

  it('blames the FILE, not the credentials, when the transfer fails after a good login', async () => {
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ downloadErr: new Error('550 Not found') }));
    const res = await fs.readPreview('/data/missing.csv');
    expect(res).toEqual({ ok: false, message: 'Could not read "/data/missing.csv": 550 Not found' });
    if (!res.ok) expect(res.message).not.toContain('authentication');
  });

  it('still reports a rejected LOGIN as an auth failure (the one case that is)', async () => {
    const fs = new FtpFileSystem(goodConfig, fakeFactory({ accessErr: new Error('530 Login incorrect') }));
    const res = await fs.readPreview('/data/x.csv');
    expect(res).toEqual({
      ok: false,
      message: 'Connection or authentication failed: 530 Login incorrect',
    });
  });

  it('fails fast when the path is blank', async () => {
    const res = await new FtpFileSystem(goodConfig, fakeFactory({})).readPreview('   ');
    expect(res.ok).toBe(false);
  });
});
