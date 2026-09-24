import { describe, it, expect, vi } from 'vitest';
import {
  NativeClient,
  adaptObject,
  type ConnectionFactory,
  type IrisConnection,
  type IrisHandle,
} from '../../src/iris/native-client.js';

const cfg = {
  host: 'localhost',
  port: 1972,
  namespace: 'SC',
  user: 'superuser',
  password: 'SYS',
};

/** Build a fake connection whose iris handle is driven by the given callbacks. */
function fakeFactory(handle: Partial<IrisHandle>, onClose?: () => void): ConnectionFactory {
  const iris: IrisHandle = {
    classMethodValue: handle.classMethodValue ?? (() => undefined),
    classMethodVoid: handle.classMethodVoid ?? (() => undefined),
    classMethodObject: handle.classMethodObject ?? (() => null),
  };
  const conn: IrisConnection = {
    createIris: () => iris,
    close: () => onClose?.(),
    isClosed: () => false,
  };
  return () => conn;
}

describe('NativeClient', () => {
  it('calls a class method value through the connection', () => {
    const spy = vi.fn().mockReturnValue(42);
    const client = new NativeClient(cfg, fakeFactory({ classMethodValue: spy }));
    const result = client.callValue('%DeepSee.Utils', '%GetCubeFactCount', 'MyCube');
    expect(result).toBe(42);
    expect(spy).toHaveBeenCalledWith('%DeepSee.Utils', '%GetCubeFactCount', 'MyCube');
  });

  it('reuses the connection across calls (creates iris once)', () => {
    let created = 0;
    const iris: IrisHandle = {
      classMethodValue: () => 1,
      classMethodVoid: () => {},
      classMethodObject: () => null,
    };
    const factory: ConnectionFactory = () => ({
      createIris: () => {
        created += 1;
        return iris;
      },
      close: () => {},
      isClosed: () => false,
    });
    const client = new NativeClient(cfg, factory);
    client.callValue('A', 'B');
    client.callValue('A', 'C');
    expect(created).toBe(1);
  });

  it('decodeStatus treats 1 / "1" / true as success', () => {
    const client = new NativeClient(cfg, fakeFactory({}));
    expect(client.decodeStatus(1).ok).toBe(true);
    expect(client.decodeStatus('1').ok).toBe(true);
    expect(client.decodeStatus(true).ok).toBe(true);
  });

  it('decodeStatus resolves error text via %SYSTEM.Status.GetErrorText', () => {
    const spy = vi.fn((cls: string, method: string) => {
      if (cls === '%SYSTEM.Status' && method === 'GetErrorText') {
        return 'ERROR #5001: cube not found';
      }
      return undefined;
    });
    const client = new NativeClient(cfg, fakeFactory({ classMethodValue: spy }));
    const decoded = client.decodeStatus('some-encoded-error-status');
    expect(decoded.ok).toBe(false);
    expect(decoded.text).toMatch(/#5001/);
  });

  it('decodeStatus accepts the BigInt 1n success form', () => {
    const client = new NativeClient(cfg, fakeFactory({}));
    expect(client.decodeStatus(1n).ok).toBe(true);
  });

  it('statusText returns a clear message for a null %Status', () => {
    const client = new NativeClient(cfg, fakeFactory({}));
    expect(client.statusText(null)).toMatch(/null %Status/);
  });

  it('statusText falls back to the raw value when GetErrorText throws (no crash)', () => {
    const spy = vi.fn(() => {
      throw new Error('gateway down');
    });
    const client = new NativeClient(cfg, fakeFactory({ classMethodValue: spy }));
    // The swallow branch: a failing GetErrorText must not propagate — it returns
    // the stringified status so callers still get *something* actionable.
    expect(client.statusText('raw-status-value')).toBe('raw-status-value');
  });

  it('wraps connection failures in a friendly "unavailable" error', () => {
    const factory: ConnectionFactory = () => {
      throw new Error('ECONNREFUSED');
    };
    const client = new NativeClient(cfg, factory);
    expect(() => client.callValue('A', 'B')).toThrow(/SCO native connection unavailable/);
  });

  it('unwraps an IrisObject argument back to the raw SDK oref (prevents GATEWAY callback)', () => {
    // Regression: passing our JS wrapper (not the raw oref) as a method argument
    // makes the SDK store the wrapper and later attempt a Node callback on %Save,
    // failing with "<GATEWAY> Callbacks into the Node.js environment not fully
    // supported". adaptObject must unwrap oref args back to the raw object.
    let insertedArg: unknown;
    // Raw SDK-shaped orefs (have invokeVoid + getObject → recognized as orefs).
    const rawItem = {
      getObject: () => null,
      getString: () => '',
      set: () => {},
      invokeObject: () => null,
      invokeString: () => '1',
      invokeVoid: () => {},
    };
    const rawProd = {
      getObject: () => null,
      getString: () => '',
      set: () => {},
      invokeObject: () => null,
      invokeString: () => '1',
      invokeVoid: (_m: string, arg: unknown) => {
        insertedArg = arg;
      },
    };

    const wrappedItem = adaptObject(rawItem);
    const wrappedProd = adaptObject(rawProd);
    // Passing the WRAPPED item as an argument must deliver the RAW oref.
    wrappedProd.invokeVoid('Insert', wrappedItem);
    expect(insertedArg).toBe(rawItem);
    expect(insertedArg).not.toBe(wrappedItem);
  });

  it('close() closes the underlying connection and is safe to call twice', () => {
    const onClose = vi.fn();
    const client = new NativeClient(cfg, fakeFactory({ classMethodValue: () => 1 }, onClose));
    client.callValue('A', 'B'); // opens
    client.close();
    client.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reconnects and retries once when a call fails with a dead-connection error', () => {
    // Simulates an IRIS container restart: the first connection's call throws a
    // COMMUNICATION LINK ERROR (stale socket); the client must drop it, build a
    // fresh connection, and retry — returning the second connection's result.
    let created = 0;
    const factory: ConnectionFactory = () => {
      created += 1;
      const conn = created; // capture which connection this is
      const iris: IrisHandle = {
        classMethodValue: () => {
          if (conn === 1) throw new Error('<COMMUNICATION LINK ERROR> write_all: send() returned error EPIPE');
          return 'ok-after-reconnect';
        },
        classMethodVoid: () => {},
        classMethodObject: () => null,
      };
      return { createIris: () => iris, close: () => {}, isClosed: () => false };
    };
    const client = new NativeClient(cfg, factory);
    const result = client.callValue('%Library.File', 'CreateDirectoryChain', '/tmp/x');
    expect(result).toBe('ok-after-reconnect');
    expect(created).toBe(2); // one stale + one fresh
  });

  it('does NOT retry a normal application error (retry is dead-conn only)', () => {
    let calls = 0;
    const factory: ConnectionFactory = () => ({
      createIris: () => ({
        classMethodValue: () => {
          calls += 1;
          throw new Error('ERROR #5001: some application error');
        },
        classMethodVoid: () => {},
        classMethodObject: () => null,
      }),
      close: () => {},
      isClosed: () => false,
    });
    const client = new NativeClient(cfg, factory);
    expect(() => client.callValue('A', 'B')).toThrow(/#5001/);
    expect(calls).toBe(1); // not retried
  });

  it('surfaces the error if the reconnect attempt also fails (one-shot retry)', () => {
    let created = 0;
    const factory: ConnectionFactory = () => {
      created += 1;
      return {
        createIris: () => ({
          classMethodValue: () => {
            throw new Error('<COMMUNICATION LINK ERROR> broken pipe');
          },
          classMethodVoid: () => {},
          classMethodObject: () => null,
        }),
        close: () => {},
        isClosed: () => false,
      };
    };
    const client = new NativeClient(cfg, factory);
    expect(() => client.callValue('A', 'B')).toThrow(/COMMUNICATION LINK ERROR/);
    expect(created).toBe(2); // original + one reconnect, then give up
  });
});
