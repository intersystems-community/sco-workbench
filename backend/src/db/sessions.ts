import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  /** The Agent SDK session id to resume on follow-up turns (null until first turn). */
  sdkSessionId?: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  /** Short human-facing label to render instead of `content` (e.g. a Deploy's
   *  friendly one-liner). Absent → render `content`. Never replayed to the agent. */
  displayText?: string | null;
  toolCalls?: unknown;
  createdAt: string;
}

/** Fields accepted when appending a message (id/timestamp are assigned here). */
export interface NewMessage {
  role: MessageRole;
  content: string;
  displayText?: string | null;
  toolCalls?: unknown;
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  sdk_session_id: string | null;
}
interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  display_text: string | null;
  tool_calls_json: string | null;
  created_at: string;
}

/**
 * Repository for chat sessions and messages (SQLite). All reads return fresh
 * immutable records; writes never mutate their inputs.
 */
export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  createSession(title: string): Session {
    const session: Session = {
      id: randomUUID(),
      title: title.trim() || 'Untitled session',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)')
      .run(session.id, session.title, session.createdAt);
    return session;
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare('SELECT id, title, created_at, sdk_session_id FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(): Session[] {
    // Order by rowid (monotonic insertion order) so same-millisecond inserts
    // still sort deterministically newest-first.
    const rows = this.db
      .prepare('SELECT id, title, created_at, sdk_session_id FROM sessions ORDER BY rowid DESC')
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Persist the Agent SDK session id so later turns can resume the conversation. */
  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
  }

  /** Delete a session and its messages (messages cascade via the FK). Returns
   *  true if a row was removed, false if the id didn't exist. */
  deleteSession(id: string): boolean {
    const info = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  appendMessage(sessionId: string, msg: NewMessage): Message {
    const record: Message = {
      id: randomUUID(),
      sessionId,
      role: msg.role,
      content: msg.content,
      displayText: msg.displayText ?? null,
      toolCalls: msg.toolCalls,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, display_text, tool_calls_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.role,
        record.content,
        record.displayText ?? null,
        record.toolCalls === undefined ? null : JSON.stringify(record.toolCalls),
        record.createdAt,
      );
    return record;
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, role, content, display_text, tool_calls_json, created_at
         FROM messages WHERE session_id = ? ORDER BY rowid ASC`,
      )
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }
}

function rowToSession(r: SessionRow): Session {
  return { id: r.id, title: r.title, createdAt: r.created_at, sdkSessionId: r.sdk_session_id };
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as MessageRole,
    content: r.content,
    displayText: r.display_text,
    toolCalls: r.tool_calls_json ? JSON.parse(r.tool_calls_json) : undefined,
    createdAt: r.created_at,
  };
}
