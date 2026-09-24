import type Database from 'better-sqlite3';

/** A DI case's lifecycle status. */
export type IntegrationCaseStatus = 'draft' | 'deployed';

/** The persisted case. `definition` is the frontend IntegrationJob (opaque to
 *  the backend) with DB/FTP passwords already encrypted by the router layer. */
export interface IntegrationCase {
  id: string;
  name: string;
  status: IntegrationCaseStatus;
  definition: Record<string, unknown>;
  updatedAt: string;
}

/** Metadata for a stored file (bytes fetched separately, on demand). */
export interface IntegrationFileMeta {
  fileId: string;
  slot: string;
  kind: string;
  originalName: string;
  irisPath: string;
  secret: boolean;
  encrypted: boolean;
}

/** A stored file's bytes plus the metadata needed to materialize it into IRIS. */
export interface IntegrationFileBytes extends IntegrationFileMeta {
  bytes: Buffer;
}

interface CaseRow {
  id: string;
  name: string;
  status: string;
  definition_json: string;
  updated_at: string;
}

interface FileRow {
  file_id: string;
  case_id: string;
  slot: string;
  kind: string;
  original_name: string;
  iris_path: string;
  secret: number;
  encrypted: number;
  bytes: Buffer;
}

/**
 * Repository for Data Integration cases + their uploaded file bytes (SQLite).
 * A dumb store: encryption/decryption of passwords and secret file bytes happens
 * in the router layer, mirroring the cube/kpi draft repositories. All reads
 * return fresh records; writes never mutate their inputs.
 */
export class IntegrationCaseRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Cases ────────────────────────────────────────────────────────
  upsert(
    id: string,
    name: string,
    status: IntegrationCaseStatus,
    definition: Record<string, unknown>,
  ): IntegrationCase {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO integration_cases (id, name, status, definition_json, updated_at)
         VALUES (@id, @name, @status, @definition_json, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name            = excluded.name,
           status          = excluded.status,
           definition_json = excluded.definition_json,
           updated_at      = excluded.updated_at`,
      )
      .run({ id, name, status, definition_json: JSON.stringify(definition), updated_at: updatedAt });
    return { id, name, status, definition, updatedAt };
  }

  get(id: string): IntegrationCase | null {
    const row = this.db
      .prepare('SELECT id, name, status, definition_json, updated_at FROM integration_cases WHERE id = ?')
      .get(id) as CaseRow | undefined;
    return row ? rowToCase(row) : null;
  }

  list(): IntegrationCase[] {
    // rowid DESC → newest-first, deterministic on same-millisecond inserts.
    const rows = this.db
      .prepare('SELECT id, name, status, definition_json, updated_at FROM integration_cases ORDER BY rowid DESC')
      .all() as CaseRow[];
    return rows.map(rowToCase);
  }

  setStatus(id: string, status: IntegrationCaseStatus): void {
    this.db
      .prepare('UPDATE integration_cases SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  /** Delete a case and its files (files cascade via the FK). Returns true if a
   *  row was removed. */
  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM integration_cases WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ── Files ────────────────────────────────────────────────────────
  /** Store (replace) the bytes for one (case, slot). Any prior row for that slot
   *  is removed first so a re-pick never leaves an orphan. */
  putFile(caseId: string, meta: IntegrationFileMeta, bytes: Buffer): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM integration_files WHERE case_id = ? AND slot = ?').run(caseId, meta.slot);
      this.db
        .prepare(
          `INSERT INTO integration_files
             (file_id, case_id, slot, kind, original_name, iris_path, secret, encrypted, bytes, updated_at)
           VALUES (@file_id, @case_id, @slot, @kind, @original_name, @iris_path, @secret, @encrypted, @bytes, @updated_at)`,
        )
        .run({
          file_id: meta.fileId,
          case_id: caseId,
          slot: meta.slot,
          kind: meta.kind,
          original_name: meta.originalName,
          iris_path: meta.irisPath,
          secret: meta.secret ? 1 : 0,
          encrypted: meta.encrypted ? 1 : 0,
          bytes,
          updated_at: new Date().toISOString(),
        });
    });
    tx();
  }

  /** Metadata for every file of a case (no bytes). */
  getFilesMeta(caseId: string): IntegrationFileMeta[] {
    const rows = this.db
      .prepare(
        `SELECT file_id, case_id, slot, kind, original_name, iris_path, secret, encrypted, bytes
         FROM integration_files WHERE case_id = ? ORDER BY slot`,
      )
      .all(caseId) as FileRow[];
    return rows.map(rowToFileMeta);
  }

  /** One file's bytes + metadata (for materialization at Deploy). */
  getFileBytes(fileId: string): IntegrationFileBytes | null {
    const row = this.db
      .prepare(
        `SELECT file_id, case_id, slot, kind, original_name, iris_path, secret, encrypted, bytes
         FROM integration_files WHERE file_id = ?`,
      )
      .get(fileId) as FileRow | undefined;
    if (!row) return null;
    return { ...rowToFileMeta(row), bytes: row.bytes };
  }

  /** One slot's bytes + metadata for a case, or null when that slot is empty. Used
   *  to recover a reopened case's persisted secret (SFTP key / cloud credentials
   *  file) at Test/Browse time, since the browser no longer holds its contents. */
  getFileBytesBySlot(caseId: string, slot: string): IntegrationFileBytes | null {
    const row = this.db
      .prepare(
        `SELECT file_id, case_id, slot, kind, original_name, iris_path, secret, encrypted, bytes
         FROM integration_files WHERE case_id = ? AND slot = ?`,
      )
      .get(caseId, slot) as FileRow | undefined;
    if (!row) return null;
    return { ...rowToFileMeta(row), bytes: row.bytes };
  }

  clearSlot(caseId: string, slot: string): void {
    this.db.prepare('DELETE FROM integration_files WHERE case_id = ? AND slot = ?').run(caseId, slot);
  }
}

function rowToCase(row: CaseRow): IntegrationCase {
  return {
    id: row.id,
    name: row.name,
    status: (row.status as IntegrationCaseStatus) ?? 'draft',
    definition: safeParse(row.definition_json),
    updatedAt: row.updated_at,
  };
}

function rowToFileMeta(row: FileRow): IntegrationFileMeta {
  return {
    fileId: row.file_id,
    slot: row.slot,
    kind: row.kind,
    originalName: row.original_name,
    irisPath: row.iris_path,
    secret: row.secret === 1,
    encrypted: row.encrypted === 1,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
