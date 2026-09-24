// backend/test/unit/helpers/fake-sc-data-iris.ts
//
// A stand-in for the two IRIS ports the sample-data load uses, behaving the way the
// real instance was measured to behave (IRIS 2025.2, 2026-09-08):
//
//   - `INFORMATION_SCHEMA.COLUMNS` reports the installed SC_Data tables, spelling
//     each column the way the model declares it (which is NOT always how the
//     product's loader spells it), and flags the columns a load must not write to the
//     way the real table does: `ID` as IS_IDENTITY/AUTO_INCREMENT, `lastUpdatedTime`
//     and `recordCreatedTime` as IS_GENERATED. Every table here has those three on top
//     of its data columns, exactly as SC_Data does. Each column also carries a
//     DATA_TYPE — `VARCHAR` unless a test says otherwise via `columnTypes`, which is
//     how a `BIT` column (`SC_Data.BOM.isAlternate`) is modelled.
//   - `LOAD DATA FROM FILE` reads a file from the IRIS-side filesystem — here the
//     bytes that `putFileToIris` staged through the fake Native client — and inserts
//     its rows, SILENTLY SKIPPING any row whose `uid` is already present, exactly as
//     the real statement does with a duplicate primary key.
//   - `SELECT COUNT(*)`, the `TOP 1` existence test and the `uid IN (…)` probe read
//     that same state.
//   - `INFORMATION_SCHEMA.TABLES` lists exactly the tables this fake has installed, so a
//     CSV named after its table resolves here the way it does on the real instance —
//     including NOT resolving when a test uninstalls the table.
//   - `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` reports the FOREIGN KEYs a test asks for.
//     It reports NONE by default, which matches this fake's `LOAD DATA` — that does not
//     enforce foreign keys either, so a test gets one consistent world rather than a
//     pre-flight that rejects rows the fake load would have accepted. A test about
//     referential integrity declares the keys it cares about (see `foreignKeys`).
//   - `%SQL_Diag` is empty unless a test supplies `diag`, which is how the real
//     instance's "status: Complete, and by the way I rejected all 1,019 rows" is
//     reproduced.
//
// So the tables really do fill up: a report can be checked against what landed, and
// "load the same set twice" is a real re-load rather than a scripted answer.
import type { SqlQuerier, SqlQueryOptions } from '../../../src/iris/schema-ops.js';
import type { NativeClient } from '../../../src/iris/native-client.js';
import type { ScDataLoadDeps } from '../../../src/iris/sc-data-load-ops.js';
import { parseCsv } from '../../../src/util/csv-inspect.js';

/** Staging directory the fake pretends IRIS has. */
export const FAKE_STAGE_DIR = '/tmp/sco-workbench/csv';

export interface FakeScDataOptions {
  /**
   * Installed tables, merged over `DEFAULT_TABLES`. `null` UNINSTALLS a table, which is
   * the "skip this CSV and report it" case. The listed columns are the WRITABLE ones; the
   * read-only trio (`ID`, `lastUpdatedTime`, `recordCreatedTime`) is always reported as
   * well.
   */
  tables?: Record<string, string[] | null>;
  /** Rows already in a table before the load: table name → uids. */
  existing?: Record<string, string[]>;
  /**
   * Column SQL types `INFORMATION_SCHEMA.COLUMNS` reports, as `Table.column` → type
   * (`'BIT'`, `'TIMESTAMP'`, …). Anything unlisted is `VARCHAR`, which is what nearly
   * every SC_Data column is. Only a test about type coercion needs this.
   */
  columnTypes?: Record<string, string>;
  /** SQL matching this throws, so a per-file or connection failure can be forced. */
  failOn?: RegExp;
  /** The error `failOn` throws. Defaults to a plausible SQLCODE. */
  throws?: () => Error;
  /** Rewrite what a LOAD DATA actually inserts, to simulate IRIS dropping rows. */
  onLoad?: (rows: string[][], table: string) => string[][];
  /**
   * FOREIGN KEYs `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` reports, per table. Empty by
   * default — see the module comment. A `parentTable` is matched against the same
   * `existing`/loaded uid state as everything else, since SC_Data's keys all reference
   * `uid`. The same declarations answer BOTH shapes of that query: the per-table
   * pre-flight and the schema-wide graph the load order is derived from.
   */
  foreignKeys?: Record<string, FakeForeignKey[]>;
  /**
   * What `%SQL_Diag` says about the load that just ran — the real `LOAD DATA` reports
   * `status: Complete` and writes its rejections here instead.
   *
   * A message given as a bare string is filed under a NON-ZERO sqlcode, the way the
   * instance files a rejection; a test that needs the other case — a line IRIS logged
   * under sqlcode 0 — says so with the object form. Which of the two fields carries the
   * code decides whether the reason reaches the user, so the fake has to be able to say.
   */
  diag?: { errorCount: number; messages: Array<string | FakeDiagMessage> };
}

/** One `%SQL_Diag.Message` row: its text, and the sqlcode IRIS filed it under. */
export interface FakeDiagMessage {
  message: string;
  /** Defaults to `-104`, i.e. an error rather than a progress line. */
  sqlcode?: number;
}

/** One foreign key for the fake to report. `parentColumn` defaults to `uid`. */
export interface FakeForeignKey {
  column: string;
  parentTable: string;
  parentColumn?: string;
  constraint?: string;
}

export interface FakeScDataIris {
  /** What `createSampleDataRouter` / `loadScDataCsv` take. */
  deps: ScDataLoadDeps;
  /** Every SQL statement sent, in order. */
  sql: string[];
  /** Every statement with the transport overrides it asked for (timeout, attempts). */
  calls: Array<{ sql: string; options?: SqlQueryOptions }>;
  /** The LOAD DATA statements only. */
  loads: () => string[];
  /** Files currently staged inside "IRIS", path → text. */
  files: Map<string, string>;
  /** Text of the last file staged for a table (staging deletes it afterwards). */
  staged: (table: string) => string | undefined;
  /** uids a table now holds, in insertion order. */
  rows: (table: string) => string[];
}

/**
 * The installed model a test gets unless it says otherwise: the SC_Data tables the
 * shipped example sets have files for, with their real column names as
 * `INFORMATION_SCHEMA.COLUMNS` reports them on the reference instance (IRIS 2025.2,
 * 2026-09-08). Spelled out here rather than derived from anything in `src/`, so a test
 * asserts against a fixed schema instead of against the code under test.
 *
 * Only the WRITABLE columns are listed — the read-only trio is added by `columnRows` —
 * and only the ones a shipped file fills: the real tables have more (`Location` also has
 * `region`, `latitude`, `longitude`, `gln`, …), and a test that needs one adds it through
 * `tables`. `SC_Data` itself has ~14 further tables no shipped file covers; a test that
 * needs one of those adds it the same way.
 */
export const DEFAULT_TABLES: Readonly<Record<string, string[]>> = {
  Location: ['uid', 'name', 'type', 'status', 'street', 'city', 'stateProvince', 'country', 'postalCode', 'coordinates'],
  Carrier: ['uid', 'name', 'type', 'status'],
  Product: ['uid', 'name', 'type', 'productBrand', 'productCategory', 'productFamily'],
  BOM: ['uid', 'productId', 'itemId', 'parentItemId', 'quantity', 'unitOfMeasure', 'isAlternate', 'substituteFor'],
  SLA: ['uid', 'type', 'productId', 'cycleTime', 'cycleTimeUnit'],
  Customer: ['uid', 'name', 'type', 'status', 'primaryLocationId'],
  Supplier: ['uid', 'name', 'type', 'status', 'primaryLocationId'],
  ProductSupplier: ['uid', 'productId', 'supplierId'],
  InventoryThreshold: ['uid', 'siteLocationId', 'productId', 'quantityUpperThreshold', 'quantityLowerThreshold'],
  ProductInventory: ['uid', 'productId', 'siteLocationId', 'quantity', 'quantityUom', 'expirationDate'],
  SalesOrder: ['uid', 'customerId', 'orderStatus', 'orderPlacedDate', 'shipToLocationId', 'orderValue', 'orderCurrency', 'requestedShipDate', 'requestedDeliveryDate', 'committedShipDate', 'committedDeliveryDate'],
  SalesOrderLine: ['uid', 'salesOrderId', 'lineNumber', 'productId', 'quantity', 'unitOfMeasure', 'status', 'value', 'valueCurrency'],
  SalesShipment: ['uid', 'customerId', 'status', 'carrierId', 'originLocationId', 'destinationLocationId', 'actualShipDate', 'estimatedTimeOfArrival', 'actualTimeOfArrival', 'requestedTimeOfArrival', 'committedTimeOfArrival'],
  SalesShipmentLine: ['uid', 'salesShipmentId', 'lineNumber', 'salesOrderLineId', 'salesOrderId', 'salesOrderLineNumber', 'productId', 'quantityShipped', 'unitOfMeasure'],
  PurchaseOrder: ['uid', 'supplierId', 'orderStatus', 'orderPlacedDate', 'shipToLocationId', 'orderValue', 'orderCurrency', 'requestedShipDate', 'requestedDeliveryDate'],
  PurchaseOrderLine: ['uid', 'purchaseOrderId', 'lineNumber', 'productId', 'quantity', 'unitOfMeasure', 'status', 'value', 'valueCurrency'],
  SupplyShipment: ['uid', 'supplierId', 'status', 'carrierId', 'originLocationId', 'destinationLocationId', 'actualShipDate', 'estimatedTimeOfArrival', 'actualTimeOfArrival', 'requestedTimeOfArrival', 'committedTimeOfArrival'],
  SupplyShipmentLine: ['uid', 'supplyShipmentId', 'lineNumber', 'purchaseOrderLineId', 'purchaseOrderId', 'purchaseOrderLineNumber', 'productId', 'quantityShipped', 'unitOfMeasure'],
  DemandPlan: ['uid', 'productId', 'locationId', 'startDate', 'timeFrameDays', 'quantity', 'quantityUom'],
};

/** A fresh, mutable copy of `DEFAULT_TABLES` for one fake to install and override. */
function installedTables(): Map<string, string[]> {
  return new Map(Object.entries(DEFAULT_TABLES).map(([table, columns]) => [table, [...columns]]));
}

/**
 * Columns every SC_Data table has that a load must NEVER write to, with the flags IRIS
 * reports for them (measured on `SC_Data.Location`, 2026-09-08). They are real columns,
 * so a CSV header naming one has to be refused on the flags, not on absence.
 */
const READ_ONLY_COLUMNS: ReadonlyArray<{ name: string; row: Record<string, string> }> = [
  { name: 'ID', row: { IS_IDENTITY: 'YES', AUTO_INCREMENT: 'YES', IS_GENERATED: 'NO', IS_UPDATABLE: 'YES' } },
  { name: 'lastUpdatedTime', row: { IS_IDENTITY: 'NO', AUTO_INCREMENT: 'NO', IS_GENERATED: 'YES', IS_UPDATABLE: 'YES' } },
  { name: 'recordCreatedTime', row: { IS_IDENTITY: 'NO', AUTO_INCREMENT: 'NO', IS_GENERATED: 'YES', IS_UPDATABLE: 'YES' } },
];

/** What INFORMATION_SCHEMA.COLUMNS returns for a table: data columns, then the trio. */
function columnRows(
  table: string,
  columns: readonly string[],
  types: Record<string, string> = {},
): Array<Record<string, string>> {
  const held = new Set(columns.map((c) => c.toLowerCase()));
  const typeOf = (column: string) => {
    const key = Object.keys(types).find((k) => k.toLowerCase() === `${table}.${column}`.toLowerCase());
    return key ? types[key] as string : 'VARCHAR';
  };
  return [
    ...columns.map((column) => ({
      TABLE_NAME: table,
      COLUMN_NAME: column,
      DATA_TYPE: typeOf(column),
      IS_IDENTITY: 'NO',
      AUTO_INCREMENT: 'NO',
      IS_GENERATED: 'NO',
      IS_UPDATABLE: 'YES',
    })),
    // A test may list one of the trio itself, e.g. to respell it; do not repeat it.
    ...READ_ONLY_COLUMNS.filter((c) => !held.has(c.name.toLowerCase())).map((c) => ({
      TABLE_NAME: table,
      COLUMN_NAME: c.name,
      DATA_TYPE: c.name === 'ID' ? 'BIGINT' : 'TIMESTAMP',
      ...c.row,
    })),
  ];
}

export function createFakeScDataIris(options: FakeScDataOptions = {}): FakeScDataIris {
  const tables = installedTables();
  for (const [name, columns] of Object.entries(options.tables ?? {})) {
    // Replace case-insensitively so an override can respell the table itself.
    for (const key of [...tables.keys()]) {
      if (key.toLowerCase() === name.toLowerCase()) tables.delete(key);
    }
    if (columns) tables.set(name, columns);
  }

  /** table (as declared) → uids held, in insertion order. */
  const held = new Map<string, string[]>();
  const find = (name: string) => [...tables.keys()].find((t) => t.toLowerCase() === name.toLowerCase());
  for (const [name, uids] of Object.entries(options.existing ?? {})) {
    held.set(find(name) ?? name, [...uids]);
  }

  const sql: string[] = [];
  const calls: Array<{ sql: string; options?: SqlQueryOptions }> = [];
  const files = new Map<string, string>();
  /** Kept after deletion so a test can still read what was staged. */
  const lastStaged = new Map<string, string>();

  const query = async <Row>(
    text: string,
    params?: unknown[],
    // NOT `options`: that name is the fake's own configuration in this scope.
    transport?: SqlQueryOptions,
  ): Promise<Row[]> => {
    sql.push(text);
    calls.push(transport ? { sql: text, options: transport } : { sql: text });
    if (options.failOn?.test(text)) {
      throw options.throws ? options.throws() : new Error(`SQLCODE -400: ${text.slice(0, 40)}`);
    }

    if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
      const table = find(String(params?.[1] ?? ''));
      if (!table) return [] as Row[];
      return columnRows(table, tables.get(table) ?? [], options.columnTypes) as unknown as Row[];
    }

    if (text.includes('INFORMATION_SCHEMA.TABLES')) {
      return [...tables.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((table) => ({ TABLE_NAME: table })) as unknown as Row[];
    }

    // The whole schema's FK graph, which the loader reads once to order a set. Names come
    // back UPPERCASED, as the real query's collation returns them (`SALESSHIPMENT`), so a
    // caller that compares them literally is caught here rather than in production.
    if (text.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && text.includes('SELECT DISTINCT')) {
      return Object.entries(options.foreignKeys ?? {}).flatMap(([child, keys]) =>
        keys.map((fk) => ({
          TABLE_NAME: (find(child) ?? child).toUpperCase(),
          REFERENCED_TABLE_NAME: (find(fk.parentTable) ?? fk.parentTable).toUpperCase(),
        })),
      ) as unknown as Row[];
    }

    if (text.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) {
      const asked = String(params?.[1] ?? '');
      const entry = Object.entries(options.foreignKeys ?? {}).find(
        ([table]) => table.toLowerCase() === asked.toLowerCase(),
      );
      return (entry?.[1] ?? []).map((fk) => ({
        CONSTRAINT_NAME: fk.constraint ?? `${fk.column}FK`,
        COLUMN_NAME: fk.column,
        REFERENCED_TABLE_NAME: fk.parentTable,
        REFERENCED_COLUMN_NAME: fk.parentColumn ?? 'uid',
      })) as unknown as Row[];
    }

    if (text.includes('%SQL_Diag.Result')) {
      // Numbered so "the newest one" is answerable; only its existence matters here.
      return (options.diag ? [{ id: 1, errors: options.diag.errorCount }] : []) as unknown as Row[];
    }
    if (text.includes('%SQL_Diag.Message')) {
      // Every row comes back whatever the statement selected, INCLUDING `sqlcode` when
      // the caller did not ask for it: a reader that then treats the absent field as 0
      // is filtering on something it never read, and that is worth failing a test over.
      return (options.diag?.messages ?? []).map((entry) =>
        typeof entry === 'string'
          ? { message: entry, sqlcode: -104 }
          : { message: entry.message, sqlcode: entry.sqlcode ?? -104 },
      ) as unknown as Row[];
    }

    const counted = /^SELECT COUNT\(\*\) AS n FROM SC_Data\."([^"]+)"$/.exec(text);
    if (counted) {
      return [{ n: (held.get(counted[1] as string) ?? []).length }] as unknown as Row[];
    }

    // "Does this table hold anything at all?" — the cheap emptiness test the
    // foreign-key pre-flight opens with.
    const any = /^SELECT TOP 1 "[^"]+" AS value FROM SC_Data\."([^"]+)"$/.exec(text);
    if (any) {
      const uids = held.get(find(any[1] as string) ?? (any[1] as string)) ?? [];
      return (uids.length ? [{ value: uids[0] }] : []) as unknown as Row[];
    }

    const probed = /FROM SC_Data\."([^"]+)" WHERE "[^"]+" IN \(/.exec(text);
    if (probed) {
      const have = new Set(held.get(find(probed[1] as string) ?? (probed[1] as string)) ?? []);
      return (params ?? [])
        .map(String)
        .filter((value) => have.has(value))
        .map((value) => ({ value })) as unknown as Row[];
    }

    const load = /^LOAD DATA FROM FILE '([^']+)' INTO SC_Data\."([^"]+)"\(([^)]*)\)/.exec(text);
    if (load) {
      const [, path, table, columnList] = load as unknown as [string, string, string, string];
      const body = files.get(path);
      if (body === undefined) throw new Error(`SQLCODE -400: file '${path}' not found`);

      const columns = columnList.split(',').map((c) => c.replace(/^"|"$/g, ''));
      const uidAt = columns.findIndex((c) => c.toLowerCase() === 'uid');
      const parsed = parseCsv(body, 1_000_000);
      const staged = parsed.slice(1);
      const rows = options.onLoad ? options.onLoad(staged, table) : staged;

      const uids = held.get(table) ?? [];
      held.set(table, uids);
      for (const row of rows) {
        const uid = String(row[uidAt] ?? '');
        // A duplicate primary key is skipped by LOAD DATA, not raised.
        if (uid && !uids.includes(uid)) uids.push(uid);
      }
      return [{ status: 'Complete' }] as unknown as Row[];
    }

    return [] as Row[];
  };

  const native = {
    callValue: (cls: string, method: string, ...args: unknown[]) => {
      if (cls === '%Library.File' && method === 'CreateDirectoryChain') return 1;
      if (cls === '%Library.File' && method === 'Exists') return files.has(String(args[0])) ? 1 : 0;
      if (cls === '%Library.File' && method === 'Delete') {
        files.delete(String(args[0]));
        return 1;
      }
      if (cls === '%SYSTEM.Encryption' && method === 'Base64Decode') {
        return Buffer.from(String(args[0]), 'base64').toString('utf8');
      }
      return '1';
    },
    callObject: (cls: string, method: string) => {
      // %Stream.FileBinary: FilenameSet then Write then %Save. Model it as an
      // append-only write to the fake filesystem so the staged bytes are inspectable.
      if (cls !== '%Stream.FileBinary' || method !== '%New') return null;
      let path = '';
      let text = '';
      return {
        invokeString: (m: string, ...args: unknown[]) => {
          if (m === 'FilenameSet') {
            path = String(args[0]);
            text = '';
          }
          if (m === 'Write') text += String(args[0]);
          if (m === '%Save') {
            files.set(path, text);
            lastStaged.set(path, text);
          }
          return '1';
        },
      };
    },
    decodeStatus: (status: unknown) =>
      status === '1' || status === 1 ? { ok: true, text: 'OK' } : { ok: false, text: 'ERROR' },
  } as unknown as NativeClient;

  const stagedFor = (table: string): string | undefined => {
    const match = [...lastStaged.keys()].find((p) => p.endsWith(`/${table}.csv`));
    return match ? lastStaged.get(match) : undefined;
  };

  return {
    deps: { sql: { query } as SqlQuerier, native, stageDir: FAKE_STAGE_DIR },
    sql,
    calls,
    loads: () => sql.filter((s) => s.startsWith('LOAD DATA')),
    files,
    staged: stagedFor,
    rows: (table) => [...(held.get(find(table) ?? table) ?? [])],
  };
}
