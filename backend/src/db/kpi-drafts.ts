import type Database from 'better-sqlite3';
import type { KpiDefinition } from '../kpi/kpi-definition.model.js';

/**
 * A KPI's lifecycle state in the Workbench.
 *   - 'draft'   : saved locally only; not yet created in IRIS via the SCO API.
 *   - 'created' : successfully submitted to IRIS (a real KpiDefinition exists).
 */
export type KpiState = 'draft' | 'created';

export interface KpiDraft {
  kpiName: string;
  definition: KpiDefinition;
  state: KpiState;
  updatedAt: string;
}

interface KpiDraftRow {
  kpi_name: string;
  definition_json: string;
  state: string;
  updated_at: string;
}

/**
 * Repository for locally-saved KPI definitions (the Business KPIs editor). One
 * row per KPI name holds its full definition JSON and lifecycle state, so an
 * incomplete edit survives navigation and the list can flag draft vs created.
 *
 * Unlike cubes, KPI create/update/delete happens through the SCO REST API (the
 * IRIS proxy), so a 'created' draft is bookkeeping only — the source of truth is
 * IRIS. A draft row is deleted once its edit is submitted (promoted to IRIS) so
 * the merged list shows a single, authoritative entry.
 *
 * All reads return fresh immutable records; writes never mutate their inputs.
 */
export class KpiDraftRepository {
  constructor(private readonly db: Database.Database) {}

  /** Insert or update a KPI's saved definition + state (upsert by name). */
  upsert(kpiName: string, definition: KpiDefinition, state: KpiState): KpiDraft {
    const draft: KpiDraft = {
      kpiName,
      definition,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO kpi_drafts (kpi_name, definition_json, state, updated_at)
         VALUES (@kpi_name, @definition_json, @state, @updated_at)
         ON CONFLICT(kpi_name) DO UPDATE SET
           definition_json = excluded.definition_json,
           state           = excluded.state,
           updated_at      = excluded.updated_at`,
      )
      .run({
        kpi_name: kpiName,
        definition_json: JSON.stringify(definition),
        state,
        updated_at: draft.updatedAt,
      });
    return draft;
  }

  get(kpiName: string): KpiDraft | null {
    const row = this.db
      .prepare('SELECT kpi_name, definition_json, state, updated_at FROM kpi_drafts WHERE kpi_name = ?')
      .get(kpiName) as KpiDraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  list(): KpiDraft[] {
    const rows = this.db
      .prepare('SELECT kpi_name, definition_json, state, updated_at FROM kpi_drafts ORDER BY kpi_name')
      .all() as KpiDraftRow[];
    return rows.map(rowToDraft);
  }

  delete(kpiName: string): void {
    this.db.prepare('DELETE FROM kpi_drafts WHERE kpi_name = ?').run(kpiName);
  }
}

function rowToDraft(row: KpiDraftRow): KpiDraft {
  return {
    kpiName: row.kpi_name,
    definition: safeParse(row.definition_json),
    state: (row.state as KpiState) ?? 'draft',
    updatedAt: row.updated_at,
  };
}

function safeParse(json: string): KpiDefinition {
  try {
    return JSON.parse(json) as KpiDefinition;
  } catch {
    return { name: '' };
  }
}
