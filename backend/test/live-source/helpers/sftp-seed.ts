/**
 * Fixture writer for the real SFTP server.
 *
 * The product's SFTP seam (`util/remote-fs/sftp-fs.ts`) is read-only — the
 * Workbench never writes to a customer's server — so seeding needs its own client,
 * and deliberately does not reuse `SftpFileSystem`: a fixture sharing the code under
 * test could hide a defect in it.
 *
 * Unlike S3, the drop directory is SHARED between runs, so everything is written
 * into a per-run subdirectory (`<dir>/<RUN_KEY>/`). `removeDir` is then a complete
 * teardown, the deployed adapter's FilePath sees only this run's files, and
 * concurrent MR pipelines cannot collide.
 */
import { readFileSync } from 'node:fs';
import { Client, utils, type SFTPWrapper } from 'ssh2';
import type { SftpConfig } from './sources.js';

export interface SftpSeeder {
  /** The private key CONTENTS, as the connector routes and the IRIS upload need it. */
  readonly privateKey: string;
  /**
   * The matching public key, in OpenSSH `.pub` form. DERIVED from the private key
   * rather than read from a second file, so the configuration stays one path — and
   * so the pair IRIS authenticates with provably belongs together.
   */
  readonly publicKey: string;
  /** Create a directory. Tolerates one that already exists. */
  mkdir(dir: string): Promise<void>;
  /** Write one file. `path` is absolute in the server's own namespace. */
  put(path: string, body: string): Promise<void>;
  /** File and directory names directly in `dir` (dotfiles included). */
  listAll(dir: string): Promise<string[]>;
  /** Delete every file in `dir`, then `dir` itself. Returns how many files went. */
  removeDir(dir: string): Promise<number>;
}

/** Open a session, run `work`, always tear the connection down. */
function withSftp<T>(config: SftpConfig, privateKey: string, work: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = new Client();
    const finish = (err: Error | null, value?: T) => {
      try {
        conn.end();
      } catch {
        /* ignore teardown errors */
      }
      if (err) reject(err);
      else resolve(value as T);
    };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return finish(err);
        work(sftp).then(
          (v) => finish(null, v),
          (e) => finish(e instanceof Error ? e : new Error(String(e))),
        );
      });
    });
    conn.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    conn.connect({
      host: config.host,
      port: config.port,
      username: config.user,
      privateKey,
      readyTimeout: 15_000,
    });
  });
}

export const makeSftpSeeder = (config: SftpConfig): SftpSeeder => {
  // Read once: the same bytes authenticate the seeder, the Node-side connector
  // routes, and (after upload+materialize) the IRIS adapter.
  const privateKey = readFileSync(config.privateKeyPath, 'utf8');
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new Error(`LIVE_SOURCE_SFTP_KEY_PATH (${config.privateKeyPath}) is not a usable private key: ${parsed.message}`);
  }
  const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}\n`;
  const run = <T>(work: (sftp: SFTPWrapper) => Promise<T>) => withSftp(config, privateKey, work);

  const readdir = (sftp: SFTPWrapper, dir: string): Promise<string[]> =>
    new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list.map((e) => e.filename))));
    });

  return {
    privateKey,
    publicKey,
    mkdir: (dir) =>
      run(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.mkdir(dir, (err) => {
              // SSH_FX_FAILURE (4) is what a server returns for "already exists", and
              // it carries no distinguishing code — so confirm by listing instead.
              if (!err) return resolve();
              sftp.readdir(dir, (statErr) => (statErr ? reject(err) : resolve()));
            });
          }),
      ),
    put: (path, body) =>
      run(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.writeFile(path, body, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()));
          }),
      ),
    listAll: (dir) => run((sftp) => readdir(sftp, dir)),
    removeDir: (dir) =>
      run(async (sftp) => {
        let names: string[];
        try {
          names = await readdir(sftp, dir);
        } catch {
          return 0; // already gone
        }
        for (const name of names) {
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(`${dir}/${name}`, (err) => (err ? reject(err) : resolve()));
          });
        }
        await new Promise<void>((resolve, reject) => {
          sftp.rmdir(dir, (err) => (err ? reject(err) : resolve()));
        });
        return names.length;
      }),
  };
};
