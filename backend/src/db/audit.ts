import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * The audit trail of state-changing IRIS actions: what was asked, what the user
 * saw, what they decided, when.
 *
 * This is deliberately NOT the SSE event stream. Events are best-effort
 * observers — a render bug in the UI must not abort an approval, so the emitter
 * swallows failures — and that is exactly why an audit trail cannot be a
 * convention layered on top of them. A sink that is allowed to fail silently
 * records nothing on the day it matters.
 *
 * The contract is therefore the opposite one: `record` THROWS if it cannot
 * persist, and the caller (`tools/gate.ts`) turns that into a denial. An action
 * that cannot be recorded does not happen.
 */

/**
 * Mirrors `Decision` in server/confirm.ts rather than importing it: `db/` sits
 * below `server/` and nothing else here reaches upward. The two must stay
 * assignable, which tsc checks at the one call site that passes a `Decision`
 * in — so adding a third decision kind there fails the build here instead of
 * being written to a column that cannot represent it.
 */
export type AuditDecision = 'approve' | 'reject';

/** One recorded decision about one state-changing tool call. */
export interface AuditEntry {
  toolName: string;
  /** The prompt text the user actually saw (describeAction's summary). */
  summary: string;
  input: Record<string, unknown>;
  decision: AuditDecision;
}

/** A recorded entry as read back, with the fields the sink assigns. */
export interface AuditRecord extends AuditEntry {
  id: string;
  sessionId: string;
  createdAt: string;
}

/**
 * What the gate needs from an audit sink. Session-scoped, so the tool layer
 * never has to know about sessions.
 */
export interface AuditSink {
  /** Persist one decision. THROWS if it cannot — the caller must fail closed. */
  record(entry: AuditEntry): void;
}

interface AuditRow {
  id: string;
  session_id: string;
  tool_name: string;
  summary: string;
  input_json: string;
  decision: string;
  created_at: string;
}

/**
 * A sink bound to one chat session, writing to the `tool_audit` table created by
 * `migrate()`.
 */
export function createSqliteAuditSink(db: Database.Database, sessionId: string): AuditSink {
  return {
    record(entry: AuditEntry): void {
      // No try/catch: a failure here MUST propagate. Swallowing it would put the
      // decision back to fail-open, which is the whole point of this table.
      db.prepare(
        `INSERT INTO tool_audit (id, session_id, tool_name, summary, input_json, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        sessionId,
        entry.toolName,
        entry.summary,
        JSON.stringify(entry.input ?? {}),
        entry.decision,
        new Date().toISOString(),
      );
    },
  };
}

/**
 * Read the trail back, newest last. Ordered by rowid (insertion order) so rows
 * written in the same millisecond still sort deterministically — the same reason
 * `listSessions` does.
 *
 * There is no HTTP route for this yet, on purpose: exposing an audit trail needs
 * an access-control story the MVP does not have, and inventing one here would be
 * a bigger change than the sink itself. A trail nobody can read is still worth
 * writing — it is on disk beside the sessions, queryable with sqlite3 — and this
 * function is what a route or an export command would call.
 */
export function listToolAudit(db: Database.Database, sessionId?: string): AuditRecord[] {
  const rows = (
    sessionId
      ? db
          .prepare(
            `SELECT id, session_id, tool_name, summary, input_json, decision, created_at
             FROM tool_audit WHERE session_id = ? ORDER BY rowid ASC`,
          )
          .all(sessionId)
      : db
          .prepare(
            `SELECT id, session_id, tool_name, summary, input_json, decision, created_at
             FROM tool_audit ORDER BY rowid ASC`,
          )
          .all()
  ) as AuditRow[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    toolName: r.tool_name,
    summary: r.summary,
    input: safeParse(r.input_json),
    decision: r.decision as AuditDecision,
    createdAt: r.created_at,
  }));
}

/** Never let one unreadable row break the whole trail. */
function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
