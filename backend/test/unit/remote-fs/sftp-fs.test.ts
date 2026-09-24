import { describe, it, expect, vi } from 'vitest';
import {
  SftpFileSystem,
  type SshClientLike,
  type SshClientFactory,
  type SftpSessionLike,
  type ReadStreamLike,
} from '../../../src/util/remote-fs/sftp-fs.js';

const goodConfig = {
  host: 'ec2-1-2-3-4.compute.amazonaws.com',
  port: '22',
  username: 'ec2-user',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
};

/** A fake dir entry matching the subset of ssh2's readdir shape we read. */
function entry(filename: string, isDir: boolean) {
  return { filename, attrs: { isDirectory: () => isDir } };
}

/**
 * Build a fake ssh2 Client. `behavior` scripts the session:
 *  - connectEvent: 'ready' | 'error' fired on connect() (async, like the real one)
 *  - sftpErr: opening the SFTP subsystem fails
 *  - dir: readdir result (list or an error)
 *  - file: a read stream that emits these chunks then ends (or errors)
 */
function fakeFactory(
  behavior: {
    connectEvent?: 'ready' | 'error';
    connectError?: Error;
    sftpErr?: Error;
    dir?: { list?: ReturnType<typeof entry>[]; err?: Error };
    file?: { chunks?: string[]; err?: Error };
  },
  spies?: { onEnd?: () => void; onConnect?: () => void },
): SshClientFactory {
  return () => {
    const listeners: Record<string, (arg?: unknown) => void> = {};

    const stream: ReadStreamLike = {
      on(event: string, listener: (arg?: any) => void) {
        queueMicrotask(() => {
          if (event === 'error' && behavior.file?.err) listener(behavior.file.err);
          if (event === 'data' && !behavior.file?.err) {
            for (const c of behavior.file?.chunks ?? []) listener(Buffer.from(c));
          }
          if (event === 'end' && !behavior.file?.err) listener();
        });
        return this;
      },
      destroy() {},
    } as ReadStreamLike;

    const sftp: SftpSessionLike = {
      readdir(_path, cb) {
        cb(behavior.dir?.err, behavior.dir?.list ?? []);
      },
      createReadStream() {
        return stream;
      },
    };

    const client: SshClientLike = {
      on(event, listener) {
        listeners[event] = listener;
        return this;
      },
      connect() {
        spies?.onConnect?.();
        queueMicrotask(() => {
          if ((behavior.connectEvent ?? 'ready') === 'error') listeners.error?.(behavior.connectError ?? new Error('failed'));
          else listeners.ready?.();
        });
      },
      sftp(cb) {
        cb(behavior.sftpErr, sftp);
      },
      end() {
        spies?.onEnd?.();
      },
    };
    return client;
  };
}

describe('SftpFileSystem.listDir', () => {
  it('lists entries (folders first, then sorted), classifying csv vs file, and ends the connection', async () => {
    const onEnd = vi.fn();
    const fs = new SftpFileSystem(goodConfig, fakeFactory(
      { dir: { list: [entry('data.csv', false), entry('sub', true), entry('notes.txt', false), entry('archive', true)] } },
      { onEnd },
    ));
    const result = await fs.listDir('/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([
        { name: 'archive', type: 'folder' },
        { name: 'sub', type: 'folder' },
        { name: 'data.csv', type: 'csv' },
        { name: 'notes.txt', type: 'file' },
      ]);
    }
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('hides dotfiles', async () => {
    const fs = new SftpFileSystem(
      goodConfig,
      fakeFactory({ dir: { list: [entry('.bashrc', false), entry('real.csv', false)] } }),
    );
    const result = await fs.listDir('/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.map((e) => e.name)).toEqual(['real.csv']);
  });

  it('reports a friendly failure when auth/connection errors', async () => {
    const fs = new SftpFileSystem(
      goodConfig,
      fakeFactory({ connectEvent: 'error', connectError: new Error('auth failed') }),
    );
    const result = await fs.listDir('/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Connection or authentication failed/);
  });

  it('reports a readdir failure', async () => {
    const fs = new SftpFileSystem(
      goodConfig,
      fakeFactory({ dir: { err: new Error('No such file') } }),
    );
    const result = await fs.listDir('/nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('No such file');
  });

  it('fails fast when the private key is missing (no connection attempt)', async () => {
    const onConnect = vi.fn();
    const fs = new SftpFileSystem({ ...goodConfig, privateKey: '' }, fakeFactory({}, { onConnect }));
    const result = await fs.listDir('/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/private key file is required/);
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('SftpFileSystem.readPreview', () => {
  it('returns raw rows read from the file stream and ends the connection', async () => {
    const onEnd = vi.fn();
    const fs = new SftpFileSystem(goodConfig, fakeFactory(
      { file: { chunks: ['id,name\n', '1,Acme\n', '2,Beta\n'] } },
      { onEnd },
    ));
    const result = await fs.readPreview('/data.csv');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toEqual([
        ['id', 'name'],
        ['1', 'Acme'],
        ['2', 'Beta'],
      ]);
    }
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('reports a stream error as a friendly failure', async () => {
    const fs = new SftpFileSystem(
      goodConfig,
      fakeFactory({ file: { err: new Error('permission denied') } }),
    );
    const result = await fs.readPreview('/data.csv');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('permission denied');
  });

  it('fails fast when the path is missing (no connection attempt)', async () => {
    const onConnect = vi.fn();
    const fs = new SftpFileSystem(goodConfig, fakeFactory({}, { onConnect }));
    const result = await fs.readPreview('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/file path is required/);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
