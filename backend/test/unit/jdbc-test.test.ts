import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { testJdbcConnection, type Spawner } from '../../src/util/jdbc-test.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const goodConfig = {
  dsn: 'jdbc:IRIS://db.example.com:1972/SC',
  username: 'superuser',
  password: 'SYS',
  driverClass: 'com.intersystems.jdbc.IRISDriver',
};

/**
 * Build a fake child process + spawner. `behavior` scripts what the "JVM" does:
 *  - stdout: JSON the helper would print
 *  - errorCode: emit a spawn 'error' (e.g. 'ENOENT' for missing java) instead
 *  - stderr: text on stderr
 *  - noClose: never emit 'close' (to exercise the timeout)
 */
function fakeSpawner(
  behavior: { stdout?: string; stderr?: string; errorCode?: string; noClose?: boolean },
  spies?: { onWrite?: (chunk: string) => void; onSpawn?: () => void },
): Spawner {
  return () => {
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    (child as unknown as { stdin: { write: (c: string) => void; end: () => void } }).stdin = {
      write: (c: string) => spies?.onWrite?.(c),
      end: () => {},
    };
    (child as unknown as { kill: () => void }).kill = () => {};

    spies?.onSpawn?.();
    // Drive the scripted lifecycle on the next tick, after the caller attached
    // its listeners.
    queueMicrotask(() => {
      if (behavior.errorCode) {
        const err = new Error('spawn failed') as NodeJS.ErrnoException;
        err.code = behavior.errorCode;
        child.emit('error', err);
        return;
      }
      if (behavior.stdout) stdout.emit('data', Buffer.from(behavior.stdout));
      if (behavior.stderr) stderr.emit('data', Buffer.from(behavior.stderr));
      if (!behavior.noClose) child.emit('close', 0);
    });
    return child;
  };
}

describe('testJdbcConnection (Java sidecar)', () => {
  it('returns the helper\'s ok result and forwards the config on stdin', async () => {
    let written = '';
    const spawner = fakeSpawner(
      { stdout: '{"ok":true,"message":"Connected to X as superuser; test query succeeded."}' },
      { onWrite: (c) => { written += c; } },
    );
    const result = await testJdbcConnection(goodConfig, spawner);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/test query succeeded/);
    // The password + driver reach the helper via stdin (never argv).
    const sent = JSON.parse(written);
    expect(sent).toMatchObject({ dsn: goodConfig.dsn, driverClass: goodConfig.driverClass, password: 'SYS' });
  });

  it('passes through a helper failure result (bad credentials / SQL error)', async () => {
    const spawner = fakeSpawner({
      stdout: '{"ok":false,"message":"Connection or authentication failed: Access Denied"}',
    });
    const result = await testJdbcConnection(goodConfig, spawner);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Access Denied');
  });

  it('reports a friendly message when java is not installed (ENOENT)', async () => {
    const spawner = fakeSpawner({ errorCode: 'ENOENT' });
    const result = await testJdbcConnection(goodConfig, spawner);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Java runtime not available/);
  });

  it('reports a diagnostic when the helper emits unparseable output', async () => {
    const spawner = fakeSpawner({ stdout: 'not json', stderr: 'Error: could not find class' });
    const result = await testJdbcConnection(goodConfig, spawner);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not run/);
    expect(result.message).toContain('could not find class');
  });

  it('fails fast on a missing DSN without spawning', async () => {
    const onSpawn = vi.fn();
    const result = await testJdbcConnection({ ...goodConfig, dsn: '' }, fakeSpawner({}, { onSpawn }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/JDBC URL \(DSN\) is required/);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('fails fast on a missing driver class without spawning', async () => {
    const onSpawn = vi.fn();
    const result = await testJdbcConnection({ ...goodConfig, driverClass: '' }, fakeSpawner({}, { onSpawn }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/database type \(driver\) is required/);
    expect(onSpawn).not.toHaveBeenCalled();
  });
});
