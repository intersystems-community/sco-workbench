import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { createSqliteAuditSink, listToolAudit, type AuditSink } from '../../src/db/audit.js';
import { ConfirmationBroker, type ConfirmRequest } from '../../src/server/confirm.js';
import { UiControlBroker } from '../../src/server/ui-control.js';
import { gateHandler } from '../../src/tools/gate.js';

/** A stand-in tool definition whose handler records whether it actually ran. */
function fakeTool(name: string) {
  const calls: unknown[] = [];
  const def = {
    name,
    description: `stub ${name}`,
    inputSchema: {} as never,
    handler: async (args: never, _extra: unknown): Promise<CallToolResult> => {
      calls.push(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ran: true }) }] };
    },
  };
  return { def, calls };
}

const payload = (res: CallToolResult) => JSON.parse((res.content[0] as { text: string }).text);

describe('SQLite audit sink', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('creates its table through the normal migration, so an existing DB gets it too', () => {
    // openDatabase() ran migrate(); no separate setup step exists or should.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_audit'`)
      .all();
    expect(tables).toHaveLength(1);
    // Re-running the migration must be safe (the file is opened on every boot).
    expect(() => openDatabase(':memory:')).not.toThrow();
  });

  it('records the tool, the prompt the user saw, the input, the decision and a timestamp', () => {
    const sink = createSqliteAuditSink(db, 'sess-1');
    sink.record({
      toolName: 'sco_compile_class',
      summary: 'Import and compile class A.B in IRIS.',
      input: { className: 'A.B', source: 'Class A.B {}' },
      decision: 'approve',
    });

    const [entry, ...rest] = listToolAudit(db, 'sess-1');
    expect(rest).toHaveLength(0);
    expect(entry!.toolName).toBe('sco_compile_class');
    expect(entry!.summary).toBe('Import and compile class A.B in IRIS.');
    expect(entry!.input).toEqual({ className: 'A.B', source: 'Class A.B {}' });
    expect(entry!.decision).toBe('approve');
    expect(entry!.createdAt).toBeTruthy();
    expect(entry!.sessionId).toBe('sess-1');
  });

  it('records rejections too — "asked and refused" is half the trail', () => {
    const sink = createSqliteAuditSink(db, 'sess-1');
    sink.record({ toolName: 'sco_build_cube', summary: 'Build cube C', input: {}, decision: 'reject' });
    expect(listToolAudit(db, 'sess-1').map((e) => e.decision)).toEqual(['reject']);
  });

  it('keeps entries in order and scopes reads to a session', () => {
    createSqliteAuditSink(db, 'a').record({ toolName: 't1', summary: 's', input: {}, decision: 'approve' });
    createSqliteAuditSink(db, 'b').record({ toolName: 't2', summary: 's', input: {}, decision: 'approve' });
    createSqliteAuditSink(db, 'a').record({ toolName: 't3', summary: 's', input: {}, decision: 'approve' });

    // Same-millisecond inserts must still sort deterministically (rowid order).
    expect(listToolAudit(db, 'a').map((e) => e.toolName)).toEqual(['t1', 't3']);
    expect(listToolAudit(db).map((e) => e.toolName)).toEqual(['t1', 't2', 't3']);
  });

  it('survives a session that no longer exists — the trail outlives what it describes', () => {
    // Deliberately NOT a foreign key: with `foreign_keys = ON` this INSERT would
    // throw, and since the gate reads a throw as "deny", referential integrity
    // here would start refusing legitimate work. Deleting a chat must not erase
    // the record of what it changed in IRIS.
    const sink = createSqliteAuditSink(db, 'never-inserted');
    expect(() => sink.record({ toolName: 't', summary: 's', input: {}, decision: 'approve' })).not.toThrow();
    expect(listToolAudit(db, 'never-inserted')).toHaveLength(1);
  });

  it('throws rather than swallowing a write failure — the gate depends on it', () => {
    const sink = createSqliteAuditSink(db, 'sess-1');
    db.close(); // simulates the sink being unable to persist
    expect(() => sink.record({ toolName: 't', summary: 's', input: {}, decision: 'approve' })).toThrow();
  });
});

describe('audit ordering in the gate', () => {
  /** Approve immediately, so these tests are about the audit, not the prompt. */
  function autoApprove(): { broker: ConfirmationBroker; seen: ConfirmRequest[] } {
    const seen: ConfirmRequest[] = [];
    const broker: ConfirmationBroker = new ConfirmationBroker((r) => {
      seen.push(r);
      broker.resolveDecision(r.confirmId, 'approve');
    });
    return { broker, seen };
  }

  /** An audit sink that records the call order against the tool's own dispatch. */
  function tracingSink(order: string[], onRecord?: () => void): AuditSink {
    return {
      record(entry) {
        order.push(`audit:${entry.decision}`);
        onRecord?.();
      },
    };
  }

  it('records BEFORE the action runs, so an unrecorded write is impossible', async () => {
    const order: string[] = [];
    const { broker } = autoApprove();
    const { def } = fakeTool('sco_compile_class');
    const traced = {
      ...def,
      handler: async (_args: never, _extra: unknown): Promise<CallToolResult> => {
        order.push('dispatch');
        return { content: [{ type: 'text' as const, text: '{"ok":true}' }] };
      },
    };

    await gateHandler(traced, broker, tracingSink(order)).handler({} as never, undefined);
    // If these were reversed, a crash between them would leave IRIS changed with
    // nothing in the trail. This ordering makes that case unreachable.
    expect(order).toEqual(['audit:approve', 'dispatch']);
  });

  it('DENIES the action when the record cannot be written (fail closed)', async () => {
    const { broker } = autoApprove();
    const { def, calls } = fakeTool('sco_build_cube');
    const broken: AuditSink = {
      record() {
        throw new Error('database is locked');
      },
    };

    const res = await gateHandler(def, broker, broken).handler({ cubeName: 'C' } as never, undefined);
    // The user APPROVED — this denial comes from the sink alone. An action that
    // cannot be recorded does not happen.
    expect(calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/audit trail/i);
    expect(payload(res).error).toMatch(/database is locked/);
  });

  it('auto-approves without prompting — records approve and runs the action', async () => {
    const order: string[] = [];
    // A broker whose emitter throws if called proves NO prompt is raised.
    const broker = new ConfirmationBroker(() => {
      throw new Error('confirmation prompt must not be raised');
    });
    const { def, calls } = fakeTool('sco_update_production');
    const gated = gateHandler(def, broker, tracingSink(order));

    const res = await gated.handler({} as never, undefined);

    expect(order).toEqual(['audit:approve']);
    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    expect(broker.outstanding).toBe(0);
  });

  it('records the summary describeAction produced for the action', async () => {
    const recorded: Array<{ summary: string; input: Record<string, unknown> }> = [];
    const broker = new ConfirmationBroker(() => {});
    const { def } = fakeTool('sco_compile_class');
    const sink: AuditSink = {
      record: (e) => recorded.push({ summary: e.summary, input: e.input }),
    };

    await gateHandler(def, broker, sink).handler({ className: 'A.B' } as never, undefined);
    // The trail records exactly what ran, with the same describeAction() text the
    // prompt used to show, so the log stays meaningful now that there's no prompt.
    expect(recorded[0]!.summary).toMatch(/compile class A\.B/);
    expect(recorded[0]!.input).toEqual({ className: 'A.B' });
  });

  it('runs with no sink supplied — audit is additive, not required to execute', async () => {
    const broker = new ConfirmationBroker(() => {});
    const { def, calls } = fakeTool('sco_build_cube');
    const res = await gateHandler(def, broker).handler({} as never, undefined);
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });
});

describe('end-to-end through the assembled server', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  /** The handlers an assembled MCP server really registered, by bare tool name. */
  function registry(server: unknown): Record<string, { handler: (a: unknown, e: unknown) => Promise<CallToolResult> }> {
    return (
      (server as { instance: unknown }).instance as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<CallToolResult> }>;
      }
    )._registeredTools;
  }

  /** A broker whose emitter throws if used — proves no confirmation is raised. */
  function noPrompt(): ConfirmationBroker {
    return new ConfirmationBroker(() => {
      throw new Error('confirmation prompt must not be raised');
    });
  }

  // A fake IRIS whose native/atelier calls no-op so a state-changing handler can
  // run to completion (auto-approved) and the sink can record it end to end.
  const fakeIris = () =>
    ({
      atelier: { importAndCompile: async () => ({ ok: true }), query: async () => ({ ok: true, rows: [] }) },
      native: { callValue: () => 1, callObject: () => null, decodeStatus: () => ({ ok: true, text: 'OK' }), drainConnectionState: () => {} },
      deepsee: {},
      kpi: {},
      kpiValues: {},
      namespace: 'SC',
      close: () => {},
    }) as never;

  it('a real auto-approved run reaches the real table', async () => {
    // The wiring that matters is createScoMcpServer → gateHandler → sink; this
    // asserts it end to end with the actual SQLite sink rather than a stub.
    const { createScoMcpServer, STATE_CHANGING_TOOLS } = await import('../../src/tools/index.js');
    const { QuestionBroker } = await import('../../src/server/question.js');

    const server = createScoMcpServer(
      fakeIris(),
      new QuestionBroker(() => {}),
      new UiControlBroker(() => {}),
      noPrompt(),
      createSqliteAuditSink(db, 'sess-e2e'),
    );
    const tools = registry(server);
    for (const bare of [...STATE_CHANGING_TOOLS]) {
      await tools[bare]!.handler({}, undefined).catch(() => undefined);
    }
    // Every mutating tool wrote a row (recorded BEFORE dispatch) — none is wired
    // without the sink, regardless of whether the fake IRIS call then succeeded.
    expect(listToolAudit(db, 'sess-e2e').map((e) => e.toolName).sort()).toEqual(
      [...STATE_CHANGING_TOOLS].sort(),
    );
    // All recorded as approved — there is no prompt/rejection any more.
    expect(new Set(listToolAudit(db, 'sess-e2e').map((e) => e.decision))).toEqual(new Set(['approve']));
  });

  it('buildOptions forwards the sink from AgentDeps into the MCP server it assembles', async () => {
    // The link the two tests above cannot see: `buildOptions` destructures the deps
    // and builds the server. Dropping `audit` there leaves the gate working, the
    // sink working, and NOTHING recorded in production — verified by mutation, the
    // suite stayed green without this test.
    const { buildOptions } = await import('../../src/agent/agent.js');
    const { QuestionBroker } = await import('../../src/server/question.js');
    const env = { SCO_NAMESPACE: 'SC', ANTHROPIC_MODEL: 'm', AGENT_MAX_TURNS: 100 } as never;

    const opts = buildOptions({
      env,
      iris: fakeIris(),
      broker: noPrompt(),
      questions: new QuestionBroker(() => {}),
      ui: new UiControlBroker(() => {}),
      audit: createSqliteAuditSink(db, 'sess-opts'),
    });

    const server = (opts.mcpServers as Record<string, unknown>).sco;
    await registry(server).sco_compile_class!.handler({ className: 'A.B' }, undefined).catch(() => undefined);
    const [entry] = listToolAudit(db, 'sess-opts');
    expect(entry?.toolName).toBe('sco_compile_class');
    expect(entry?.decision).toBe('approve');
  });
});
