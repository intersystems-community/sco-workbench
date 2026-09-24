import { describe, it, expect } from 'vitest';
import { NativeClient, type ConnectionFactory, type IrisObject } from '../../src/iris/native-client.js';
import { putFileToIris, deleteFileFromIris } from '../../src/iris/file-ops.js';

const cfg = { host: 'h', port: 1972, namespace: 'SC', user: 'u', password: 'p' };

/** One recorded class-method call: (class, method, args). */
type Call = [string, string, unknown[]];

interface Harness {
  client: NativeClient;
  classCalls: Call[];
  /** Method calls on the %Stream.FileBinary oref, in order: (method, args). */
  streamCalls: Array<[string, unknown[]]>;
}

/**
 * Build a NativeClient over a fake IRIS. `classImpl` drives classMethodValue;
 * `%New` on %Stream.FileBinary returns a fake stream oref whose invokeString is
 * driven by `streamImpl` (defaulting to "1" = OK %Status for every call).
 */
function harness(opts?: {
  classImpl?: (cls: string, method: string, args: unknown[]) => unknown;
  streamImpl?: (method: string, args: unknown[]) => unknown;
}): Harness {
  const classCalls: Call[] = [];
  const streamCalls: Array<[string, unknown[]]> = [];

  const streamObj = {
    invokeString: (method: string, ...args: unknown[]) => {
      streamCalls.push([method, args]);
      return String(opts?.streamImpl?.(method, args) ?? '1');
    },
  } as unknown as IrisObject;

  const classImpl = opts?.classImpl ?? (() => '1');

  const factory: ConnectionFactory = () => ({
    close: () => {},
    isClosed: () => false,
    createIris: () => ({
      classMethodValue: (cls, method, ...args) => {
        classCalls.push([cls, method, args]);
        // GetErrorText is used by decodeStatus for a failing %Status.
        if (cls === '%SYSTEM.Status' && method === 'GetErrorText') return 'ERROR #5001: sample';
        return classImpl(cls, method, args);
      },
      classMethodVoid: () => {},
      classMethodObject: (cls, method, ...args) => {
        classCalls.push([cls, method, args]);
        return cls === '%Stream.FileBinary' && method === '%New' ? streamObj : null;
      },
    }),
  });

  return { client: new NativeClient(cfg, factory), classCalls, streamCalls };
}

describe('putFileToIris', () => {
  it('creates the dir, sets the filename, writes base64-decoded bytes, and saves', () => {
    const { client, classCalls, streamCalls } = harness();
    putFileToIris(client, { irisPath: '/tmp/sco/csv/abc_data.csv', bytes: Buffer.from('hello') });

    // Directory chain created for the file's parent.
    expect(classCalls).toContainEqual(['%Library.File', 'CreateDirectoryChain', ['/tmp/sco/csv']]);
    // Bytes went through Base64Decode before Write.
    expect(classCalls).toContainEqual(['%SYSTEM.Encryption', 'Base64Decode', [Buffer.from('hello').toString('base64')]]);
    // Stream method order: FilenameSet → Write → %Save.
    expect(streamCalls.map((c) => c[0])).toEqual(['FilenameSet', 'Write', '%Save']);
    expect(streamCalls[0]?.[1]).toEqual(['/tmp/sco/csv/abc_data.csv']);
  });

  it('does NOT touch umask for a non-secret file', () => {
    const { client, classCalls } = harness();
    putFileToIris(client, { irisPath: '/tmp/sco/csv/x.csv', bytes: Buffer.from('x') });
    expect(classCalls.some((c) => c[1] === 'SetUMask')).toBe(false);
  });

  it('sets umask 0600 before writing a secret and restores the previous mask after', () => {
    const setUmaskArgs: unknown[][] = [];
    const { client } = harness({
      classImpl: (cls, method, args) => {
        if (cls === '%Library.File' && method === 'SetUMask') {
          setUmaskArgs.push(args);
          return 18; // pretend the previous umask was 022 (=18 decimal)
        }
        return '1';
      },
    });
    putFileToIris(client, { irisPath: '/tmp/sco/keys/k.pem', bytes: Buffer.from('KEY'), secret: true });

    // First SetUMask tightens to 0o177; second restores the returned previous mask (18).
    expect(setUmaskArgs).toEqual([[0o177], [18]]);
  });

  it('does NOT restore umask when the prior mask is non-numeric (avoids corrupting it with NaN)', () => {
    const setUmaskArgs: unknown[][] = [];
    const { client } = harness({
      classImpl: (cls, method, args) => {
        if (cls === '%Library.File' && method === 'SetUMask') {
          setUmaskArgs.push(args);
          return 'not-a-number'; // SDK returned something unparseable
        }
        return '1';
      },
    });
    putFileToIris(client, { irisPath: '/tmp/sco/keys/k.pem', bytes: Buffer.from('KEY'), secret: true });

    // Only the tighten call ran; no restore with NaN (which would break the process umask).
    expect(setUmaskArgs).toEqual([[0o177]]);
  });

  it('restores umask even when the write fails', () => {
    const setUmaskArgs: unknown[][] = [];
    const { client } = harness({
      classImpl: (cls, method, args) => {
        if (cls === '%Library.File' && method === 'SetUMask') {
          setUmaskArgs.push(args);
          return 18;
        }
        return '1';
      },
      streamImpl: (method) => (method === 'Write' ? '0 write-blew-up' : '1'),
    });
    expect(() =>
      putFileToIris(client, { irisPath: '/tmp/sco/keys/k.pem', bytes: Buffer.from('KEY'), secret: true }),
    ).toThrow(/Failed to write/);
    // The restore still ran despite the throw.
    expect(setUmaskArgs).toEqual([[0o177], [18]]);
  });

  it('throws when the directory cannot be created', () => {
    const { client } = harness({
      classImpl: (cls, method) => (cls === '%Library.File' && method === 'CreateDirectoryChain' ? 0 : '1'),
    });
    expect(() =>
      putFileToIris(client, { irisPath: '/tmp/nope/x.csv', bytes: Buffer.from('x') }),
    ).toThrow(/Could not create directory/);
  });

  it('throws with decoded status text when %Save fails', () => {
    const { client } = harness({ streamImpl: (method) => (method === '%Save' ? '0 save-failed' : '1') });
    expect(() =>
      putFileToIris(client, { irisPath: '/tmp/sco/csv/x.csv', bytes: Buffer.from('x') }),
    ).toThrow(/Failed to save.*#5001/);
  });

  it('writes an empty file (no Write calls) and still saves', () => {
    const { client, streamCalls } = harness();
    putFileToIris(client, { irisPath: '/tmp/sco/csv/empty.csv', bytes: Buffer.alloc(0) });
    expect(streamCalls.map((c) => c[0])).toEqual(['FilenameSet', '%Save']);
  });

  it('chunks a large file into multiple Write calls', () => {
    const { client, streamCalls } = harness();
    // 48 KB chunk size → 100 KB payload is 3 chunks.
    putFileToIris(client, { irisPath: '/tmp/sco/csv/big.csv', bytes: Buffer.alloc(100 * 1024, 0x41) });
    const writes = streamCalls.filter((c) => c[0] === 'Write');
    expect(writes.length).toBe(3);
  });
});

describe('deleteFileFromIris', () => {
  it('calls %Library.File.Delete with the path', () => {
    const { client, classCalls } = harness();
    deleteFileFromIris(client, '/tmp/sco/keys/k.pem');
    expect(classCalls).toContainEqual(['%Library.File', 'Delete', ['/tmp/sco/keys/k.pem']]);
  });
});
