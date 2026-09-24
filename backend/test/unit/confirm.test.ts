import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConfirmationBroker, describeAction, type ConfirmRequest } from '../../src/server/confirm.js';
import { QuestionBroker } from '../../src/server/question.js';
import { UiControlBroker } from '../../src/server/ui-control.js';
import { makeCanUseTool, buildOptions } from '../../src/agent/agent.js';
import {
  qualifiedToolName,
  isStateChanging,
  createScoMcpServer,
  ALL_TOOL_NAMES,
  STATE_CHANGING_TOOLS,
} from '../../src/tools/index.js';
import { gateHandler } from '../../src/tools/gate.js';
import type { AuditEntry, AuditSink } from '../../src/db/audit.js';
import type { Env } from '../../src/config/env.js';
import type { IrisServices } from '../../src/iris/index.js';

/** A no-op UI-control broker for the agent-mode/gate-wiring tests. */
const noUi = new UiControlBroker(() => {});

/** Minimal IrisServices stand-in — no tool handler is invoked in these tests. */
function fakeIris(): IrisServices {
  return { atelier: {}, native: {}, namespace: 'SC', close: () => {} } as unknown as IrisServices;
}

describe('ConfirmationBroker', () => {
  it('emits a request and resolves with the user decision', async () => {
    let emitted: ConfirmRequest | undefined;
    const broker = new ConfirmationBroker((r) => (emitted = r));
    const p = broker.request('sco_build_cube', 'Build cube X', { cubeName: 'X' });
    expect(emitted).toBeDefined();
    expect(broker.outstanding).toBe(1);

    broker.resolveDecision(emitted!.confirmId, 'approve');
    await expect(p).resolves.toBe('approve');
    expect(broker.outstanding).toBe(0);
  });

  it('resolveDecision returns false for an unknown id', () => {
    const broker = new ConfirmationBroker(() => {});
    expect(broker.resolveDecision('missing', 'approve')).toBe(false);
  });

  it('rejectAll resolves outstanding requests as reject', async () => {
    const broker = new ConfirmationBroker(() => {});
    const p = broker.request('sco_update_production', 'Update', {});
    broker.rejectAll();
    await expect(p).resolves.toBe('reject');
  });
});

describe('describeAction', () => {
  it('summarizes compile with the class name', () => {
    expect(describeAction('sco_compile_class', { className: 'A.B' })).toMatch(/compile class A\.B/);
  });
  it('summarizes add config item with class + production', () => {
    expect(
      describeAction('sco_add_config_item', { className: 'A.BP', productionName: 'My.Prod' }),
    ).toMatch(/A\.BP.*My\.Prod/);
  });
  it('works with the mcp-qualified name', () => {
    expect(describeAction(qualifiedToolName('sco_build_cube'), { cubeName: 'C' })).toMatch(/Build.*cube C/);
  });
  it('summarizes KPI create/update/delete with the KPI name', () => {
    expect(describeAction('sco_create_kpi', { definition: { name: 'LateShip' } })).toMatch(/Create Business KPI "LateShip"/);
    expect(describeAction('sco_update_kpi', { name: 'LateShip' })).toMatch(/Update Business KPI "LateShip"/);
    expect(describeAction('sco_delete_kpi', { name: 'LateShip' })).toMatch(/Delete Business KPI "LateShip"/);
  });
});

// makeCanUseTool enforces CONTAINMENT (only our own catalog runs at all) and
// MODE (which of those tools are available this turn). It no longer performs the
// state-changing APPROVAL — that moved into the tool handlers (see
// `handler-side approval gate` below and src/tools/gate.ts). So what is asserted
// here is: it lets our own tools through per mode, and it does NOT let anything
// else through. `makeCanUseTool(mode)` takes no broker, which is what makes the
// "not a second gate" property structural rather than a convention: with nothing
// to prompt WITH, it cannot regress into a second, weaker approval gate.
describe('makeCanUseTool — containment + agent mode', () => {
  it('allows read-only tools', async () => {
    const canUse = makeCanUseTool('agent');
    const res = await canUse('mcp__sco__sco_cube_info', { cubeName: 'C' });
    expect(res.behavior).toBe('allow');
  });

  it('lets state-changing tools through WITHOUT prompting here — the handler prompts', async () => {
    const canUse = makeCanUseTool('agent');
    // Previously this callback raised the confirmation itself. It must not any more:
    // two prompts for one action would be a UX bug, and the callback is the layer that
    // can be shadowed. Approval is asserted in the handler-gate describe below.
    const res = await canUse('mcp__sco__sco_build_cube', { cubeName: 'C' });
    expect(res.behavior).toBe('allow');
  });

  it('DENIES anything outside our catalog — the old callback allowed it', async () => {
    const canUse = makeCanUseTool('agent');
    // This is the hole that let a real shell command run: `isStateChanging('Bash')` is
    // false, so the previous callback returned `allow`. Unknown names now fail closed.
    for (const foreign of ['Bash', 'Write', 'Edit', 'WebFetch', 'Workflow', 'mcp__other__do_thing']) {
      const res = await canUse(foreign, {});
      expect(res.behavior).toBe('deny');
    }
  });

  it('allows the built-ins that are deliberately offered', async () => {
    const canUse = makeCanUseTool('agent');
    // `Skill` is required by the system prompt. `AskUserQuestion` is offered so the
    // alias can fire — though measured, the callback sees the alias TARGET, not this
    // name, so the target must pass too (it does: it is in our catalog).
    expect((await canUse('Skill', {})).behavior).toBe('allow');
    expect((await canUse('AskUserQuestion', {})).behavior).toBe('allow');
    expect((await canUse(qualifiedToolName('ask_user_question'), {})).behavior).toBe('allow');
  });

  it('denies the guided-only ui_* tools in agent mode (no prompt)', async () => {
    const canUse = makeCanUseTool('agent');
    const res = await canUse('mcp__sco__ui_set_field', { path: 'name', value: 'X' });
    expect(res.behavior).toBe('deny');
  });

  it('ALLOWS ui_report_status in agent mode without a confirm prompt (local UI only)', async () => {
    // The callback has no broker, so it cannot prompt at all; ui_report_status is
    // neither state-changing nor a guided-only ui_* directive, so it just passes.
    const canUse = makeCanUseTool('agent');
    const res = await canUse('mcp__sco__ui_report_status', { target: 'job-1', phase: 'created', ok: true });
    expect(res.behavior).toBe('allow');
  });
});

describe('makeCanUseTool — guided mode', () => {
  /**
   * Guided mode may READ but never WRITE. The read-only lookups are what let it answer
   * about an entity that is not on the user's current page (another object, a cube, a
   * KPI) instead of answering from memory or navigating the user away to read it.
   */
  it('ALLOWS the read-only lookup tools', async () => {
    const canUse = makeCanUseTool('guided');
    for (const t of [
      'sco_resolve_class',
      'sco_list_properties',
      'sco_list_methods',
      'sco_match_property',
      'sco_suggest_dimension_sources',
      'sco_cube_info',
      'sco_list_kpis',
      'sco_get_kpi',
      'sco_production_status',
      'sco_list_config_items',
    ]) {
      const res = await canUse(`mcp__sco__${t}`, {});
      expect(res.behavior, t).toBe('allow');
    }
  });

  it('DENIES every tool that would change the instance, without prompting', async () => {
    const canUse = makeCanUseTool('guided');
    for (const t of [
      'sco_build_cube',
      'sco_compile_class',
      'sco_import_class',
      'sco_create_kpi',
      'sco_update_kpi',
      'sco_delete_kpi',
      'sco_add_config_item',
      'sco_remove_config_item',
      'sco_enable_config_item',
      'sco_update_production',
      // Read-only w.r.t. IRIS, but they're the Agent-mode workhorses: producing class
      // source is not Guided mode's job, so they stay denied too.
      'sco_generate_cube_cls',
      'sco_generate_integration_classes',
    ]) {
      const res = await canUse(`mcp__sco__${t}`, {});
      expect(res.behavior, t).toBe('deny');
      if (res.behavior === 'deny') expect(res.message).toMatch(/Guided mode/i);
    }
  });

  it('never lets a state-changing tool through even if it were listed as a lookup', async () => {
    // Belt and braces: the allow branch is conjoined with !isStateChanging, so adding a
    // mutating tool to CONTEXT_LOOKUP_TOOLS by mistake still cannot open a write path.
    const canUse = makeCanUseTool('guided');
    for (const t of [...STATE_CHANGING_TOOLS]) {
      const res = await canUse(`mcp__sco__${t}`, {});
      expect(res.behavior, t).toBe('deny');
    }
  });

  it('allows ui_* directive tools and ask_user_question', async () => {
    const canUse = makeCanUseTool('guided');
    for (const t of ['ui_navigate', 'ui_open_form', 'ui_set_field', 'ui_highlight', 'ask_user_question']) {
      const res = await canUse(`mcp__sco__${t}`, {});
      expect(res.behavior, t).toBe('allow');
    }
  });
});

describe('handler-side approval gate', () => {
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

  it('auto-approves: runs the real handler without any confirmation prompt', async () => {
    const emit = vi.fn();
    const broker = new ConfirmationBroker(emit);
    const { def, calls } = fakeTool('sco_compile_class');
    const gated = gateHandler(def, broker);

    const res = await gated.handler({ className: 'A.B', source: '...' } as never, undefined);
    // No prompt was raised, and the side effect ran.
    expect(emit).not.toHaveBeenCalled();
    expect(broker.outstanding).toBe(0);
    expect(calls).toHaveLength(1);
    expect(payload(res).ok).toBe(true);
  });

  it('records the action to the audit trail (as approved) BEFORE running it', async () => {
    const broker = new ConfirmationBroker(() => {});
    const { def, calls } = fakeTool('sco_build_cube');
    const recorded: AuditEntry[] = [];
    const audit: AuditSink = {
      record(entry) {
        // Prove ordering: nothing has run yet when we record.
        expect(calls).toHaveLength(0);
        recorded.push(entry);
      },
    };
    const gated = gateHandler(def, broker, audit);

    await gated.handler({ cubeName: 'C' } as never, undefined);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ toolName: 'sco_build_cube', decision: 'approve' });
    expect(recorded[0]!.summary).toMatch(/Build.*cube C/);
    expect(calls).toHaveLength(1);
  });

  it('fails CLOSED when the audit record cannot be written — the IRIS call never runs', async () => {
    const broker = new ConfirmationBroker(() => {});
    const { def, calls } = fakeTool('sco_update_production');
    const audit: AuditSink = {
      record() {
        throw new Error('disk full');
      },
    };
    const gated = gateHandler(def, broker, audit);

    const res = await gated.handler({} as never, undefined);
    expect(calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/audit trail/i);
  });

  // These assert the WIRING, by reaching into the assembled server and invoking
  // the handler it actually registered. Asserting `isStateChanging` over a name list
  // instead would pass even with the wrapper removed from `createScoMcpServer` —
  // verified by mutation, which is why it is done this way.
  /** The handler the assembled MCP server really registered for `bare`. */
  function registeredHandler(server: ReturnType<typeof createScoMcpServer>, bare: string) {
    const registry = (
      server.instance as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<CallToolResult> }>;
      }
    )._registeredTools;
    const entry = registry[bare];
    expect(entry, `tool ${bare} is not registered`).toBeDefined();
    return entry!.handler;
  }

  it('every state-changing tool, as assembled, is audited (fail-closed) before it runs', async () => {
    const broker = new ConfirmationBroker(() => {});
    const audited: string[] = [];
    // An audit sink that throws → the gate must deny, proving the record runs on
    // the real registered handler BEFORE the (fake, would-throw) IRIS call.
    const audit: AuditSink = {
      record(entry) {
        audited.push(entry.toolName.replace(/^mcp__sco__/, ''));
        throw new Error('audit unavailable');
      },
    };
    const server = createScoMcpServer(fakeIris(), new QuestionBroker(() => {}), noUi, broker, audit);

    for (const bare of [...STATE_CHANGING_TOOLS]) {
      const handler = registeredHandler(server, bare);
      const res = await handler({}, undefined);
      expect(res.isError, `${bare} ran without being audited`).toBe(true);
      expect(payload(res).error).toMatch(/audit trail/i);
    }
    // Every mutating tool hit the audit sink — none silently skipped.
    expect(audited.sort()).toEqual([...STATE_CHANGING_TOOLS].sort());
    // And no confirmation prompt was ever raised.
    expect(broker.outstanding).toBe(0);
  });

  it('does NOT prompt for read-only tools', async () => {
    const emit = vi.fn();
    const broker = new ConfirmationBroker(emit);
    // Auto-acking UI broker: the ui_* directive tools BLOCK until the frontend
    // acks, so a no-op broker would hang them. Acking immediately lets their
    // handlers resolve — the point of THIS test is only that none of them routed
    // to the CONFIRMATION broker.
    const ui = new UiControlBroker((req) => queueMicrotask(() => ui.ack(req.directiveId, { applied: true })));
    const server = createScoMcpServer(fakeIris(), new QuestionBroker(() => {}), ui, broker);
    const readOnly = ALL_TOOL_NAMES.filter((n) => !isStateChanging(n) && n !== 'ask_user_question');

    for (const bare of readOnly) {
      // The fake IrisServices has no methods, so an unwrapped read-only IRIS tool fails
      // in its own body — `guard` turns that into an error result; the ui_* tools resolve
      // via the auto-ack above. Either way none of them must have raised a confirmation,
      // which is what this asserts.
      await registeredHandler(server, bare)({}, undefined).catch(() => undefined);
    }
    expect(emit).not.toHaveBeenCalled();
    expect(broker.outstanding).toBe(0);
  });
});

describe('buildOptions gate wiring', () => {
  const env = { SCO_NAMESPACE: 'SC', ANTHROPIC_MODEL: 'm', SCO_WEB_PORT: 52773, SCO_SUPERSERVER_PORT: 1972 } as unknown as Env;
  const iris = { atelier: {}, native: {}, namespace: 'SC', close: () => {} } as unknown as IrisServices;

  it('leaves allowedTools empty so every call falls through to canUseTool (no shadowing/warning)', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const opts = buildOptions({ env, iris, broker, questions, ui: noUi });
    // Any bare name in allowedTools would auto-approve before canUseTool AND
    // emit CLAUDE_SDK_CAN_USE_TOOL_SHADOWED. It must be empty.
    expect(opts.allowedTools ?? []).toEqual([]);
    // The containment + mode callback is present.
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('selects a different system prompt per mode', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const agent = buildOptions({ env, iris, broker, questions, ui: noUi, mode: 'agent' });
    const guided = buildOptions({ env, iris, broker, questions, ui: noUi, mode: 'guided' });
    expect(String(agent.systemPrompt)).toMatch(/Agent mode/);
    expect(String(guided.systemPrompt)).toMatch(/Guided mode/);
    expect(agent.systemPrompt).not.toBe(guided.systemPrompt);
  });

  it('bounds the BUILT-IN tool surface with `tools`, because allowedTools does not', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const opts = buildOptions({ env, iris, broker, questions, ui: noUi });
    // Measured against the real CLI via `system/init`: without this key, 40 tools are OFFERED
    // (our 13 + 27 built-ins: Bash, Write, Edit, WebFetch, Workflow, CronCreate, …) and the
    // gate does not cover any of them — `isStateChanging('Bash')` is false, so canUseTool
    // returns `allow`. A shell command really executed with an empty gate log. With this key
    // the same probe offers 15 = our 13 + the two named here. `tools` is the actual bound.
    expect(opts.tools).toEqual(['Skill', 'AskUserQuestion']);
    // Named individually so a future non-empty allowlist fails here rather than quietly
    // re-offering them: Bash/Write/Edit reach the filesystem the agent is not supposed to
    // touch, and Workflow spawns subagents carrying their own tool surface.
    for (const leaked of ['Bash', 'Write', 'Edit', 'WebFetch', 'Workflow', 'CronCreate']) {
      expect(opts.tools).not.toContain(leaked);
    }
  });

  it('keeps `Skill` offered, since the system prompt requires skills-come-first', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const opts = buildOptions({ env, iris, broker, questions, ui: noUi });
    // Bounding built-ins must not break the documented contract that the model's very first
    // action for a matching request is the Skill tool. Dropping `Skill` would make every
    // skill unreachable while leaving the prompt insisting on them.
    expect(opts.tools).toContain('Skill');
    // Skills are discovered from PROJECT settings, and that is independent of `tools` —
    // measured both ways, a project skill is still found with `tools` set. So the bound
    // costs no skills, and this pairing must stay intact.
    expect(opts.settingSources).toEqual(['project']);
    expect(opts.skills).toBe('all');
  });

  it('bounds FOREIGN MCP servers too — `tools` covers built-ins only', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const opts = buildOptions({ env, iris, broker, questions, ui: noUi });
    // A server declared in the cwd's `.mcp.json` is a separate surface from the built-ins:
    // the CLI connects it and offers its tools beside ours. The backend may well run from a
    // developer's own working directory, so this is part of the bound rather than hygiene.
    expect(opts.strictMcpConfig).toBe(true);
  });

  it('declares a termination bound, taken from the environment', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const opts = buildOptions({ env: { ...env, AGENT_MAX_TURNS: 7 } as Env, iris, broker, questions, ui: noUi });
    // Without this the SDK runs a non-converging turn until someone kills it. The
    // value is configurable rather than hard-coded so a long flow can raise it
    // without a code change.
    expect(opts.maxTurns).toBe(7);
  });

  it('aliases the SDK built-in AskUserQuestion to our QuestionBroker-backed MCP tool', () => {
    const broker = new ConfirmationBroker(() => {});
    const questions = new QuestionBroker(() => {});
    const opts = buildOptions({ env, iris, broker, questions, ui: noUi });
    // The built-in has no interactive handler in our headless/SSE setup. We alias
    // it (rather than disallow it) so the built-in call runs our tool and shows
    // the modal — both tool names reach the popup. Disallowing would remove the
    // name and prevent the alias from firing, so it must NOT be disallowed.
    expect(opts.toolAliases?.AskUserQuestion).toBe('mcp__sco__ask_user_question');
    expect(opts.disallowedTools ?? []).not.toContain('AskUserQuestion');
    // ...and `tools` can silence the alias the same way disallowing would. Measured: with
    // `tools: ['Skill']` alone the built-in is absent from the offered list entirely, so the
    // model never emits the name and the alias never fires. Keeping it in `tools` is what
    // makes the alias reachable under containment — verified end to end (model calls
    // `AskUserQuestion`, our MCP handler runs).
    expect(opts.tools).toContain('AskUserQuestion');
  });
});
