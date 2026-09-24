// backend/src/util/remote-fs/ftp-fs.ts
import { Client } from 'basic-ftp';
import { Writable } from 'node:stream';
import { parseCsv, countLines, PREVIEW_ROWS, MAX_PREVIEW_BYTES } from '../csv-inspect.js';
import { type FtpAccessOptions } from '../ftp-test.js';
import { classifyEntry, type ListResult, type PreviewResult, type RemoteFileSystem } from './types.js';

/**
 * Plain-FTP implementation of RemoteFileSystem over `basic-ftp` (no IRIS, same
 * shape as the SFTP reader but username/password auth over the control channel).
 * Browse needs list() + downloadTo(), which ftp-test.ts's connection-test client
 * seam does not declare — so this defines its own FtpBrowseClientLike. verbose
 * logging stays off, so no credential trace is emitted. The preview bound is the
 * SAME dual row+byte cap SFTP uses (PREVIEW_ROWS lines OR MAX_PREVIEW_BYTES,
 * whichever first) — no row-stop asymmetry.
 *
 * Failure messages follow the same split as the SFTP reader, because the user acts
 * on them differently: only a failed LOGIN says "Connection or authentication
 * failed", while a LIST or transfer that fails after a successful login says
 * `Could not read "<path>"`. Reporting an unreadable file as an auth problem would
 * send the user back to Step 1 to re-check credentials that were never the issue.
 */

const DEFAULT_FTP_PORT = 21;
const CONNECT_TIMEOUT_MS = 10_000;

export interface FtpBrowseConfig {
  host: string;
  port?: string;
  username: string;
  password?: string;
}

/** The subset of a basic-ftp FileInfo we read. */
export interface FtpFileInfo {
  name: string;
  isDirectory: boolean;
}

/** The browse subset of basic-ftp's Client (injectable for tests). */
export interface FtpBrowseClientLike {
  access(options: FtpAccessOptions): Promise<unknown>;
  list(path: string): Promise<FtpFileInfo[]>;
  downloadTo(destination: Writable, path: string): Promise<unknown>;
  close(): void;
}

export type FtpBrowseClientFactory = (timeoutMs: number) => FtpBrowseClientLike;

const defaultFactory: FtpBrowseClientFactory = (timeoutMs) =>
  new Client(timeoutMs) as unknown as FtpBrowseClientLike;

/** The message off an unknown throw, whatever the client threw. */
function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FtpFileSystem implements RemoteFileSystem {
  constructor(
    private readonly config: FtpBrowseConfig,
    private readonly factory: FtpBrowseClientFactory = defaultFactory,
  ) {}

  /** Validate + resolve the port; returns access options or an error message. */
  private access(): { options: FtpAccessOptions } | { error: string } {
    const host = this.config.host?.trim() ?? '';
    const user = this.config.username?.trim() ?? '';
    if (!host) return { error: 'Host is required.' };
    if (!user) return { error: 'Username is required.' };
    const port = this.config.port?.trim() ? Number(this.config.port) : DEFAULT_FTP_PORT;
    if (!Number.isInteger(port) || port <= 0) return { error: `invalid port "${this.config.port}".` };
    return { options: { host, port, user, password: this.config.password ?? '', secure: false } };
  }

  /**
   * Log in, hand the client to `work`, and always tear the control connection down.
   * A login/socket failure is the ONLY thing reported as an auth problem; `work`
   * owns the wording for its own operation, so a directory or file that cannot be
   * read is never mislabelled as bad credentials. Mirrors sftp-fs.ts's withSftp.
   */
  private async withClient<T>(
    options: FtpAccessOptions,
    onError: (message: string) => T,
    work: (client: FtpBrowseClientLike) => Promise<T>,
  ): Promise<T> {
    const client = this.factory(CONNECT_TIMEOUT_MS);
    try {
      try {
        await client.access(options);
      } catch (err) {
        // basic-ftp throws FTPError for a negative server reply (bad credentials)
        // and a plain Error for socket problems/timeouts — both are login failures.
        return onError(`Connection or authentication failed: ${detail(err)}`);
      }
      return await work(client);
    } finally {
      try { client.close(); } catch { /* ignore teardown errors */ }
    }
  }

  async listDir(path: string): Promise<ListResult> {
    const a = this.access();
    if ('error' in a) return { ok: false, message: `Listing failed: ${a.error}` };
    const dir = path?.trim() ? path : '/';

    return this.withClient<ListResult>(
      a.options,
      (message) => ({ ok: false, message }),
      async (client) => {
        let list;
        try {
          list = await client.list(dir);
        } catch (err) {
          // A LIST that fails after a successful login is about the DIRECTORY (gone,
          // not readable, not a directory) — name it, the way the SFTP reader does.
          return { ok: false, message: `Could not read "${dir}": ${detail(err)}` };
        }
        const entries = list
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, type: classifyEntry(e.name, e.isDirectory) }))
          .sort((x, y) => {
            if (x.type === 'folder' && y.type !== 'folder') return -1;
            if (x.type !== 'folder' && y.type === 'folder') return 1;
            return x.name.localeCompare(y.name);
          });
        return { ok: true, entries };
      },
    );
  }

  async readPreview(path: string): Promise<PreviewResult> {
    const a = this.access();
    if ('error' in a) return { ok: false, message: `Preview failed: ${a.error}` };
    if (!path?.trim()) return { ok: false, message: 'Preview failed: a file path is required.' };

    return this.withClient<PreviewResult>(
      a.options,
      (message) => ({ ok: false, message }),
      async (client) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let lines = 0;
        let aborted = false;
        const sink = new Writable({
          write: (chunk: Buffer, _enc, cb) => {
            const buf = Buffer.from(chunk);
            chunks.push(buf);
            total += buf.length;
            lines += countLines(buf.toString('utf8'));
            // Stop as soon as we have enough — SAME dual bound as SFTP: enough lines
            // OR enough bytes, whichever comes first. Never pull the whole file.
            if ((lines > PREVIEW_ROWS || total >= MAX_PREVIEW_BYTES) && !aborted) {
              aborted = true;
              try { client.close(); } catch { /* ignore */ }
            }
            cb();
          },
        });
        try {
          await client.downloadTo(sink, path);
        } catch (err) {
          // A close()-induced abort after we already have enough bytes is expected;
          // only a genuine transfer failure is reported — and it is about the FILE,
          // not the login, so it names the path rather than blaming credentials.
          if (!aborted) return { ok: false, message: `Could not read "${path}": ${detail(err)}` };
        }
        return { ok: true, rows: parseCsv(Buffer.concat(chunks).toString('utf8'), PREVIEW_ROWS) };
      },
    );
  }
}
