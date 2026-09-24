/**
 * Minimal ambient typings for `@intersystems/intersystems-iris-native`.
 *
 * The package ships an `index.d.ts` but its package.json `exports` map does not
 * expose it, so TypeScript can't resolve it under NodeNext resolution. We
 * declare only the surface we use (createConnection → createIris → class-method
 * calls). See src/iris/native-client.ts for the wrapper.
 */
declare module '@intersystems/intersystems-iris-native' {
  export interface ConnectionInfo {
    host: string;
    port: number;
    ns: string;
    user: string;
    pwd: string;
    sharedmemory?: boolean;
    timeout?: number;
    logfile?: string;
  }

  export interface IrisObjectRef {
    getObject(propertyName: string): unknown;
    set(propertyName: string, value: unknown): void;
    invokeObject(methodName: string, ...args: unknown[]): unknown;
    invokeVoid(methodName: string, ...args: unknown[]): void;
    close(): void;
  }

  export interface Iris {
    classMethodValue(className: string, methodName: string, ...args: unknown[]): unknown;
    classMethodVoid(className: string, methodName: string, ...args: unknown[]): void;
    classMethodString(className: string, methodName: string, ...args: unknown[]): string;
    set(value: unknown, global: string, ...subscripts: unknown[]): void;
    get(global: string, ...subscripts: unknown[]): unknown;
    kill(global: string, ...subscripts: unknown[]): void;
  }

  export interface Connection {
    createIris(): Iris;
    close(): void;
    isClosed(): boolean;
  }

  export function createConnection(info: ConnectionInfo): Connection;
  export function createConnection(
    info: ConnectionInfo,
    callback: (err: Error | null, connection: Connection) => void,
  ): void;

  const _default: {
    createConnection: typeof createConnection;
  };
  export default _default;
}
