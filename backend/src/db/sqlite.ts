import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Open (and migrate) the SQLite database used for chat session storage.
 * Uses WAL mode for concurrent reads. Pass ':memory:' in tests.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Idempotent schema migration. Safe to run on every startup. */
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      -- The Agent SDK's own session id, captured from the stream. Used to
      -- resume the conversation on follow-up turns so the agent keeps context
      -- instead of restarting from scratch.
      sdk_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role           TEXT NOT NULL,
      content        TEXT NOT NULL,
      -- The short, human-facing label to render in the UI when it differs from
      -- content (e.g. a Deploy sends a long system prompt as content but shows
      -- "Start to run the integration process..."). NULL means render content.
      -- The agent's follow-up turns always replay content, never this label.
      display_text   TEXT,
      tool_calls_json TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    -- Persisted cube definitions for the Analytics Cubes editor. A cube's
    -- authoring state lives here (its full definition JSON + lifecycle state)
    -- so an incomplete edit survives navigation, and the list can section cubes
    -- by draft / compiled / built. Keyed by the cube name (one draft per cube).
    CREATE TABLE IF NOT EXISTS cube_drafts (
      cube_name       TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      state           TEXT NOT NULL,   -- 'draft' | 'compiled' | 'built'
      updated_at      TEXT NOT NULL
    );

    -- Locally-saved KPI definitions for the Business KPIs editor. Mirrors
    -- cube_drafts: a KPI's authoring state (full definition JSON + lifecycle
    -- state) lives here so an incomplete edit survives navigation. KPI CRUD
    -- itself goes through the SCO REST API, so a 'created' row is bookkeeping;
    -- IRIS is the source of truth. Keyed by KPI name (one draft per KPI).
    CREATE TABLE IF NOT EXISTS kpi_drafts (
      kpi_name        TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      state           TEXT NOT NULL,   -- 'draft' | 'created'
      updated_at      TEXT NOT NULL
    );

    -- The saved dashboard(s): a serialized DashboardConfig (schemaVersion + the
    -- ordered heterogeneous tile list) per dashboard, blobbed as JSON — the same
    -- "store the domain object, key by id" move cube_drafts/kpi_drafts make. Only
    -- the 'default' row is written today; the id/name columns exist from day one
    -- so many named dashboards later need ZERO schema migration (spec §6).
    CREATE TABLE IF NOT EXISTS dashboards (
      id          TEXT PRIMARY KEY,   -- 'default' now; real ids when many arrive
      name        TEXT NOT NULL,      -- 'Dashboard' now; user-named later
      config_json TEXT NOT NULL,      -- the full DashboardConfig
      updated_at  TEXT NOT NULL
    );

    -- Persisted Data Integration cases (the DI wizard). One row per case holds
    -- the full IntegrationJob as JSON (with DB/FTP passwords encrypted at rest),
    -- so a step-wise edit survives refresh/restart and the list can show a
    -- Draft / Deployed badge. Keyed by a generated case id (randomUUID); the
    -- GET /cases list re-hydrates ids after a browser refresh.
    CREATE TABLE IF NOT EXISTS integration_cases (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL,   -- 'draft' | 'deployed'
      definition_json TEXT NOT NULL,   -- full IntegrationJob; passwords encrypted
      updated_at      TEXT NOT NULL
    );

    -- The bytes of files uploaded for a DI case (CSV / SSH key / PEM / AWS
    -- credentials). Held here durably (survives refresh/restart) and materialized
    -- into IRIS at Deploy. Secret files (ssh-key / aws-cred) are encrypted at
    -- rest (encrypted=1); csv/pem/jar are stored verbatim. One row per (case,
    -- slot); re-picking a slot replaces its row. iris_path is the deterministic
    -- target path already baked into the case's source config + the deploy prompt.
    CREATE TABLE IF NOT EXISTS integration_files (
      file_id       TEXT PRIMARY KEY,
      case_id       TEXT NOT NULL REFERENCES integration_cases(id) ON DELETE CASCADE,
      slot          TEXT NOT NULL,     -- 'publicKey'|'privateKey'|'cloudCred'|'localFile'
      kind          TEXT NOT NULL,     -- 'csv'|'ssh-key'|'aws-cred'
      original_name TEXT NOT NULL,
      iris_path     TEXT NOT NULL,
      secret        INTEGER NOT NULL,  -- 0/1
      encrypted     INTEGER NOT NULL,  -- 1 iff bytes are encrypted (ssh-key/aws-cred)
      bytes         BLOB NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_integration_files_case ON integration_files(case_id);

    -- The audit trail of state-changing IRIS actions (see db/audit.ts). Written
    -- BEFORE the action runs, and a failure to write denies the action — so this
    -- table is on the critical path, not an observer of it.
    --
    -- Deliberately NOT a foreign key to sessions(id): with foreign_keys = ON a
    -- deleted or not-yet-inserted session would make the INSERT throw, and since
    -- the gate reads a throw as "deny", a referential-integrity detail would
    -- start blocking legitimate work. The audit trail must outlive the session
    -- it describes; ON DELETE CASCADE would erase exactly the record someone
    -- deleting their history has the most reason to want kept.
    CREATE TABLE IF NOT EXISTS tool_audit (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      tool_name      TEXT NOT NULL,
      -- The prompt text the user actually saw, not a reconstruction of it.
      summary        TEXT NOT NULL,
      input_json     TEXT NOT NULL,
      decision       TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_audit_session ON tool_audit(session_id);
  `);

  // Migration for pre-existing DBs that lack sdk_session_id.
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'sdk_session_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`);
  }

  // Migration for pre-existing DBs that lack messages.display_text.
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === 'display_text')) {
    db.exec(`ALTER TABLE messages ADD COLUMN display_text TEXT`);
  }
}
