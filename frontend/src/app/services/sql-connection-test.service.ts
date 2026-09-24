import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** Connection + auth info for a JDBC (database) source, sent to the backend. */
export interface SqlConnectionConfig {
  /** JDBC URL, e.g. `jdbc:IRIS://host:1972/SC`. */
  dsn: string;
  username: string;
  /** Used server-side only to authenticate the test; never persisted. */
  password: string;
  /** Fully-qualified JDBC driver class, chosen from the Database Type. */
  driverClass: string;
}

/** The test-connection request/response shapes. */
export interface SqlConnectionTestRequest {
  adapter: 'SQL';
  config: SqlConnectionConfig;
  /** The saved case's id when reopened. Sent alongside `config` (never inside it,
   *  so the tested-config signature stays clean) so the backend can substitute a
   *  persisted password the browser only holds as the `__saved__` sentinel. */
  caseId?: string;
}
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Tests a JDBC (database) source connection against the backend, which opens a
 * short-lived IRIS connection with the supplied DSN + credentials and reports
 * whether connectivity and authentication succeeded.
 *
 * One dedicated service per source adapter (SQL / FTP / SFTP / Cloud) so each can
 * be developed independently; this one owns only the SQL/JDBC case. The other
 * adapters live in their own sibling services and hit their own backend subpath.
 */
@Injectable({ providedIn: 'root' })
export class SqlConnectionTestService {
  constructor(private http: HttpClient) {}

  testConnection(payload: SqlConnectionTestRequest): Observable<ConnectionTestResult> {
    return this.http.post<ConnectionTestResult>(
      apiUrl('/api/data-integration/test-connection/sql'),
      payload,
    );
  }
}
