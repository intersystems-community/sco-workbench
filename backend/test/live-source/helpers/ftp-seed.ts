/**
 * Fixture writer for the real FTP server.
 *
 * Same reasoning as `sftp-seed.ts`: the product's FTP seam is read-only, so seeding
 * needs its own client, and the shared drop directory means this run writes into its
 * own subdirectory (`<dir>/<RUN_KEY>/`) so `removeDir` is a complete teardown and
 * concurrent MR pipelines cannot collide.
 *
 * `pasvTarget` is the extra piece FTP needs. Passive mode is the failure that
 * actually happens: `basic-ftp` and IRIS both default to PASV, the server answers
 * `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)` with an address and port the
 * CLIENT must then reach, and on EC2 that means `pasv_address` must be the public
 * IP and `pasv_min_port`–`pasv_max_port` must be open in the security group. When
 * they are not, the login succeeds and the transfer hangs — so the suite asks the
 * server what it is advertising and compares it with the declared range, turning a
 * hang into a named mismatch. Done over a raw control connection because neither
 * `basic-ftp` nor the product exposes the 227 reply.
 */
import { connect, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { Client } from 'basic-ftp';
import type { FtpConfig } from './sources.js';

export interface FtpSeeder {
  /** Create a directory. Tolerates one that already exists. */
  mkdir(dir: string): Promise<void>;
  /** Write one file. `path` is absolute in the server's own namespace. */
  put(path: string, body: string): Promise<void>;
  /** Entry names directly in `dir`. An FTP LIST of a MISSING dir also returns []. */
  listAll(dir: string): Promise<string[]>;
  /** Delete `dir` and everything in it. Returns how many entries it held. */
  removeDir(dir: string): Promise<number>;
  /** The host + port the server advertises for a passive data connection. */
  pasvTarget(): Promise<{ host: string; port: number }>;
}

const CONNECT_TIMEOUT_MS = 15_000;

export const makeFtpSeeder = (config: FtpConfig): FtpSeeder => {
  /** Log in, run `work`, always close the control connection. */
  const run = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client(CONNECT_TIMEOUT_MS);
    try {
      await client.access({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        secure: false,
      });
      return await work(client);
    } finally {
      client.close();
    }
  };

  return {
    mkdir: (dir) =>
      run(async (client) => {
        // ensureDir creates each missing segment and leaves the session cd'd into it,
        // which is harmless here: every other call uses an absolute path.
        await client.ensureDir(dir);
      }),
    put: (path, body) =>
      run(async (client) => {
        await client.uploadFrom(Readable.from(body), path);
      }),
    listAll: (dir) => run(async (client) => (await client.list(dir)).map((e) => e.name)),
    removeDir: (dir) =>
      run(async (client) => {
        let count = 0;
        try {
          count = (await client.list(dir)).length;
        } catch {
          return 0; // already gone
        }
        await client.removeDir(dir);
        return count;
      }),
    pasvTarget: () =>
      new Promise((resolve, reject) => {
        const socket: Socket = connect({ host: config.host, port: config.port });
        socket.setTimeout(CONNECT_TIMEOUT_MS);
        let buffer = '';
        // The three commands to send, in order; each is sent when the previous reply
        // is complete. A reply is complete when a line starts with "<code> ".
        const script = [`USER ${config.user}`, `PASS ${config.password}`, 'PASV'];
        let sent = 0;
        const fail = (message: string) => {
          socket.destroy();
          reject(new Error(`PASV probe against ${config.host}:${config.port} failed: ${message}`));
        };
        socket.on('error', (err) => fail(err.message));
        socket.on('timeout', () => fail('timed out'));
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!/^\d{3} /.test(line)) continue; // continuation line of a multi-line reply
            if (line.startsWith('4') || line.startsWith('5')) return fail(line);
            const pasv = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(line);
            if (pasv) {
              socket.destroy();
              const n = pasv.slice(1).map(Number) as [number, number, number, number, number, number];
              return resolve({ host: n.slice(0, 4).join('.'), port: n[4]! * 256 + n[5]! });
            }
            if (sent < script.length) socket.write(`${script[sent++]}\r\n`);
          }
        });
      }),
  };
};
