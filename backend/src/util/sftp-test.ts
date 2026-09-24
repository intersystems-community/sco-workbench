import { Client, type ConnectConfig } from 'ssh2';

/**
 * Connection-test logic for the Data Integration SFTP source.
 *
 * SFTP targets a plain SSH server (our use case: an AWS EC2 instance), so the
 * Node backend connects DIRECTLY with the `ssh2` client — no IRIS involvement.
 * Authentication is key-based: the user uploads a private key (.pem) and the
 * frontend sends its CONTENTS in the request body (Option A — nothing is stored
 * on the backend). We authenticate with that private key only; any public key or
 * extra files the user uploaded are not used for the test.
 *
 * The test opens the SSH connection, then opens the SFTP subsystem, to prove the
 * server is reachable, the key authenticates, AND SFTP itself is available — then
 * disconnects. It never logs the key material.
 */

/** The connection info an SFTP test needs, from the wizard form. */
export interface SftpTestConfig {
  host: string;
  /** SSH/SFTP port; defaults to 22 when blank. */
  port?: string;
  username: string;
  /** Private key (.pem) file CONTENTS — used only for this request, never stored. */
  privateKey: string;
}

/** Outcome of a connection test — the shape the frontend renders directly. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** Default SSH/SFTP port. */
const DEFAULT_SFTP_PORT = 22;
/** Connection attempt timeout (ms) — fail fast rather than hang on a dead host. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A minimal SSH client, so unit tests can inject a fake instead of a live server.
 * Matches the subset of `ssh2`'s Client we use.
 */
export interface SshClientLike {
  on(event: 'ready' | 'error', listener: (arg?: unknown) => void): this;
  connect(cfg: ConnectConfig): void;
  sftp(cb: (err: Error | undefined, sftp: unknown) => void): void;
  end(): void;
}

/** Factory for the SSH client; overridable in tests. */
export type SshClientFactory = () => SshClientLike;

const defaultFactory: SshClientFactory = () => new Client() as unknown as SshClientLike;

/**
 * Test an SFTP connection: connect to host:port, authenticate with the private
 * key, open the SFTP subsystem, then disconnect. Resolves to a friendly
 * `{ ok, message }` either way — a failed test is a normal outcome, not a reject.
 *
 * `factory` is injectable so unit tests exercise success / auth-failure /
 * unreachable paths without a live server.
 */
export function testSftpConnection(
  config: SftpTestConfig,
  factory: SshClientFactory = defaultFactory,
): Promise<ConnectionTestResult> {
  const host = config.host?.trim() ?? '';
  const username = config.username?.trim() ?? '';
  const privateKey = config.privateKey ?? '';
  if (!host) return Promise.resolve({ ok: false, message: 'Connection failed: Host is required.' });
  if (!username) return Promise.resolve({ ok: false, message: 'Connection failed: Username is required.' });
  if (!privateKey.trim()) {
    return Promise.resolve({ ok: false, message: 'Connection failed: a private key file is required.' });
  }
  const port = config.port?.trim() ? Number(config.port) : DEFAULT_SFTP_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    return Promise.resolve({ ok: false, message: `Connection failed: invalid port "${config.port}".` });
  }

  return new Promise<ConnectionTestResult>((resolve) => {
    const conn = factory();
    // Resolve exactly once, then always tear the connection down.
    let settled = false;
    const finish = (result: ConnectionTestResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        // ignore teardown errors
      }
      resolve(result);
    };

    conn.on('ready', () => {
      // Auth succeeded; now confirm the SFTP subsystem opens.
      conn.sftp((err) => {
        if (err) {
          finish({ ok: false, message: `Connected, but opening SFTP failed: ${err.message}` });
          return;
        }
        finish({ ok: true, message: `SFTP connection to ${host} as ${username} succeeded.` });
      });
    });

    conn.on('error', (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      finish({ ok: false, message: `Connection or authentication failed: ${detail}` });
    });

    conn.connect({
      host,
      port,
      username,
      privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
  });
}
