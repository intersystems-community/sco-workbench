import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/**
 * What an upload is used for.
 *   `csv`      = data file.
 *   `ssh-key`  = SSH key material (staged verbatim, 0600).
 *   `aws-cred` = AWS credentials file (0600) — the backend normalizes it to a
 *                `[default]` profile, which is the only profile the IRIS Cloud
 *                adapter reads. Labeled distinctly from `ssh-key` so SSH keys are
 *                never parsed/rewritten.
 */
export type UploadKind = 'csv' | 'ssh-key' | 'aws-cred';

/** Response from POST /uploads: the file's id + the path it WILL occupy in IRIS. */
export interface UploadResult {
  fileId: string;
  /** The absolute path inside the IRIS container the adapter config should use. */
  irisPath: string;
  originalName: string;
  kind: UploadKind;
}

/** Per-file outcome of a materialize call. */
export interface MaterializeResult {
  fileId: string;
  irisPath: string;
  ok: boolean;
  error?: string;
}

/**
 * Uploads Data Integration files (CSV data files, SSH/AWS key + credential files)
 * to the backend, and materializes them into the user's IRIS container.
 *
 * The backend holds uploaded bytes IN MEMORY only (never on disk) and returns the
 * deterministic path the file will occupy inside IRIS — so the caller stores that
 * `irisPath` on the source config immediately, and the bytes are pushed to that
 * exact path later, at Deploy, via `materialize`.
 */
@Injectable({ providedIn: 'root' })
export class UploadService {
  constructor(private http: HttpClient) {}

  /** Upload one file; the returned `irisPath` is what the adapter config needs. */
  uploadFile(file: File, kind: UploadKind): Observable<UploadResult> {
    const body = new FormData();
    body.append('kind', kind);
    body.append('file', file, file.name);
    // The auth interceptor attaches the bearer token; do NOT set Content-Type —
    // the browser sets the multipart boundary itself.
    return this.http.post<UploadResult>(apiUrl('/api/data-integration/uploads'), body);
  }

  /** Stream the named files into IRIS (called at Save). */
  materialize(fileIds: string[]): Observable<{ results: MaterializeResult[] }> {
    return this.http.post<{ results: MaterializeResult[] }>(
      apiUrl('/api/data-integration/uploads/materialize'),
      { fileIds },
    );
  }

  /**
   * Ensure a SQL source's JDBC driver JAR is present in the IRIS container, and
   * return the in-container path to set as the deployed GenericService's
   * `JDBCClasspath`. Called at Save, before the agent runs. For a database whose
   * driver isn't already on the Java Gateway classpath (e.g. PostgreSQL) the
   * backend pushes the JAR into IRIS; for IRIS it stages nothing and returns an
   * empty `irisPath`. Idempotent on the backend.
   */
  ensureDriverJar(dbType: string): Observable<{ ok: boolean; irisPath: string }> {
    return this.http.post<{ ok: boolean; irisPath: string }>(
      apiUrl('/api/data-integration/driver-jar'),
      { dbType },
    );
  }
}
