/**
 * C18 / SC-2715 — Option 2 (LIVE agent eval): the ONLY layer that tests agent
 * judgment. Feeds each scenario's userPrompt to a REAL `query()` turn (via
 * `runAgentTurn` with the default queryImpl), captures the actual tool-call
 * transcript, and scores it against the golden (spec §4). It needs a live SCO +
 * Bedrock credentials and runs only under the public-UBI9 recipe.
 *
 * It lives in its OWN vitest project (`agent-eval`, run by `npm run test:agent-eval`)
 * rather than in the integration tier, so opting out means not selecting the project
 * — no `.skip`. CI's test-file guard fails any tier that reports a skipped test, and
 * an env-gated skip inside the integration tier tripped it.
 *
 * Driven the way production drives a turn (app.ts:405): each scenario runs in ITS
 * OWN mode (guided vs agent), and guided scenarios carry the same ephemeral
 * `[SESSION MODE]` / `[UI CONTEXT]` header (`withTurnHeader`) the SPA sends — an
 * open KPI form with the cube selected. Without that header a guided "filter THIS
 * KPI" has no referent and the agent (correctly) asks "which KPI?", so the header
 * is what lets the guided seam actually exercise. The headless brokers auto-ack
 * (ui_*) and auto-answer (questions) so a legitimate clarifying question resolves
 * with the default instead of deadlocking (see iris-app.ts agentDeps).
 *
 * Scoring: the auto-assert confirms the agent reached the expected RUNTIME SEAM —
 * a `ui_set_field` on the golden field path for a guided "applied" scenario, an
 * `sco_create_kpi` for the agent scenario. It deliberately does NOT byte-match the
 * golden MDX: the fixture goldens use live-cube shapes verified against the running
 * instance (`[status]`, `[productCategory]`, `[siteLocationHierarchy]`), but the
 * agent legitimately picks equivalent member/level spellings, so a substring match
 * would FAIL on correct behavior. The MDX's correctness is HUMAN-scored in the
 * scorecard (spec §9: human judgment is the authority). Each scenario logs its
 * transcript for that scoring.
 *
 * The headless UI broker is FAITHFUL, not a yes-man: `agentDeps({uiSetFieldGate})`
 * mirrors the Angular bridge's dropdown validation (kpi.ts:600) using the LIVE cube
 * shape, so a `dimensions.N.cubeDimension` value the cube does not expose acks
 * applied:false — exactly as the real form does. The "rejected" scenario (G4) is
 * inherently non-deterministic in whether the agent ATTEMPTS the bad member, so it
 * is scored on liveness + a fidelity guard (the gate never accepts the non-exposed
 * member); the DETERMINISTIC reject proof lives in Option 1 (frontend spec, real
 * bridge → applied:false).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import scenarios from '../../../test/fixtures/agent-mdx-scenarios.json' with { type: 'json' };
import { runAgentTurn, type AgentDeps } from '../../src/agent/agent.js';
import { withTurnHeader } from '../../src/server/app.js';
import { DeepSeeShapeAdapter } from '../../src/dashboard/cube-shape.js';
import { bootApp, type BootedApp } from '../integration/helpers/iris-app.js';
import { seedSource, buildTestCube, runCleanups, type Cleanup } from '../integration/helpers/provision.js';
import { sweep, healCubeRegistry } from '../integration/helpers/sweep.js';

interface Scenario {
  id: string;
  mode: 'guided' | 'agent';
  userPrompt: string;
  cube: string;
  expected: { toolPath: string; conditionMdx?: string; resolvesTo?: string; landing: 'applied' | 'rejected' };
}
interface ToolCall {
  name: string;
  input: unknown;
}

// A live turn is agentic (skills-first, then several MCP round-trips), so it runs
// far longer than vitest's 30s default. Give each scenario a generous ceiling and
// abort a few seconds under it, so a genuine hang FAILS with a captured error
// rather than a bare "test timed out".
const SCENARIO_TIMEOUT_MS = 185_000;
const SCENARIO_ABORT_MS = 175_000;

// Mirror sse.ts:140-151 — pull tool_use blocks out of the assistant message stream.
function collectToolCalls(message: SDKMessage, into: ToolCall[]): void {
  if (message.type !== 'assistant') return;
  const blocks = ((message as { message?: { content?: unknown[] } }).message?.content ?? []) as Array<{
    type?: string;
    name?: string;
    input?: unknown;
  }>;
  for (const b of blocks) if (b.type === 'tool_use') into.push({ name: b.name ?? '', input: b.input });
}

/**
 * The ephemeral guided header the SPA sends each turn (app.ts:66 `withTurnHeader`
 * + workbench-bridge `getContextSnapshot`): an open, new KPI form with the cube
 * chosen. Field paths mirror the frontend's KPI_SET_FIELD_PATHS so the agent fills
 * only real paths.
 */
function guidedUiContext(cube: string): string {
  return [
    'page: kpi',
    'activeForm: kpi',
    'mode: creating new KPI',
    'validFieldPaths: name,label,description,type,status,baseObject,cube,kpiMeasure,valueType,' +
      'watchingThreshold,warningThreshold,issueKpi,defaultIssueSeverity,analysisService,' +
      'kpiConditions.N,baseConditions.N,dimensions.N.name,dimensions.N.label,dimensions.N.cubeDimension',
    `cube: ${cube}`,
    'valueType: raw',
    'kpiMeasure: %COUNT',
    'kpiConditions: []',
  ].join('\n');
}

const setFieldOn = (calls: ToolCall[], path: string): boolean =>
  calls.some((c) => c.name.endsWith('ui_set_field') && (c.input as { path?: string })?.path === path);

describe('C18 Option 2 (LIVE): the real agent produces MDX matching the golden transcript', () => {
  let app: BootedApp;
  const cleanups: Cleanup[] = [];
  // KPI names present before the run. The A1 agent scenario CREATES a KPI in the
  // shared instance; afterAll deletes any KPI not in this set so the suite is
  // self-cleaning AND idempotent — a stale KPI from a prior run would make the
  // agent (correctly) refuse a duplicate name and skip sco_create_kpi, failing A1
  // for a reason that is instance state, not agent behavior.
  let preexistingKpis = new Set<string>();
  // A faithful headless mirror of the Angular bridge's dimension-dropdown gate
  // (kpi.ts:600), built from the LIVE cube shape — not a hardcoded allow-list. It
  // rejects a `dimensions.N.cubeDimension` value the cube does not expose (so the
  // headless UI broker returns applied:false, exactly as the real form does),
  // while free-text fields (kpiConditions.N, name, ...) land as typed. Without it
  // the broker would ack applied:true for G4's non-exposed member, feeding the
  // agent a false success the real UI would never give.
  let uiSetFieldGate: (path: string, value: unknown) => { applied: boolean; detail?: string } | null;
  const CUBE = 'ProductInventoryCube';

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
    // A readable cube for the turn; the scenario prompts target ProductInventoryCube
    // (a standard SCO demo cube present on the clean baseline the harness seeds).
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src);
    cleanups.push(cube.cleanup);
    preexistingKpis = new Set((await app.iris.kpi.list()).map((k) => k.name));

    // Read the real cube shape ONCE and derive the dropdown gate. `exposedTokens`
    // is the set of leading dimension tokens the cube publishes (e.g. `[status]`,
    // `[siteLocationHierarchy]`, `[productCategory]`). A cubeDimension value is
    // accepted only if its own leading `[dim]` token is one of them — the same
    // "is this a dimension of the cube?" test the bridge's resolveOption applies.
    const shape = await new DeepSeeShapeAdapter(app.iris.deepsee, app.iris.atelier).shape(CUBE);
    const leadingToken = (mdx: string): string => (mdx.match(/^\[[^\]]+\]/)?.[0] ?? '');
    const exposedTokens = new Set(
      shape.dimensions.flatMap((d) => d.levels.map((l) => leadingToken(l.spec))).filter(Boolean),
    );
    uiSetFieldGate = (path, value) => {
      if (!/^dimensions\.\d+\.cubeDimension$/.test(path)) return null; // free-text field: accept
      const token = leadingToken(String(value));
      if (token && exposedTokens.has(token)) return { applied: true };
      return {
        applied: false,
        detail: `"${String(value)}" is not a dimension of the selected cube. Available: ${[...exposedTokens].join(', ')}.`,
      };
    };
  });
  afterAll(async () => {
    // Delete KPIs the run created (the A1 write path), restoring the clean baseline.
    for (const k of await app.iris.kpi.list()) {
      if (!preexistingKpis.has(k.name)) {
        try {
          await app.iris.kpi.delete(k.name);
        } catch {
          /* best-effort teardown; sweep + next run's delta both backstop it */
        }
      }
    }
    await runCleanups(cleanups);
    await sweep(app.iris);
    await app.close();
  });

  for (const s of scenarios as Scenario[]) {
    it(
      `${s.id} (${s.mode}): real query() transcript reaches the expected seam`,
      async () => {
        // Fresh deps per scenario so the guided ui-ack / question-answer state does
        // not bleed across turns; mode matches the scenario. The faithful field
        // gate is recorded so we can assert on what the seam actually accepted,
        // not on the LLM's (run-to-run variable) decision to attempt it.
        const gateLog: Array<{ path: string; value: unknown; applied: boolean }> = [];
        const deps: AgentDeps = app.agentDeps({
          mode: s.mode,
          uiSetFieldGate: (path, value) => {
            const verdict = uiSetFieldGate(path, value);
            if (verdict) gateLog.push({ path, value, applied: verdict.applied });
            return verdict;
          },
        });
        const prompt =
          s.mode === 'guided'
            ? withTurnHeader(s.userPrompt, 'guided', guidedUiContext(s.cube))
            : withTurnHeader(s.userPrompt, 'agent', '');

        const toolCalls: ToolCall[] = [];
        let finalText = '';
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), SCENARIO_ABORT_MS);
        try {
          for await (const msg of runAgentTurn(deps, prompt, undefined, abort)) {
            collectToolCalls(msg, toolCalls);
            if (msg.type === 'result' && 'result' in msg && typeof (msg as { result?: unknown }).result === 'string') {
              finalText = (msg as { result: string }).result;
            }
          }
        } catch (err) {
          // A live-query throw scores the scenario FAIL with the captured error; the file does not crash
          // and the remaining scenarios still run (spec §9).
          expect.fail(`${s.id} live query threw: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearTimeout(timer);
        }

        // Log the transcript for the human scorecard (spec §9 — MDX correctness is
        // scored by hand, since the live cube's real dimensions differ from the
        // synthetic fixture goldens).
        const summary = toolCalls.map((c) => `${c.name} ${JSON.stringify(c.input)}`.slice(0, 240));
        // eslint-disable-next-line no-console
        console.log(`[C18 ${s.id}/${s.mode}] tools:\n  ${summary.join('\n  ')}\n  final: ${finalText.slice(0, 300)}`);

        // Seam assertions — the fireable part. What broke (or held) is the seam the
        // golden names, not the byte-exact MDX (see the file header).
        if (s.mode === 'agent' && s.expected.landing === 'applied') {
          const created = toolCalls.some((c) => c.name.endsWith('sco_create_kpi'));
          expect(created, `${s.id}: no sco_create_kpi call in transcript`).toBe(true);
        } else if (s.mode === 'guided' && s.expected.landing === 'applied') {
          expect(setFieldOn(toolCalls, s.expected.toolPath), `${s.id}: no ui_set_field on ${s.expected.toolPath}`).toBe(
            true,
          );
        } else if (s.mode === 'guided' && s.expected.landing === 'rejected') {
          // Liveness: the turn ran end-to-end against the real cube and produced a
          // response. A reject scenario is non-deterministic in whether the agent
          // *attempts* the bad member (run 1 it refused outright; run 2 it tried,
          // then explained the cube can't break down that way — both correct), so
          // there is no sound binary auto-assert on the attempt itself. The
          // DETERMINISTIC reject proof lives in Option 1 (frontend
          // agent-mdx-transcript.spec.ts G4, real bridge → applied:false); the live
          // handling is human-scored from the transcript (spec §9).
          expect(finalText.length > 0 || toolCalls.length > 0, `${s.id}: live turn produced no output`).toBe(true);
          // Fidelity guard (fires under the run-2 regression): the faithful field
          // gate — the same rule the real Angular bridge applies — must NEVER let a
          // non-exposed cubeDimension member through as applied:true. A yes-man
          // broker (the earlier bug) that acked applied:true would trip this the
          // moment the agent attempted the member.
          const acceptedBad = gateLog.some((g) => g.applied && g.value === '[warehouse].[H1].[bin]');
          expect(acceptedBad, `${s.id}: the field gate accepted the unenumerated member as applied`).toBe(false);
        }
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
