import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** Connection + auth info for a plain-FTP source, sent to the backend. */
export interface FtpConnectionConfig {
  host: string;
  /** FTP control port; blank defaults to 21 server-side. */
  port: string;
  username: string;
  /** Used server-side only to authenticate the test; never persisted. */
  password: string;
}

export interface FtpConnectionTestRequest {
  adapter: 'FTP';
  config: FtpConnectionConfig;
  /** The saved case's id when reopened — lets the backend substitute a persisted
   *  password the browser only holds as the `__saved__` sentinel. */
  caseId?: string;
}
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Tests a plain-FTP source connection against the backend, which opens a real
 * FTP control connection to the host, logs in with the supplied credentials, and
 * runs a PWD to confirm the session works.
 *
 * One dedicated service per source adapter (SQL / FTP / SFTP / Cloud) so each can
 * be developed independently; this one owns only the plain-FTP case — the SFTP
 * protocol option is key-based and lives in SftpConnectionTestService.
 */
@Injectable({ providedIn: 'root' })
export class FtpConnectionTestService {
  constructor(private http: HttpClient) {}

  testConnection(payload: FtpConnectionTestRequest): Observable<ConnectionTestResult> {
    return this.http.post<ConnectionTestResult>(
      apiUrl('/api/data-integration/test-connection/ftp'),
      payload,
    );
  }
}
