import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** Bucket + credential info for a cloud (AWS S3) source, sent to the backend. */
export interface CloudConnectionConfig {
  /** S3 bucket name (the adapter's BucketName). */
  bucket: string;
  /** AWS region the bucket lives in (StorageRegion), e.g. `us-east-1`. */
  region: string;
  /**
   * The picked AWS credentials file's CONTENTS — parsed server-side into an access
   * key id + secret. Used for this one request only and never persisted, exactly
   * like the SFTP private key. (The adapter separately needs the file's PATH inside
   * IRIS, which the upload returns; that is a different field.)
   */
  credentialsFileContent: string;
  /** Optional profile inside that file; blank = [default] / the only profile. */
  credentialsProfile?: string;
}

export interface CloudConnectionTestRequest {
  adapter: 'Cloud';
  config: CloudConnectionConfig;
  /** The saved case's id when reopened — lets the backend recover the persisted
   *  credentials file the browser no longer holds in memory. */
  caseId?: string;
}
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Tests a cloud (AWS S3) source connection against the backend, which lists the
 * bucket root with the AWS SDK — proving the region resolves, the credentials
 * authenticate, and the identity may list this bucket, i.e. exactly what the Data
 * Entity browser then needs.
 *
 * One dedicated service per source adapter (SQL / FTP / SFTP / Cloud) so each can
 * be developed independently; this one owns only the cloud case.
 */
@Injectable({ providedIn: 'root' })
export class CloudConnectionTestService {
  constructor(private http: HttpClient) {}

  testConnection(payload: CloudConnectionTestRequest): Observable<ConnectionTestResult> {
    return this.http.post<ConnectionTestResult>(
      apiUrl('/api/data-integration/test-connection/cloud'),
      payload,
    );
  }
}
