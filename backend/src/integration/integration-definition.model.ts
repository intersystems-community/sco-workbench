/**
 * The typed input a data-integration deploy hands the class generators. It
 * mirrors the frontend deploy payload (`buildDeployPayload` in
 * data-integration.ts) PLUS the two values the backend discovers by introspecting
 * the target class (`keyIndex` / `keyRequestProp`). From this one object the
 * generator produces ALL of the pipeline's ObjectScript deterministically — the
 * assistant never authors the class source, which is what makes it reliable.
 */

/** Inbound adapter family. `File`/`FTP`/`SFTP`/`Cloud` generate a BS class; `SQL` does not. */
export type IntegrationAdapter = 'File' | 'FTP' | 'SFTP' | 'Cloud' | 'SQL';

/**
 * The canonical source-field type tokens (message.md's table). Each maps to an
 * IRIS property type for the request message.
 */
export type SourceTypeToken =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'stream';

/** A DTL transform function name (the fixed set dtl.md supports). Empty = plain copy. */
export type TransformFn =
  | ''
  | 'ToUpper'
  | 'ToLower'
  | 'Length'
  | 'SubString'
  | 'ReplaceStr'
  | 'Strip'
  | 'Pad'
  | 'ConvertDateTime'
  | 'Piece'
  | 'Lookup';

/** One source→target field mapping (a row of the wizard's Field Mapping table). */
export interface FieldMapping {
  /** Source field/column name — becomes the request-message property name. */
  sourceField: string;
  /** Canonical type token; drives the request property's IRIS type. Defaults to `string`. */
  sourceType?: SourceTypeToken;
  /** Optional DTL transform applied to the source value. */
  transform?: TransformFn | null;
  /** Named args for the transform (e.g. { start: '1', end: '8' } for SubString). */
  transformArgs?: Record<string, string>;
  /** Target class property this maps onto (verified against the real class). */
  targetProperty: string;
}

/** Source-config for the chosen adapter (only the relevant fields are set). */
export interface IntegrationService {
  // File
  filePath?: string;
  fileSpec?: string;
  // FTP / SFTP
  protocol?: 'FTP' | 'SFTP';
  host?: string;
  port?: string | number;
  path?: string;
  /** IRIS Credentials entry NAME (never a raw username/password). */
  credentials?: string;
  /** SFTP key-pair auth files (paths inside the IRIS host). */
  sftpPublicKeyFile?: string;
  sftpPrivateKeyFile?: string;
  // Cloud (AWS S3)
  bucket?: string;
  region?: string;
  credentialsFile?: string;
  blobPrefix?: string;
  blobPattern?: string;
  // SQL
  dsn?: string;
  query?: string;
  /**
   * The SOURCE table's primary/unique key column (auto-detected from the source
   * schema over JDBC). It becomes the GenericService `KeyFieldName` so the adapter
   * processes each source row once. It is INDEPENDENT of the target mapping — the
   * source key need not map to any target property (the target generates its own
   * key). Empty/omitted → row-tracking disabled (re-reads every poll; the target
   * upsert keeps it idempotent). Must be a column the polled query selects.
   */
  keyField?: string;
  /**
   * The JDBC driver class for the source database, e.g. `com.intersystems.jdbc.IRISDriver`
   * (IRIS) or `org.postgresql.Driver` (PostgreSQL). Becomes the GenericService's
   * `JDBCDriver` setting. Omitted → defaults to the IRIS driver (back-compat).
   */
  driverClass?: string;
  /**
   * For a NON-IRIS source, the in-container path of the JDBC driver JAR the
   * workbench staged into IRIS before deploy, so the shared Java Gateway can load
   * it. Becomes the GenericService's `JDBCClasspath` setting. Omitted for IRIS
   * (its driver is always on the gateway's default classpath) → `JDBCClasspath`
   * is not set at all.
   */
  driverClasspath?: string;
}

/** The Step-2 mapping half of the payload. */
export interface IntegrationProcess {
  /** Does the source CSV have a header row? true → map by header name; false → by position. */
  hasHeader: boolean;
  /** Fully-qualified existing IRIS target class, e.g. SC.Data.Customer. */
  targetClass: string;
  /** Only the mapped fields (partial mapping — unmapped columns are dropped upstream). */
  mappings: FieldMapping[];
}

/**
 * A foreign key on the target class that THIS pipeline writes (its FK column is
 * one of the mapped target properties). Used to make the BPL's skip log name the
 * exact missing reference on a `#5829` failure. `sourceFields` are the request
 * (source) properties carrying each FK column's value, so the log can show what
 * value was rejected.
 */
export interface TargetForeignKey {
  name: string;
  referencedClass: string;
  /** Request properties (source fields) that carry the FK value(s), in column order. */
  sourceFields: string[];
}

/**
 * The complete input to the generator. `id` + `name` + `adapter` + `service` +
 * `process` come from the UI payload; `keyIndex`/`keyRequestProp`/`foreignKeys`
 * are discovered by the backend from the target class (see resolveKeyIndex /
 * listForeignKeys).
 */
export interface IntegrationDefinition {
  /** Integration id — namespaces every class as SC.Workbench.Integration{id}.*. */
  id: string;
  /** Display name; sanitized to a legal identifier for {IntegrationName}. */
  name: string;
  adapter: IntegrationAdapter;
  service: IntegrationService;
  process: IntegrationProcess;
  /**
   * Target unique/key index name whose auto-generated `<keyIndex>Open(value)`
   * method the BPL uses for the upsert (e.g. `uidIndex`). Omit for insert-only
   * (no key index on the target).
   */
  keyIndex?: string;
  /** The request-message property carrying the key value (a `sourceField`). */
  keyRequestProp?: string;
  /**
   * The target's foreign keys that THIS pipeline writes (discovered by the
   * backend). Drives the BPL's skip log so a `#5829` failure names the exact
   * missing reference and value. Empty/omitted → no FK-specific logging.
   */
  foreignKeys?: TargetForeignKey[];
}
