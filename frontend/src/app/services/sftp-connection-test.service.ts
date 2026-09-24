import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** Connection + key info for an SFTP source, sent to the backend. */
export interface SftpConnectionConfig {
  host: string;
  /** SSH/SFTP port; blank defaults to 22 server-side. */
  port: string;
  username: string;
  /** Private key (.pem) file CONTENTS — used server-side only, never persisted. */
  privateKey: string;
}

export interface SftpConnectionTestRequest {
  adapter: 'SFTP';
  config: SftpConnectionConfig;
  /** The saved case's id when reopened — lets the backend recover the persisted
   *  private key the browser no longer holds in memory. */
  caseId?: string;
}
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Tests an SFTP source connection against the backend, which opens a real ssh2
 * SFTP session to the host and authenticates with the supplied private key.
 *
 * One dedicated service per source adapter (SQL / FTP / SFTP / Cloud) so each can
 * be developed independently; this one owns only the SFTP case.
 */
@Injectable({ providedIn: 'root' })
export class SftpConnectionTestService {
  constructor(private http: HttpClient) {}

  testConnection(payload: SftpConnectionTestRequest): Observable<ConnectionTestResult> {
    return this.http.post<ConnectionTestResult>(
      apiUrl('/api/data-integration/test-connection/sftp'),
      payload,
    );
  }
}
