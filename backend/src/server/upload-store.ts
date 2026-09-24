/**
 * In-process staging store for Data Integration file uploads.
 *
 * A freshly uploaded file's bytes are held here briefly (multer.memoryStorage +
 * this Map) between `POST /uploads` and the moment they are copied into SQLite
 * (durable) at step-save, or materialized into IRIS at Deploy. Nothing is written
 * to the app container's own disk. Entries are evicted after an idle TTL so
 * abandoned bytes don't linger in RAM.
 *
 * Owned by the app (one instance per createApp) and shared by the uploads router
 * and the integration-case router, so per-app scoping holds in tests.
 */

/**
 * File kinds:
 *   `csv`      = data file (not secret).
 *   `ssh-key`  = SSH key material (0600) — staged verbatim.
 *   `aws-cred` = AWS credentials file (0600) — normalized to a `[default]` profile.
 */
export type UploadKind = 'csv' | 'ssh-key' | 'aws-cred';

/** A file held in memory awaiting persistence/materialization. */
export interface PendingUpload {
  fileId: string;
  originalName: string;
  kind: UploadKind;
  /** The path this file WILL occupy inside the IRIS container. */
  irisPath: string;
  /** Key/credentials files are materialized 0600. */
  secret: boolean;
  /** The uploaded bytes. Released (null) once materialized into IRIS. */
  bytes: Buffer | null;
  /** Epoch ms when accepted, for idle-TTL eviction. */
  addedAt: number;
}

/** Drop an un-persisted upload after this long so abandoned bytes don't linger. */
const UPLOAD_TTL_MS = 30 * 60 * 1000;

export class PendingUploadStore {
  private readonly pending = new Map<string, PendingUpload>();

  set(u: PendingUpload): void {
    this.pending.set(u.fileId, u);
  }

  get(fileId: string): PendingUpload | undefined {
    return this.pending.get(fileId);
  }

  delete(fileId: string): void {
    this.pending.delete(fileId);
  }

  /** Evict idle uploads so abandoned bytes don't accumulate in memory. */
  evictExpired(now: number = Date.now()): void {
    for (const [id, u] of this.pending) {
      if (now - u.addedAt > UPLOAD_TTL_MS) this.pending.delete(id);
    }
  }
}
