// backend/src/util/remote-fs/sftp-fs.ts
import { Client, type ConnectConfig } from 'ssh2';
import { parseCsv, countLines, PREVIEW_ROWS, MAX_PREVIEW_BYTES } from '../csv-inspect.js';
import { classifyEntry, type ListResult, type PreviewResult, type RemoteFileSystem } from './types.js';

/**
 * SFTP implementation of RemoteFileSystem. Connects DIRECTLY to a plain SSH/SFTP
 * server with `ssh2` — no IRIS involvement. Key-based auth: the frontend sends the
 * private key (.pem) CONTENTS in the request body; we authenticate and never store
 * or log it. Two short-lived operations: listDir (readdir + classify) and
 * readPreview (bounded stream → RAW rows). Header interpretation + typing are added
 * at the route layer in Part 2, so this stays a thin reader.
 * (Folded in from the former util/sftp-browse.ts; parseCsv now lives in csv-inspect.)
 */

export interface SftpBrowseConfig {
  host: string;
  port?: string;
  username: string;
  /** Private key (.pem) file CONTENTS — used only for this request, never stored. */
  privateKey: string;
}

const DEFAULT_SFTP_PORT = 22;
const CONNECT_TIMEOUT_MS = 10_000;

export interface ReadStreamLike {
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end' | 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  destroy(): void;
}

export interface SftpSessionLike {
  readdir(
    path: string,
    cb: (err: Error | undefined, list: Array<{ filename: string; attrs: { isDirectory(): boolean } }>) => void,
  ): void;
  createReadStream(path: string): ReadStreamLike;
}

export interface SshClientLike {
  on(event: 'ready' | 'error', listener: (arg?: unknown) => void): this;
  connect(cfg: ConnectConfig): void;
  sftp(cb: (err: Error | undefined, sftp: SftpSessionLike) => void): void;
  end(): void;
}

export type SshClientFactory = () => SshClientLike;
const defaultFactory: SshClientFactory = () => new Client() as unknown as SshClientLike;

function validate(config: SftpBrowseConfig): { port: number } | { error: string } {
  if (!config.host?.trim()) return { error: 'Host is required.' };
  if (!config.username?.trim()) return { error: 'Username is required.' };
  if (!config.privateKey?.trim()) return { error: 'a private key file is required.' };
  const port = config.port?.trim() ? Number(config.port) : DEFAULT_SFTP_PORT;
  if (!Number.isInteger(port) || port <= 0) return { error: `invalid port "${config.port}".` };
  return { port };
}

export class SftpFileSystem implements RemoteFileSystem {
  constructor(
    private readonly config: SftpBrowseConfig,
    private readonly factory: SshClientFactory = defaultFactory,
  ) {}

  /** Open an SFTP session, hand it to `work`, always tear the connection down. */
  private withSftp<T>(
    port: number,
    onError: (message: string) => T,
    work: (sftp: SftpSessionLike, done: (result: T) => void) => void,
  ): Promise<T> {
    const config = this.config;
    const factory = this.factory;
    return new Promise<T>((resolve) => {
      const conn = factory();
      let settled = false;
      const done = (result: T) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch { /* ignore teardown errors */ }
        resolve(result);
      };
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { done(onError(`opening SFTP failed: ${err.message}`)); return; }
          work(sftp, done);
        });
      });
      conn.on('error', (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        done(onError(`Connection or authentication failed: ${detail}`));
      });
      conn.connect({
        host: config.host.trim(),
        port,
        username: config.username.trim(),
        privateKey: config.privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
      });
    });
  }

  listDir(path: string): Promise<ListResult> {
    const v = validate(this.config);
    if ('error' in v) return Promise.resolve({ ok: false, message: `Listing failed: ${v.error}` });
    const dir = path?.trim() ? path : '/';
    return this.withSftp<ListResult>(
      v.port,
      (message) => ({ ok: false, message }),
      (sftp, done) => {
        sftp.readdir(dir, (err, list) => {
          if (err) { done({ ok: false, message: `Could not read "${dir}": ${err.message}` }); return; }
          const entries = (list ?? [])
            .filter((e) => !e.filename.startsWith('.'))
            .map((e) => ({ name: e.filename, type: classifyEntry(e.filename, e.attrs.isDirectory()) }))
            .sort((a, b) => {
              if (a.type === 'folder' && b.type !== 'folder') return -1;
              if (a.type !== 'folder' && b.type === 'folder') return 1;
              return a.name.localeCompare(b.name);
            });
          done({ ok: true, entries });
        });
      },
    );
  }

  readPreview(path: string): Promise<PreviewResult> {
    const v = validate(this.config);
    if ('error' in v) return Promise.resolve({ ok: false, message: `Preview failed: ${v.error}` });
    if (!path?.trim()) return Promise.resolve({ ok: false, message: 'Preview failed: a file path is required.' });
    return this.withSftp<PreviewResult>(
      v.port,
      (message) => ({ ok: false, message }),
      (sftp, done) => {
        let stream: ReadStreamLike;
        try {
          stream = sftp.createReadStream(path);
        } catch (e) {
          done({ ok: false, message: `Could not open "${path}": ${(e as Error).message}` });
          return;
        }
        let buf = '';
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          try { stream.destroy(); } catch { /* ignore */ }
          done({ ok: true, rows: parseCsv(buf, PREVIEW_ROWS) });
        };
        stream.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (buf.length >= MAX_PREVIEW_BYTES || countLines(buf) > PREVIEW_ROWS) complete();
        });
        stream.on('end', complete);
        stream.on('close', complete);
        stream.on('error', (err: Error) => {
          if (finished) return;
          finished = true;
          done({ ok: false, message: `Could not read "${path}": ${err.message}` });
        });
      },
    );
  }
}
