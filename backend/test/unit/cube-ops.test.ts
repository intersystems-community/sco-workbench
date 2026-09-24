import { describe, it, expect, vi } from 'vitest';
import { NativeClient, type ConnectionFactory } from '../../src/iris/native-client.js';
import { buildCube, cubeInfo, killCube } from '../../src/iris/cube-ops.js';

const cfg = { host: 'h', port: 1972, namespace: 'SC', user: 'u', password: 'p' };

/** Build a NativeClient whose classMethodValue is driven by `impl`. */
function clientWith(impl: (cls: string, method: string, args: unknown[]) => unknown) {
  const factory: ConnectionFactory = () => ({
    close: () => {},
    isClosed: () => false,
    createIris: () => ({
      classMethodValue: (cls, method, ...args) => impl(cls, method, args),
      classMethodVoid: () => {},
      classMethodObject: () => null,
    }),
  });
  return new NativeClient(cfg, factory);
}

/**
 * A NativeClient whose handle records connection-drain calls, so a test can
 * assert buildCube releases the DeepSee build lock (getTLevel/tCommit +
 * releaseAllLocks) after the build — see the lock note in buildCube.
 */
function clientWithDrainSpy(impl: (cls: string, method: string, args: unknown[]) => unknown) {
  const drain = { releaseAllLocks: 0, tLevelReads: 0 };
  const factory: ConnectionFactory = () => ({
    close: () => {},
    isClosed: () => false,
    createIris: () => ({
      classMethodValue: (cls, method, ...args) => impl(cls, method, args),
      classMethodVoid: () => {},
      classMethodObject: () => null,
      getTLevel: () => { drain.tLevelReads += 1; return 0; },
      tCommit: () => {},
      releaseAllLocks: () => { drain.releaseAllLocks += 1; },
    }),
  });
  return { client: new NativeClient(cfg, factory), drain };
}

describe('buildCube', () => {
  it('calls %BuildCube(name, 0, 1) and reports fact count on success', () => {
    const calls: Array<[string, string, unknown[]]> = [];
    const client = clientWith((cls, method, args) => {
      calls.push([cls, method, args]);
      if (method === '%BuildCube') return 1;
      if (method === '%GetCubeFactCount') return 20;
      return undefined;
    });
    const res = buildCube(client, 'MyCube');
    expect(res.ok).toBe(true);
    expect(res.factCount).toBe(20);
    expect(res.message).toMatch(/20 facts/);
    expect(calls[0]).toEqual(['%DeepSee.Utils', '%BuildCube', ['MyCube', 0, 1]]);
  });

  it('reports failure with decoded status text when %BuildCube errors', () => {
    const client = clientWith((cls, method) => {
      if (method === '%BuildCube') return '0 error-status';
      if (method === 'GetErrorText') return 'ERROR #5001: bad source';
      return undefined;
    });
    const res = buildCube(client, 'MyCube');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/#5001/);
  });

  it('releases the build lock after a successful build (drains the connection)', () => {
    // %BuildCube takes the DeepSee cube lock on our reused Native connection; if
    // it is not released, the next MDX read over HTTP fails "#5001: Cube is
    // locked for rebuilding". buildCube must drain the connection after building.
    const { client, drain } = clientWithDrainSpy((_cls, method) => {
      if (method === '%BuildCube') return 1;
      if (method === '%GetCubeFactCount') return 20;
      return undefined;
    });
    const res = buildCube(client, 'MyCube');
    expect(res.ok).toBe(true);
    expect(drain.releaseAllLocks).toBeGreaterThan(0);
  });

  it('releases the build lock even when the build fails', () => {
    // A failed build can still have taken (and left) the lock, so the drain must
    // run regardless of outcome.
    const { client, drain } = clientWithDrainSpy((cls, method) => {
      if (method === '%BuildCube') return '0 error-status';
      if (method === 'GetErrorText') return 'ERROR #5001: bad source';
      return undefined;
    });
    const res = buildCube(client, 'MyCube');
    expect(res.ok).toBe(false);
    expect(drain.releaseAllLocks).toBeGreaterThan(0);
  });
});

describe('cubeInfo', () => {
  it('returns exists=false when %CubeExists is false', () => {
    const client = clientWith((_cls, method) => (method === '%CubeExists' ? 0 : undefined));
    expect(cubeInfo(client, 'Nope')).toEqual({ cubeName: 'Nope', exists: false });
  });

  it('returns fact count when the cube exists', () => {
    const client = clientWith((_cls, method) => {
      if (method === '%CubeExists') return 1;
      if (method === '%GetCubeFactCount') return 7;
      return undefined;
    });
    expect(cubeInfo(client, 'Yes')).toEqual({ cubeName: 'Yes', exists: true, factCount: 7 });
  });
});

describe('killCube', () => {
  it('calls %KillCube and reports success', () => {
    const spy = vi.fn((_cls: string, method: string) => (method === '%KillCube' ? 1 : undefined) as unknown);
    const client = clientWith(spy);
    const res = killCube(client, 'MyCube');
    expect(res.ok).toBe(true);
  });

  it('reports failure with decoded status text when %KillCube errors', () => {
    // The uncovered failure branch (#72): a non-OK %Status must surface a
    // readable message, not a bare false.
    const client = clientWith((cls, method) => {
      if (cls === '%SYSTEM.Status' && method === 'GetErrorText') return 'ERROR #5002: kill failed';
      if (method === '%KillCube') return 'encoded-error';
      return undefined;
    });
    const res = killCube(client, 'MyCube');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/kill failed|Failed to kill/i);
  });
});
