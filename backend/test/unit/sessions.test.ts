import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/sqlite.js';
import { SessionRepository } from '../../src/db/sessions.js';

describe('SessionRepository', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a session with an id and timestamp', () => {
    const s = repo.createSession('My first cube');
    expect(s.id).toBeTruthy();
    expect(s.title).toBe('My first cube');
    expect(s.createdAt).toBeTruthy();
  });

  it('lists sessions newest-first', () => {
    const a = repo.createSession('A');
    const b = repo.createSession('B');
    const list = repo.listSessions();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('appends and retrieves messages in order', () => {
    const s = repo.createSession('chat');
    repo.appendMessage(s.id, { role: 'user', content: 'build a cube' });
    repo.appendMessage(s.id, { role: 'assistant', content: 'sure' });
    const msgs = repo.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'build a cube'],
      ['assistant', 'sure'],
    ]);
  });

  it('persists optional tool_calls as JSON and returns it parsed', () => {
    const s = repo.createSession('chat');
    repo.appendMessage(s.id, {
      role: 'assistant',
      content: 'compiling',
      toolCalls: [{ name: 'sco_compile_class', args: { className: 'A.B' } }],
    });
    const [msg] = repo.getMessages(s.id);
    expect(msg!.toolCalls).toEqual([{ name: 'sco_compile_class', args: { className: 'A.B' } }]);
  });

  it('persists a display_text label distinct from content, and defaults it to null', () => {
    const s = repo.createSession('chat');
    // A Deploy: full prompt in content, friendly one-liner in displayText.
    repo.appendMessage(s.id, {
      role: 'user',
      content: 'Deploy the data-integration pipeline "l1" — do the whole thing…',
      displayText: 'Start to run the integration process: l1',
    });
    // A normal message: no displayText → stored/returned as null.
    repo.appendMessage(s.id, { role: 'user', content: 'plain message' });
    const [deploy, plain] = repo.getMessages(s.id);
    expect(deploy!.content).toMatch(/^Deploy the data-integration/);
    expect(deploy!.displayText).toBe('Start to run the integration process: l1');
    expect(plain!.displayText).toBeNull();
  });

  it('getSession returns null for an unknown id', () => {
    expect(repo.getSession('nope')).toBeNull();
  });

  it('deleteSession removes the session and cascades its messages', () => {
    const s = repo.createSession('to delete');
    repo.appendMessage(s.id, { role: 'user', content: 'hi' });
    repo.appendMessage(s.id, { role: 'assistant', content: 'hello' });
    expect(repo.deleteSession(s.id)).toBe(true);
    expect(repo.getSession(s.id)).toBeNull();
    // Messages cascade-deleted with the session (FK ON DELETE CASCADE).
    expect(repo.getMessages(s.id)).toEqual([]);
    expect(repo.listSessions().some((x) => x.id === s.id)).toBe(false);
  });

  it('deleteSession returns false for an unknown id', () => {
    expect(repo.deleteSession('nope')).toBe(false);
  });

  it('does not mutate the input when appending (returns a fresh record)', () => {
    const s = repo.createSession('chat');
    const input = { role: 'user' as const, content: 'hi' };
    const frozen = Object.freeze({ ...input });
    const saved = repo.appendMessage(s.id, frozen);
    expect(saved.id).toBeTruthy();
    expect(saved.content).toBe('hi');
    expect(saved.sessionId).toBe(s.id);
  });
});
