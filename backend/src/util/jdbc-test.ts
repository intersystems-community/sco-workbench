import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Connection-test logic for the Data Integration "database" (JDBC) source.
 *
 * This is REAL JDBC, database-agnostic: a tiny Java helper (compiled from
 * jdbc-helper/TestJdbc.java) loads the requested JDBC driver from the JARs in
 * JDBC_LIB_DIR, does a genuine `DriverManager.getConnection(dsn, user, pwd)` plus
 * a `SELECT 1`, and reports `{ ok, message }` as JSON. Node spawns that helper
 * per test (a manual button; JVM startup cost is irrelevant), writes the config
 * to its stdin (so the password never appears in argv/process list), and reads
 * the JSON back.
 *
 * A JVM is a SYSTEM dependency, not an npm package — so it must exist wherever
 * the backend runs (the Docker image bundles a JRE + the JARs). When Java or the
 * helper is absent (e.g. `npm run dev` on a machine without a JRE), the test
 * degrades to a clear "Java runtime not available" result rather than crashing.
 */

/** The connection config a JDBC test needs, from the wizard form. */
export interface JdbcTestConfig {
  /** JDBC URL, e.g. `jdbc:IRIS://host:1972/SC` or `jdbc:postgresql://host:5432/db`. */
  dsn: string;
  username: string;
  password: string;
  /** Fully-qualified JDBC driver class, e.g. `com.intersystems.jdbc.IRISDriver`. */
  driverClass: string;
}

/** Outcome of a connection test — the shape the frontend renders directly. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** How long to wait for the helper before killing it. */
const TEST_TIMEOUT_MS = 12_000;

/** The compiled helper's class name and (relative) location under the backend. */
const HELPER_CLASS = 'TestJdbc';
// From dist/util/jdbc-test.js (Docker) or src/util/jdbc-test.ts (dev), the
// compiled helper lives at backend/jdbc-helper — two levels up (both dist/ and
// src/ sit directly under backend/).
const HELPER_DIR_FROM_DIST = '../../jdbc-helper';

/**
 * Spawner seam so unit tests can inject a fake process instead of launching a
 * real JVM. Mirrors the subset of child_process.spawn we use.
 */
export type Spawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

const defaultSpawner: Spawner = (command, args) => spawn(command, args);

/** Resolve the java binary + classpath (JAR dir + compiled helper dir) from env.
 *  Reads its two vars directly from process.env (with the same defaults as the
 *  schema) so the JDBC test doesn't pull in full env validation. */
function resolveJavaInvocation(): { javaBin: string; classpath: string; helperDir: string } {
  const javaBin = process.env.JAVA_BIN || 'java';
  const jdbcLibDir = process.env.JDBC_LIB_DIR || '/app/backend/jdbc-lib';
  // dist/util/jdbc-test.js -> backend/jdbc-helper (the compiled .class lives here)
  const helperDir = new URL(HELPER_DIR_FROM_DIST, import.meta.url).pathname;
  // Classpath: every JAR in the lib dir, plus the helper's own dir. The `*`
  // glob is expanded by the JVM itself (must be passed as a single entry).
  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = [`${jdbcLibDir}/*`, helperDir].join(sep);
  return { javaBin, classpath, helperDir };
}

/**
 * Test a JDBC connection by spawning the Java helper. Resolves to a friendly
 * `{ ok, message }` either way — a failed test is a normal outcome, not a reject.
 *
 * `spawner` is injectable so unit tests exercise success / failure / java-missing
 * / timeout / malformed-output without a real JVM.
 */
export function testJdbcConnection(
  config: JdbcTestConfig,
  spawner: Spawner = defaultSpawner,
): Promise<ConnectionTestResult> {
  const dsn = config.dsn?.trim() ?? '';
  const username = config.username ?? '';
  const driverClass = config.driverClass?.trim() ?? '';
  if (!dsn) return Promise.resolve({ ok: false, message: 'Connection failed: a JDBC URL (DSN) is required.' });
  if (!driverClass) {
    return Promise.resolve({ ok: false, message: 'Connection failed: a database type (driver) is required.' });
  }

  const { javaBin, classpath } = resolveJavaInvocation();

  return new Promise<ConnectionTestResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawner(javaBin, ['-cp', classpath, HELPER_CLASS]);
    } catch {
      resolve(javaUnavailable());
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ConnectionTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, message: `Connection test timed out after ${TEST_TIMEOUT_MS / 1000}s.` }),
      TEST_TIMEOUT_MS,
    );

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // `java` missing entirely surfaces as an ENOENT spawn error.
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? javaUnavailable() : { ok: false, message: `JDBC test failed: ${err.message}` });
    });

    child.on('close', () => {
      // The helper prints a single JSON object on stdout for both success and
      // handled SQL errors. Anything unparseable is an environment/setup problem.
      try {
        const parsed = JSON.parse(stdout.trim()) as ConnectionTestResult;
        if (typeof parsed?.ok === 'boolean' && typeof parsed?.message === 'string') {
          finish(parsed);
          return;
        }
      } catch {
        // fall through to the diagnostic below
      }
      const detail = stderr.trim() || stdout.trim() || 'no output from the JDBC helper';
      finish({ ok: false, message: `JDBC test could not run: ${detail}` });
    });

    // Feed the config as JSON on stdin (keeps the password out of argv).
    try {
      child.stdin.write(JSON.stringify({ dsn, username, password: config.password ?? '', driverClass }));
      child.stdin.end();
    } catch {
      // If the process already died, `close`/`error` handles the result.
    }
  });
}

/** The friendly result when no JVM is available (e.g. dev machine without Java). */
function javaUnavailable(): ConnectionTestResult {
  return {
    ok: false,
    message: 'Java runtime not available for the JDBC test — install a JRE or run via Docker.',
  };
}
