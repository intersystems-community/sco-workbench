import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** A source table column: its name, SQL data type, and whether it is part of the
 *  table's primary/unique key. The key flag drives the SQL pipeline's automatic
 *  row-tracking column (`KeyFieldName`) — set for the user, not hand-picked. */
export interface SqlColumn {
  name: string;
  dataType: string;
  /** True if this column is the source table's primary/unique key. Optional so a
   *  non-SQL source (or an older backend) that doesn't report it still type-checks. */
  primaryKey?: boolean;
}

/** Connection + auth info a SQL introspection call authenticates with (from Step 1). */
export interface SqlConnection {
  /** JDBC URL, e.g. `jdbc:IRIS://host:1972/SC`. */
  dsn: string;
  username: string;
  /** Used server-side only to authenticate; never persisted. */
  password: string;
  /** Fully-qualified JDBC driver class, chosen from the Database Type. */
  driverClass: string;
  /** The saved case's id, when this is a reopened case. Lets the backend recover a
   *  persisted secret the browser only holds redacted (password = `__saved__`), so
   *  the user need not re-enter it just to browse. Omitted for a brand-new case. */
  caseId?: string;
}

/** Backend response for the schema fetch: names on success, message on failure. */
export interface SchemasResult {
  ok: boolean;
  schemas?: string[];
  message?: string;
}

/** Backend response for the table fetch: names on success, message on failure. */
export interface TablesResult {
  ok: boolean;
  tables?: string[];
  message?: string;
}

/** Backend response for the column fetch: columns on success, message on failure. */
export interface ColumnsResult {
  ok: boolean;
  columns?: SqlColumn[];
  message?: string;
}

/** An entry in a remote FTP/SFTP directory listing. Only `folder` and `csv`
 *  entries are selectable in the UI; `file` (any other type) is shown but not. */
export interface FtpEntry {
  name: string;
  type: 'folder' | 'csv' | 'file';
}

/** Connection info passed to the FTP/SFTP browse/read calls (from Step 1). */
export interface FtpConnection {
  protocol: 'FTP' | 'SFTP';
  host?: string;
  port?: string;
  credentials?: string;
  username?: string;
  password?: string;
  /** Private key (.pem) CONTENTS for SFTP — used server-side only, never persisted. */
  privateKey?: string;
  /** The saved case's id, when this is a reopened case — lets the backend recover
   *  the persisted private key the browser no longer holds in memory. */
  caseId?: string;
}

/** Backend response for a remote (FTP or SFTP) directory listing. */
export interface FtpListResult {
  ok: boolean;
  entries?: FtpEntry[];
  message?: string;
}

/** Backend response for a remote CSV preview: RAW rows (header not yet applied). */
export interface CsvRawResult {
  ok: boolean;
  rows?: string[][];
  message?: string;
}

/** An entry in a cloud object-storage listing. Only `folder` (a key prefix) and
 *  `csv` objects are selectable in the UI; `file` is shown but not selectable. */
export interface CloudEntry {
  name: string;
  type: 'folder' | 'csv' | 'file';
}

/** Connection info passed to the cloud browse/read calls (from Step 1). */
export interface CloudConnection {
  bucket?: string;
  region?: string;
  /** Server-side path of the uploaded credentials file — what the IRIS adapter
   *  reads at run time. NOT what the browse calls authenticate with (the backend
   *  cannot read a path that only exists inside IRIS). */
  credentialsFile?: string;
  /** The uploaded AWS credentials file's CONTENTS — used server-side only for the
   *  browse/preview request, never persisted (mirrors the SFTP private key). */
  credentialsFileContent?: string;
  /** The saved case's id, when this is a reopened case — lets the backend recover
   *  the persisted credentials file the browser no longer holds in memory. */
  caseId?: string;
}

/** Backend response for a cloud (bucket) listing. */
export interface CloudListResult {
  ok: boolean;
  entries?: CloudEntry[];
  message?: string;
}

/** A CSV preview: column names + inferred data types, and a few sample rows. */
export interface CsvPreview {
  columns: SqlColumn[];
  rows: string[][];
}

/** Request the AI auto-map endpoint receives (field + property lists). */
export interface AutoMapRequest {
  sourceFields: { name: string; type: string }[];
  targetClass: string;
  targetProperties: { name: string; dataType: string; required?: boolean }[];
}

/** One AI-suggested source→target pairing. */
export interface Mapping {
  sourceField: string;
  targetProperty: string;
  confidence: number;
  reason: string;
}

/** Backend response for the auto-map call: mappings on success, message on failure. */
export interface AutoMapResult {
  ok: boolean;
  mappings?: Mapping[];
  message?: string;
}

/**
 * Introspects a data source for the Data step of the integration wizard. Every
 * method here is a REAL backend call: the SQL drill-down (schemas → tables →
 * columns), the remote FTP/SFTP file browser + CSV preview, and the cloud
 * (object-storage) bucket browser + object preview.
 *
 * Each transport keeps its own endpoint and its own config payload — they
 * authenticate in completely different ways — but they share ONE response shape
 * (`{ ok, entries | rows | message }`), which is why the browser UI needs no
 * per-transport branch and a failure renders the same way everywhere.
 */
@Injectable({ providedIn: 'root' })
export class DataSourceService {
  private http = inject(HttpClient);

  /**
   * Fetch the schemas of the connected SQL source. This is REAL: the backend
   * opens a JDBC connection with the Step-1 config and reads the database's
   * schema list, returning `{ ok, schemas | message }`. (Tables/columns below are
   * still mock until their own introspection endpoints exist.)
   */
  getSchemas(conn: SqlConnection): Observable<SchemasResult> {
    return this.http.post<SchemasResult>(
      apiUrl('/api/data-integration/introspect/sql/schemas'),
      { config: conn },
    );
  }

  /** Table/view names within the selected schema (real JDBC introspection). */
  getTables(conn: SqlConnection, schema: string): Observable<TablesResult> {
    return this.http.post<TablesResult>(
      apiUrl('/api/data-integration/introspect/sql/tables'),
      { config: conn, schema },
    );
  }

  /** Columns (name + JDBC data type) of the selected table (real introspection). */
  getColumns(conn: SqlConnection, schema: string, table: string): Observable<ColumnsResult> {
    return this.http.post<ColumnsResult>(
      apiUrl('/api/data-integration/introspect/sql/columns'),
      { config: conn, schema, table },
    );
  }

  /**
   * Ask the backend for an AI-suggested source→target field mapping (Mapping
   * step). Returns `{ ok, mappings | message }`; on `ok: false` the component
   * falls back to a local heuristic, so this never hard-fails the button.
   */
  autoMapFields(req: AutoMapRequest): Observable<AutoMapResult> {
    return this.http.post<AutoMapResult>(
      apiUrl('/api/data-integration/auto-map'),
      req,
    );
  }

  // ── FTP / SFTP (independent from SQL) ───────────────────────────────
  /**
   * List a directory on the remote FTP/SFTP server. REAL for BOTH protocols: the
   * backend opens a short-lived session with the Step-1 config (`ssh2` for SFTP,
   * `basic-ftp` for plain FTP) and returns each entry tagged as folder / csv /
   * other file, folders first. `path` is the absolute directory ('/' is the root).
   *
   * The two protocols authenticate differently, so each has its own endpoint and
   * its own config payload — but ONE identical response shape, which is why the
   * browser UI (navigate by clicking folders, pick a CSV) needs no protocol branch.
   */
  listFtpDir(conn: FtpConnection, path: string): Observable<FtpListResult> {
    return this.http.post<FtpListResult>(
      apiUrl(`/api/data-integration/introspect/${this.remoteKind(conn)}/list`),
      { config: this.remoteConfig(conn), path },
    );
  }

  /**
   * Preview a CSV on the remote FTP/SFTP server: a REAL bounded read via the
   * backend (the first few lines only, never the whole file), returning RAW rows
   * with the header not applied. The component applies the header-row option and
   * infers the column types from these rows, so toggling the header option needs
   * no re-fetch.
   */
  previewRemoteCsv(conn: FtpConnection, path: string): Observable<CsvRawResult> {
    return this.http.post<CsvRawResult>(
      apiUrl(`/api/data-integration/introspect/${this.remoteKind(conn)}/preview`),
      { config: this.remoteConfig(conn), path },
    );
  }

  /** The introspect endpoint segment for the picked protocol. */
  private remoteKind(conn: FtpConnection): 'sftp' | 'ftp' {
    return conn.protocol === 'SFTP' ? 'sftp' : 'ftp';
  }

  /**
   * The connection config the backend browse/preview calls authenticate with: SFTP
   * carries the private-key CONTENTS, plain FTP the control-channel password. Both
   * are used server-side only for that one request and are never persisted, so a
   * saved draft never carries the secret.
   */
  private remoteConfig(conn: FtpConnection): Record<string, string> {
    const base = {
      host: conn.host ?? '',
      port: conn.port ?? '',
      username: conn.username ?? '',
      // Passed through so the backend can recover a reopened case's persisted secret
      // (SFTP key / FTP password) the browser holds only redacted. Never feeds the
      // Test Connection signature — introspection configs are separate from it.
      caseId: conn.caseId ?? '',
    };
    return conn.protocol === 'SFTP'
      ? { ...base, privateKey: conn.privateKey ?? '' }
      : { ...base, password: conn.password ?? '' };
  }

  // ── Cloud object storage (independent from FTP/SFTP and SQL) ────
  /**
   * List the objects/prefixes under a key prefix in the cloud bucket ('/' is the
   * bucket root). REAL: the backend lists that one prefix level with the AWS SDK
   * using the Step-1 config, returning each entry tagged as folder (a common
   * prefix) / csv / other object.
   *
   * Object storage has no real directory tree — a "folder" is just a shared key
   * prefix — so this stays fully separate from the FTP browser (own methods, own
   * endpoint); only the returned shape is UI-compatible, for a consistent look.
   */
  listCloudDir(conn: CloudConnection, path: string): Observable<CloudListResult> {
    return this.http.post<CloudListResult>(
      apiUrl('/api/data-integration/introspect/s3/list'),
      { config: this.cloudConfig(conn), path },
    );
  }

  /**
   * Preview a CSV object in the bucket: a REAL bounded read via the backend (a
   * ranged GET of the first bytes only, never the whole object), returning RAW rows
   * with the header not applied — the component applies the header-row option and
   * infers the column types, so toggling it needs no re-fetch. `path` is the
   * absolute object key.
   */
  previewCloudCsv(conn: CloudConnection, path: string): Observable<CsvRawResult> {
    return this.http.post<CsvRawResult>(
      apiUrl('/api/data-integration/introspect/s3/preview'),
      { config: this.cloudConfig(conn), path },
    );
  }

  /**
   * The config the cloud browse/preview calls authenticate with. The wizard collects
   * an AWS credentials FILE (the IRIS adapter needs its path), so what goes on the
   * wire is that file's CONTENTS — the backend parses the keys out of it, the same
   * way the SFTP calls send the private key. Used server-side for that one request
   * and never persisted, so a saved draft never carries the secret.
   */
  private cloudConfig(conn: CloudConnection): Record<string, string> {
    return {
      bucket: conn.bucket ?? '',
      region: conn.region ?? '',
      credentialsFileContent: conn.credentialsFileContent ?? '',
      // Lets the backend recover a reopened case's persisted credentials file when
      // the browser no longer holds its contents in memory.
      caseId: conn.caseId ?? '',
    };
  }

  // A FRESH local-file preview is done client-side in the component (the File bytes
  // are already in the browser — no service round-trip). A REOPENED case, though, no
  // longer holds the File after a refresh, so it previews from the copy the backend
  // stored in SQLite, by case id — the same way the remote adapters recover their
  // persisted secret on reopen.
  previewStoredLocalCsv(caseId: string): Observable<CsvRawResult> {
    return this.http.post<CsvRawResult>(
      apiUrl('/api/data-integration/introspect/local/preview-stored'),
      { caseId, slot: 'localFile' },
    );
  }
}
