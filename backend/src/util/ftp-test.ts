import { Client } from 'basic-ftp';

/**
 * Connection-test logic for the Data Integration plain-FTP source.
 *
 * FTP targets a standard FTP server, so the Node backend connects DIRECTLY with
 * the `basic-ftp` client — no IRIS involvement (the same shape as the SFTP test,
 * which uses `ssh2`). Authentication is username + password over the control
 * channel; the password is used only for this request and never stored or logged
 * (the client's `verbose` logging stays off, so no protocol trace is emitted).
 *
 * The test opens the control connection, logs in, then issues a `PWD` to prove
 * the server is reachable, the credentials authenticate, AND the authenticated
 * session accepts commands — then disconnects. SFTP's counterpart opens the SFTP
 * subsystem for the same reason.
 *
 * Note this is plain FTP only. The SFTP protocol option on the same wizard card
 * is key-based and handled by util/sftp-test.ts; the route layer picks between
 * them by the `ftpSftp` flag the frontend sends as separate endpoints.
 */

/** The connection info an FTP test needs, from the wizard form. */
export interface FtpTestConfig {
  host: string;
  /** FTP control port; defaults to 21 when blank. */
  port?: string;
  username: string;
  /** Password for the control-channel login. Blank is allowed (e.g. anonymous). */
  password?: string;
}

/** Outcome of a connection test — the shape the frontend renders directly. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** Default FTP control port. */
const DEFAULT_FTP_PORT = 21;
/** Connection/command timeout (ms) — fail fast rather than hang on a dead host. */
const CONNECT_TIMEOUT_MS = 10_000;

/** The login options we pass through to the client. */
export interface FtpAccessOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Plain FTP (no TLS) — the wizard exposes no FTPS option yet. */
  secure: boolean;
}

/**
 * A minimal FTP client, so unit tests can inject a fake instead of a live
 * server. Matches the subset of `basic-ftp`'s Client we use.
 */
export interface FtpClientLike {
  access(options: FtpAccessOptions): Promise<unknown>;
  pwd(): Promise<string>;
  close(): void;
}

/** Factory for the FTP client (given a timeout in ms); overridable in tests. */
export type FtpClientFactory = (timeoutMs: number) => FtpClientLike;

const defaultFactory: FtpClientFactory = (timeoutMs) =>
  new Client(timeoutMs) as unknown as FtpClientLike;

/**
 * Test an FTP connection: connect to host:port, log in with username/password,
 * run `PWD`, then disconnect. Resolves to a friendly `{ ok, message }` either
 * way — a failed test is a normal outcome, not a reject.
 *
 * `factory` is injectable so unit tests exercise success / auth-failure /
 * unreachable / command-failure paths without a live server.
 */
export async function testFtpConnection(
  config: FtpTestConfig,
  factory: FtpClientFactory = defaultFactory,
): Promise<ConnectionTestResult> {
  const host = config.host?.trim() ?? '';
  const username = config.username?.trim() ?? '';
  if (!host) return { ok: false, message: 'Connection failed: Host is required.' };
  if (!username) return { ok: false, message: 'Connection failed: Username is required.' };
  const port = config.port?.trim() ? Number(config.port) : DEFAULT_FTP_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, message: `Connection failed: invalid port "${config.port}".` };
  }

  const client = factory(CONNECT_TIMEOUT_MS);
  try {
    await client.access({ host, port, user: username, password: config.password ?? '', secure: false });
    // Logged in; now confirm the authenticated session accepts a command.
    const cwd = await client.pwd();
    return {
      ok: true,
      message: `FTP connection to ${host} as ${username} succeeded (working directory: ${cwd || '/'}).`,
    };
  } catch (err) {
    // basic-ftp throws FTPError for negative server replies (bad credentials) and
    // plain Errors for socket problems/timeouts — both are a failed test, not a crash.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Connection or authentication failed: ${detail}` };
  } finally {
    // Always tear the control connection down, success or failure.
    try {
      client.close();
    } catch {
      // ignore teardown errors
    }
  }
}
