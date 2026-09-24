import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  fetchJdbcSchemas,
  fetchJdbcTables,
  fetchJdbcColumns,
  type Spawner,
} from '../../src/util/jdbc-metadata.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const goodConfig = {
  dsn: 'jdbc:postgresql://db.example.com:5432/testdb',
  username: 'testuser',
  password: 'testpass',
  driverClass: 'org.postgresql.Driver',
};

/**
 * Build a fake child process + spawner. `behavior` scripts what the "JVM" does:
 *  - stdout: JSON the helper would print
 *  - errorCode: emit a spawn 'error' (e.g. 'ENOENT' for missing java) instead
 *  - stderr: text on stderr
 *  - noClose: never emit 'close' (to exercise the timeout)
 * `spies.onArgs` captures the spawn args so tests can assert the action + config.
 * Mirrors jdbc-test.test.ts so the helpers' tests read alike.
 */
function fakeSpawner(
  behavior: { stdout?: string; stderr?: string; errorCode?: string; noClose?: boolean },
  spies?: { onWrite?: (chunk: string) => void; onArgs?: (args: string[]) => void; onSpawn?: () => void },
): Spawner {
  return (_cmd: string, args: string[]) => {
    spies?.onArgs?.(args);
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

describe('fetchJdbcSchemas (Java sidecar)', () => {
  it('returns the schema list, runs the "schemas" action, forwards config on stdin', async () => {
    let written = '';
    let spawnArgs: string[] = [];
    const spawner = fakeSpawner(
      { stdout: '{"ok":true,"schemas":["information_schema","pg_catalog","public"]}' },
      { onWrite: (c) => { written += c; }, onArgs: (a) => { spawnArgs = a; } },
    );
    const result = await fetchJdbcSchemas(goodConfig, spawner);
    expect(result).toEqual({ ok: true, schemas: ['information_schema', 'pg_catalog', 'public'] });
    // Action is the last CLI arg; the password reaches the helper via stdin (never argv).
    expect(spawnArgs[spawnArgs.length - 1]).toBe('schemas');
    expect(JSON.parse(written)).toMatchObject({ dsn: goodConfig.dsn, password: 'testpass' });
  });

  it('passes through a helper failure result (bad credentials / SQL error)', async () => {
    const spawner = fakeSpawner({
      stdout: '{"ok":false,"message":"Connection or authentication failed: password authentication failed"}',
    });
    const result = await fetchJdbcSchemas(goodConfig, spawner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('password authentication failed');
  });

  it('reports a friendly message when java is not installed (ENOENT)', async () => {
    const result = await fetchJdbcSchemas(goodConfig, fakeSpawner({ errorCode: 'ENOENT' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Java runtime not available/);
  });

  it('reports a diagnostic when the helper emits unparseable output', async () => {
    const result = await fetchJdbcSchemas(goodConfig, fakeSpawner({ stdout: 'not json', stderr: 'boom' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/could not run/);
      expect(result.message).toContain('boom');
    }
  });

  it('fails fast on a missing DSN without spawning', async () => {
    const onSpawn = vi.fn();
    const result = await fetchJdbcSchemas({ ...goodConfig, dsn: '' }, fakeSpawner({}, { onSpawn }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JDBC URL \(DSN\) is required/);
    expect(onSpawn).not.toHaveBeenCalled();
  });
});

describe('fetchJdbcTables (Java sidecar)', () => {
  it('returns the table list, runs "tables", and sends the schema on stdin', async () => {
    let written = '';
    let spawnArgs: string[] = [];
    const spawner = fakeSpawner(
      { stdout: '{"ok":true,"tables":["orders","customers"]}' },
      { onWrite: (c) => { written += c; }, onArgs: (a) => { spawnArgs = a; } },
    );
    const result = await fetchJdbcTables(goodConfig, 'public', spawner);
    expect(result).toEqual({ ok: true, tables: ['orders', 'customers'] });
    expect(spawnArgs[spawnArgs.length - 1]).toBe('tables');
    expect(JSON.parse(written)).toMatchObject({ schema: 'public' });
  });

  it('fails fast on a missing schema without spawning', async () => {
    const onSpawn = vi.fn();
    const result = await fetchJdbcTables(goodConfig, '', fakeSpawner({}, { onSpawn }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/schema is required/);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('passes through a helper failure result', async () => {
    const result = await fetchJdbcTables(
      goodConfig,
      'public',
      fakeSpawner({ stdout: '{"ok":false,"message":"schema not found"}' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('schema not found');
  });
});

describe('fetchJdbcColumns (Java sidecar)', () => {
  it('returns name+dataType+primaryKey columns, runs "columns", sends schema+table on stdin', async () => {
    let written = '';
    let spawnArgs: string[] = [];
    const spawner = fakeSpawner(
      { stdout: '{"ok":true,"columns":[{"name":"id","dataType":"INTEGER","primaryKey":true},{"name":"name","dataType":"VARCHAR","primaryKey":false}]}' },
      { onWrite: (c) => { written += c; }, onArgs: (a) => { spawnArgs = a; } },
    );
    const result = await fetchJdbcColumns(goodConfig, 'public', 'orders', spawner);
    expect(result).toEqual({
      ok: true,
      columns: [
        { name: 'id', dataType: 'INTEGER', primaryKey: true },
        { name: 'name', dataType: 'VARCHAR', primaryKey: false },
      ],
    });
    expect(spawnArgs[spawnArgs.length - 1]).toBe('columns');
    expect(JSON.parse(written)).toMatchObject({ schema: 'public', table: 'orders' });
  });

  it('defaults primaryKey to false when an older helper omits the flag', async () => {
    // Backward-compat: a helper build that predates the PK flag returns just
    // name+dataType; the wrapper must still shape each column with primaryKey:false.
    const spawner = fakeSpawner({
      stdout: '{"ok":true,"columns":[{"name":"id","dataType":"INTEGER"},{"name":"name","dataType":"VARCHAR"}]}',
    });
    const result = await fetchJdbcColumns(goodConfig, 'public', 'orders', spawner);
    expect(result).toEqual({
      ok: true,
      columns: [
        { name: 'id', dataType: 'INTEGER', primaryKey: false },
        { name: 'name', dataType: 'VARCHAR', primaryKey: false },
      ],
    });
  });

  it('fails fast on a missing table without spawning', async () => {
    const onSpawn = vi.fn();
    const result = await fetchJdbcColumns(goodConfig, 'public', '', fakeSpawner({}, { onSpawn }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/table is required/);
    expect(onSpawn).not.toHaveBeenCalled();
  });
});
