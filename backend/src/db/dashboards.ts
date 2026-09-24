import type Database from 'better-sqlite3';
import { emptyDashboardConfig, type DashboardConfig } from '../dashboard/dashboard-config.js';

export interface DashboardRecord {
  id: string;
  name: string;
  config: DashboardConfig;
  updatedAt: string;
}

interface DashboardRow { id: string; name: string; config_json: string; updated_at: string }

/**
 * Repository for saved dashboards. One row per dashboard id holds its full
 * DashboardConfig as JSON + a display name. Mirrors CubeDraftRepository: upsert
 * by id, reads return fresh immutable records, writes never mutate their input.
 * Reads are pure — get() NEVER rewrites a row (a corrupt blob is surfaced as an
 * empty config for the caller to handle, not silently healed): the route layer
 * re-validates on read and only an explicit PUT persists (spec §3 DA-SPEC-06).
 */
export class DashboardRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(id: string, name: string, config: DashboardConfig): DashboardRecord {
    const rec: DashboardRecord = { id, name, config, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO dashboards (id, name, config_json, updated_at)
         VALUES (@id, @name, @config_json, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name        = excluded.name,
           config_json = excluded.config_json,
           updated_at  = excluded.updated_at`,
      )
      .run({ id, name, config_json: JSON.stringify(config), updated_at: rec.updatedAt });
    return rec;
  }

  get(id: string): DashboardRecord | null {
    const row = this.db
      .prepare('SELECT id, name, config_json, updated_at FROM dashboards WHERE id = ?')
      .get(id) as DashboardRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(): DashboardRecord[] {
    const rows = this.db
      .prepare('SELECT id, name, config_json, updated_at FROM dashboards ORDER BY id')
      .all() as DashboardRow[];
    return rows.map(rowToRecord);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
  }
}

function rowToRecord(row: DashboardRow): DashboardRecord {
  return { id: row.id, name: row.name, config: safeParse(row.config_json), updatedAt: row.updated_at };
}

function safeParse(json: string): DashboardConfig {
  try {
    return JSON.parse(json) as DashboardConfig;
  } catch {
    return emptyDashboardConfig();
  }
}
