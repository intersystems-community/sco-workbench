import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/**
 * Persistence for Data Integration cases. Cases (the DI wizard's saved state) live
 * in SQLite on the backend — NOT in the browser — so they survive refresh/restart.
 *
 * Passwords are encrypted at rest and never returned: a GET replaces a stored
 * password with a "saved" sentinel so the UI shows a saved state without holding
 * the secret. On save, echoing that sentinel keeps the previously stored value.
 * The IRIS credential is created server-side at Deploy from the decrypted password
 * (see `createCredentialFromCase`), so the plaintext never re-enters the browser.
 *
 * Mirrors the backend routes in `integration-case-routes.ts`.
 */

/** Status shown in the UI. The backend only ever reports these two. */
export type CaseStatus = 'draft' | 'deployed';

/** A saved case as returned by the backend (passwords redacted to the sentinel). */
export interface SavedCase {
  id: string;
  name: string;
  status: CaseStatus;
  definition: Record<string, unknown>;
  updatedAt?: string;
}

/** File metadata for a saved case (bytes stay in SQLite; only metadata is returned). */
export interface SavedFileMeta {
  fileId: string;
  slot: string;
  kind: string;
  originalName: string;
  irisPath: string;
  secret?: boolean;
}

@Injectable({ providedIn: 'root' })
export class DataIntegrationService {
  constructor(private http: HttpClient) {}

  /** List all saved cases (most-recent first), passwords redacted. */
  list(): Observable<{ cases: SavedCase[] }> {
    return this.http.get<{ cases: SavedCase[] }>(apiUrl('/api/data-integration/cases'));
  }

  /** One case + its persisted file metadata, for restore. */
  get(id: string): Observable<{ case: SavedCase; files: SavedFileMeta[] }> {
    return this.http.get<{ case: SavedCase; files: SavedFileMeta[] }>(
      apiUrl(`/api/data-integration/cases/${encodeURIComponent(id)}`),
    );
  }

  /** Upsert a (possibly partial) case. The backend encrypts passwords at rest. */
  save(caseObj: { id: string; name: string; source?: unknown; [k: string]: unknown }): Observable<{ ok: boolean; id: string; status: CaseStatus }> {
    return this.http.post<{ ok: boolean; id: string; status: CaseStatus }>(
      apiUrl('/api/data-integration/cases/save'),
      { case: caseObj },
    );
  }

  /** Persist an uploaded file's bytes into SQLite for a case slot (durable). */
  putFile(id: string, slot: string, fileId: string): Observable<{ ok: boolean; slot: string; irisPath: string; originalName: string }> {
    return this.http.post<{ ok: boolean; slot: string; irisPath: string; originalName: string }>(
      apiUrl(`/api/data-integration/cases/${encodeURIComponent(id)}/files`),
      { slot, fileId },
    );
  }

  /** Clear a slot's persisted file. */
  clearSlot(id: string, slot: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(
      apiUrl(`/api/data-integration/cases/${encodeURIComponent(id)}/files/${encodeURIComponent(slot)}`),
    );
  }

  /** Advance/persist a case's status; the agent's deploy outcome drives this. */
  setStatus(id: string, status: CaseStatus): Observable<{ ok: boolean; id: string; status: CaseStatus }> {
    return this.http.post<{ ok: boolean; id: string; status: CaseStatus }>(
      apiUrl(`/api/data-integration/cases/${encodeURIComponent(id)}/status`),
      { status },
    );
  }

  /** Delete a case. The backend returns 409 for a deployed case. */
  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(apiUrl(`/api/data-integration/cases/${encodeURIComponent(id)}`));
  }

  /**
   * Create the IRIS Credentials entry for a saved case's source at Deploy, using
   * the DECRYPTED password held only in SQLite. Returns the credential name (or
   * null when the adapter references none, e.g. cloud/file). The password never
   * enters the browser or the agent prompt.
   */
  createCredentialFromCase(id: string): Observable<{ ok: boolean; name: string | null }> {
    return this.http.post<{ ok: boolean; name: string | null }>(
      apiUrl(`/api/data-integration/credentials/from-case/${encodeURIComponent(id)}`),
      {},
    );
  }
}
