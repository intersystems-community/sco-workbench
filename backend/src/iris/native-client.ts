import { createRequire } from 'node:module';

// The IRIS Native package is CommonJS and exposes named exports (createConnection)
// with no ESM default export, so we load it via createRequire rather than an
// ESM import (which fails with "does not provide an export named 'default'").
const require = createRequire(import.meta.url);
const irisnative = require('@intersystems/intersystems-iris-native') as {
  createConnection: (info: {
    host: string;
    port: number;
    ns: string;
    user: string;
    pwd: string;
    timeout?: number;
  }) => {
    createIris(): {
      classMethodValue(cls: string, method: string, ...args: unknown[]): unknown;
      classMethodVoid(cls: string, method: string, ...args: unknown[]): void;
      releaseAllLocks(): void;
      getTLevel(): number;
      tCommit(): void;
      tRollback(): void;
    };
    close(): void;
    isClosed(): boolean;
  };
};

export interface NativeConfig {
  host: string;
  port: number;
  namespace: string;
  user: string;
  password: string;
  /** Connection attempt timeout in ms (default 10000, matching the driver). */
  timeout?: number;
}

/**
 * Minimal shape of an IRIS object reference (oref) returned by the Native SDK.
 * Used for stateful work like building an Ens.Config.Item and saving a
 * production. We depend only on the members we call, so tests can fake it.
 */
export interface IrisObject {
  getObject(propertyName: string): unknown;
  /** Read a scalar property as a string (avoids BigInt return serialization). */
  getString(propertyName: string): string;
  set(propertyName: string, value: unknown): void;
  /** Invoke a method whose return is an object reference (or scalar), wrapped. */
  invokeValue(methodName: string, ...args: unknown[]): unknown;
  /**
   * Invoke a method and read its return as a string. Use for methods returning
   * a %Status or scalar — the SDK's object/number return paths throw
   * "Do not know how to serialize a BigInt" for IRIS integers.
   */
  invokeString(methodName: string, ...args: unknown[]): string;
  /** Invoke a method for its side effects; return value is discarded. */
  invokeVoid(methodName: string, ...args: unknown[]): void;
}

/**
 * Minimal shape of the objects the IRIS Native SDK returns. We only depend on
 * the methods we actually call, which keeps this unit-testable with a fake.
 */
export interface IrisHandle {
  classMethodValue(className: string, methodName: string, ...args: unknown[]): unknown;
  classMethodVoid(className: string, methodName: string, ...args: unknown[]): void;
  /** Returns an object reference (oref) or null. */
  classMethodObject(className: string, methodName: string, ...args: unknown[]): IrisObject | null;
  /** Release every lock held by this connection (optional; may be absent in fakes). */
  releaseAllLocks?(): void;
  /** Current transaction nesting level ($TLEVEL) (optional; absent in fakes). */
  getTLevel?(): number;
  /** Commit the innermost open transaction (optional; absent in fakes). */
  tCommit?(): void;
}

export interface IrisConnection {
  createIris(): IrisHandle;
  close(): void;
  isClosed?(): boolean;
}

export type ConnectionFactory = (cfg: NativeConfig) => IrisConnection;

const defaultFactory: ConnectionFactory = (cfg) => {
  const raw = irisnative.createConnection({
    host: cfg.host,
    port: cfg.port,
    ns: cfg.namespace,
    user: cfg.user,
    pwd: cfg.password,
    timeout: cfg.timeout ?? 10_000,
  });
  return {
    close: () => raw.close(),
    isClosed: () => raw.isClosed(),
    createIris: () => {
      const iris = raw.createIris();
      return {
        classMethodValue: (cls, method, ...args) =>
          iris.classMethodValue(cls, method, ...(args as never[])),
        classMethodVoid: (cls, method, ...args) =>
          iris.classMethodVoid(cls, method, ...(args as never[])),
        classMethodObject: (cls, method, ...args) => {
          // %OpenId of a missing id returns "" (not null), which is not an oref;
          // only adapt genuine SDK objects, otherwise report null.
          const obj = iris.classMethodValue(cls, method, ...(args as never[]));
          return isSdkObject(obj) ? adaptObject(obj) : null;
        },
        releaseAllLocks: () => iris.releaseAllLocks(),
        getTLevel: () => iris.getTLevel(),
        tCommit: () => iris.tCommit(),
      };
    },
  };
};

interface SdkObject {
  getObject(p: string): unknown;
  getString(p: string): string;
  set(p: string, v: unknown): void;
  invokeObject(m: string, ...a: unknown[]): unknown;
  invokeString(m: string, ...a: unknown[]): string;
  invokeVoid(m: string, ...a: unknown[]): void;
}

/** Is a returned value itself an SDK oref (vs a scalar/BigInt/string)? */
function isSdkObject(v: unknown): v is SdkObject {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SdkObject).invokeVoid === 'function' &&
    typeof (v as SdkObject).getObject === 'function'
  );
}

/**
 * Maps each IrisObject wrapper back to the raw SDK oref it wraps. This is how
 * we unwrap an oref that a caller passes as a *method argument* (e.g.
 * `Items.Insert(item)`): the SDK must receive the raw oref, not our JS wrapper.
 * If the wrapper were passed through, the SDK would try to call back into the
 * Node environment on the next %Save → "<GATEWAY> Callbacks into the Node.js
 * environment not fully supported".
 */
const RAW = new WeakMap<object, SdkObject>();

/** Replace any IrisObject-wrapped argument with its raw SDK oref. */
function unwrapArgs(args: unknown[]): unknown[] {
  return args.map((a) => (a && typeof a === 'object' && RAW.has(a) ? RAW.get(a) : a));
}

/**
 * Adapt an SDK IRISObject to our minimal IrisObject shape. Nested object
 * returns (e.g. the `Items` collection, or an item from `FindItemByConfigName`)
 * are adapted recursively so their methods are callable; scalars pass through.
 * Oref *arguments* are unwrapped back to raw SDK orefs before every call.
 *
 * Exported for unit testing of the oref unwrap behavior.
 */
export function adaptObject(obj: SdkObject): IrisObject {
  const wrap = (v: unknown): unknown => (isSdkObject(v) ? adaptObject(v) : v);
  const wrapper: IrisObject = {
    getObject: (p) => wrap(obj.getObject(p)),
    getString: (p) => obj.getString(p),
    set: (p, v) => obj.set(p, unwrapArgs([v])[0]),
    invokeValue: (m, ...a) => wrap(obj.invokeObject(m, ...unwrapArgs(a))),
    invokeString: (m, ...a) => obj.invokeString(m, ...unwrapArgs(a)),
    invokeVoid: (m, ...a) => obj.invokeVoid(m, ...unwrapArgs(a)),
  };
  RAW.set(wrapper, obj);
  return wrapper;
}

/**
 * True if `err` looks like a dead/broken IRIS connection (as opposed to a
 * normal application error from the method itself). The Native SDK surfaces a
 * restarted-server socket as a "COMMUNICATION LINK ERROR" / EPIPE / broken pipe
 * — the socket the SDK cached is gone even though it wasn't cleanly closed. We
 * match on the message text (the SDK has no typed error) so a stale connection
 * can be transparently rebuilt and the call retried once.
 */
function isDeadConnectionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toUpperCase();
  return (
    msg.includes('COMMUNICATION LINK ERROR') ||
    msg.includes('EPIPE') ||
    msg.includes('BROKEN PIPE') ||
    msg.includes('CONNECTION RESET') ||
    msg.includes('ECONNRESET') ||
    msg.includes('SSL ERROR')
  );
}

/**
 * Thin wrapper over the InterSystems IRIS Native SDK for Node.js.
 *
 * Used for everything that isn't source import/compile: building cubes
 * (`%DeepSee.Utils`) and managing interoperability productions
 * (`Ens.Config.Production` / `Ens.Config.Item` / `Ens.Director`).
 *
 * The connection is created lazily and reused. A `ConnectionFactory` can be
 * injected for tests so no live IRIS is required.
 */
export class NativeClient {
  private connection: IrisConnection | null = null;
  private iris: IrisHandle | null = null;

  constructor(
    private readonly config: NativeConfig,
    private readonly factory: ConnectionFactory = defaultFactory,
  ) {}

  private handle(): IrisHandle {
    if (this.iris && !(this.connection?.isClosed?.() ?? false)) return this.iris;
    try {
      this.connection = this.factory(this.config);
      this.iris = this.connection.createIris();
      return this.iris;
    } catch (err) {
      throw new Error(
        `SCO native connection unavailable (${this.config.host}:${this.config.port}, ns ${this.config.namespace}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Run `op` against the live handle; if it fails because the cached connection
   * went dead (e.g. the IRIS container was restarted — the SDK still reports the
   * socket "open" but a write gets EPIPE / "COMMUNICATION LINK ERROR"), drop the
   * connection, reconnect once, and retry. A second failure is surfaced as-is.
   * This makes every IRIS call resilient to an IRIS restart without a backend
   * restart. Retry is one-shot to avoid masking a genuinely-down IRIS in a loop.
   */
  private withReconnect<T>(op: (h: IrisHandle) => T): T {
    try {
      return op(this.handle());
    } catch (err) {
      if (!isDeadConnectionError(err)) throw err;
      this.close(); // discard the stale handle so handle() builds a fresh one
      return op(this.handle());
    }
  }

  /** Call a class method that returns a value. */
  callValue(className: string, methodName: string, ...args: unknown[]): unknown {
    return this.withReconnect((h) => h.classMethodValue(className, methodName, ...args));
  }

  /** Call a class method for its side effects only. */
  callVoid(className: string, methodName: string, ...args: unknown[]): void {
    this.withReconnect((h) => h.classMethodVoid(className, methodName, ...args));
  }

  /** Call a class method that returns an object reference (oref), or null. */
  callObject(className: string, methodName: string, ...args: unknown[]): IrisObject | null {
    return this.withReconnect((h) => h.classMethodObject(className, methodName, ...args));
  }

  /**
   * Drain any transaction/lock state left on this (long-lived) connection after
   * a server-side operation, so nothing lingers for the life of the connection.
   *
   * Why this matters: some Ens APIs (e.g. Ens.Director.UpdateProduction) open a
   * transaction and take the runtime global lock. If the caller's connection is
   * reused (as ours is) and a transaction is left open, that lock is held until
   * the process dies — later IRIS internals (the interoperability
   * ScheduleHandler) then fail with <Ens>ErrCanNotAcquireRuntimeLock and the
   * running production wedges. Committing any dangling transaction and releasing
   * locks returns the connection to a clean state. Best-effort and safe to call
   * when there is nothing to drain.
   */
  drainConnectionState(): void {
    const h = this.handle();
    try {
      // Commit any dangling transaction levels (bounded to avoid a spin).
      for (let i = 0; i < 16 && (h.getTLevel?.() ?? 0) > 0; i++) h.tCommit?.();
    } catch {
      // ignore — a rollback-only or already-closed tx is fine to leave to close()
    }
    try {
      h.releaseAllLocks?.();
    } catch {
      // ignore
    }
  }

  /**
   * Invoke an instance method that returns a %Status and decode it. Reads the
   * return via `invokeString` because the SDK's numeric/object return paths
   * throw "Do not know how to serialize a BigInt" for IRIS integers; a %Status
   * is `"1"` on success or a `"0 …"` encoded string on error.
   */
  decodeInstanceStatus(obj: IrisObject, methodName: string, ...args: unknown[]): { ok: boolean; text: string } {
    const status = obj.invokeString(methodName, ...args);
    return this.decodeStatus(status);
  }

  /**
   * Decode an IRIS %Status value into a friendly result. A %Status is `1` (or a
   * string beginning with `1`) on success; on error it is an encoded string.
   * We resolve the human-readable text via `$SYSTEM.Status.GetErrorText`.
   */
  decodeStatus(status: unknown): { ok: boolean; text: string } {
    // The Native SDK returns IRIS integers as BigInt, so a success %Status
    // ($$$OK = 1) arrives as 1n. Accept number, bigint, string, and boolean forms.
    if (
      status === 1 ||
      status === 1n ||
      status === '1' ||
      status === true
    ) {
      return { ok: true, text: 'OK' };
    }
    const text = this.statusText(status);
    return { ok: false, text };
  }

  /** Resolve %Status error text via IRIS, falling back to the raw value. */
  statusText(status: unknown): string {
    if (status == null) return 'Unknown error (null %Status)';
    try {
      const t = this.callValue('%SYSTEM.Status', 'GetErrorText', status);
      const s = typeof t === 'string' ? t.trim() : String(t);
      return s.length ? s : String(status);
    } catch {
      return String(status);
    }
  }

  /**
   * Run `fn` against a BRAND-NEW, isolated NativeClient whose connection is
   * CLOSED when `fn` settles. Use this to wrap a whole production operation
   * (add/enable/remove item, update) so it never runs on the shared long-lived
   * socket.
   *
   * Why: an Ens mutation (UpdateProduction, an item %Save) opens a transaction
   * and takes the interoperability runtime global lock. On a REUSED connection
   * any transaction/lock state that lingers past one request silently wedges the
   * NEXT one with <Ens>ErrCanNotAcquireRuntimeLock — the observed "first item
   * deploys, second gets stuck" symptom. A fresh, immediately-closed connection
   * per request guarantees no such state can cross request boundaries: the OS
   * tears the socket down (rolling back any dangling tx and dropping every lock)
   * the instant `fn` returns, so the next request starts from a clean slate.
   * `drainConnectionState()` stays as belt-and-suspenders within a single op.
   */
  async withFreshConnection<T>(fn: (client: NativeClient) => T | Promise<T>): Promise<T> {
    const temp = new NativeClient(this.config, this.factory);
    try {
      return await fn(temp);
    } finally {
      temp.close();
    }
  }

  /** Close the connection if open. Safe to call multiple times. */
  close(): void {
    try {
      this.connection?.close();
    } finally {
      this.connection = null;
      this.iris = null;
    }
  }
}
