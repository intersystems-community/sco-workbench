import type Database from 'better-sqlite3';
import type { CubeDefinition } from '../cube/cube-definition.model.js';

/** A cube's lifecycle state in the Workbench. */
export type CubeState = 'draft' | 'compiled' | 'built';

export interface CubeDraft {
  cubeName: string;
  definition: CubeDefinition;
  state: CubeState;
  updatedAt: string;
}

interface CubeDraftRow {
  cube_name: string;
  definition_json: string;
  state: string;
  updated_at: string;
}

/**
 * Repository for persisted cube definitions (the Analytics Cubes editor). One
 * row per cube name holds its full definition JSON and lifecycle state, so an
 * incomplete edit survives navigation and the list can group by state.
 *
 * All reads return fresh immutable records; writes never mutate their inputs.
 */
export class CubeDraftRepository {
  constructor(private readonly db: Database.Database) {}

  /** Insert or update a cube's saved definition + state (upsert by name). */
  upsert(cubeName: string, definition: CubeDefinition, state: CubeState): CubeDraft {
    const draft: CubeDraft = {
      cubeName,
      definition,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO cube_drafts (cube_name, definition_json, state, updated_at)
         VALUES (@cube_name, @definition_json, @state, @updated_at)
         ON CONFLICT(cube_name) DO UPDATE SET
           definition_json = excluded.definition_json,
           state           = excluded.state,
           updated_at      = excluded.updated_at`,
      )
      .run({
        cube_name: cubeName,
        definition_json: JSON.stringify(definition),
        state,
        updated_at: draft.updatedAt,
      });
    return draft;
  }

  /** Set only the state for a cube (e.g. draft → compiled → built). No-op if absent. */
  setState(cubeName: string, state: CubeState): void {
    this.db
      .prepare('UPDATE cube_drafts SET state = ?, updated_at = ? WHERE cube_name = ?')
      .run(state, new Date().toISOString(), cubeName);
  }

  get(cubeName: string): CubeDraft | null {
    const row = this.db
      .prepare('SELECT cube_name, definition_json, state, updated_at FROM cube_drafts WHERE cube_name = ?')
      .get(cubeName) as CubeDraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  list(): CubeDraft[] {
    const rows = this.db
      .prepare('SELECT cube_name, definition_json, state, updated_at FROM cube_drafts ORDER BY cube_name')
      .all() as CubeDraftRow[];
    return rows.map(rowToDraft);
  }

  delete(cubeName: string): void {
    this.db.prepare('DELETE FROM cube_drafts WHERE cube_name = ?').run(cubeName);
  }
}

function rowToDraft(row: CubeDraftRow): CubeDraft {
  return {
    cubeName: row.cube_name,
    definition: safeParse(row.definition_json),
    state: (row.state as CubeState) ?? 'draft',
    updatedAt: row.updated_at,
  };
}

function safeParse(json: string): CubeDefinition {
  try {
    return JSON.parse(json) as CubeDefinition;
  } catch {
    return { cubeName: '', sourceClass: '' };
  }
}
