import { query, type Options, type SDKMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Env } from '../config/env.js';
import { providerEnv } from '../config/env.js';
import type { IrisServices } from '../iris/index.js';
import { createScoMcpServer, SCO_MCP_SERVER, isStateChanging, isUiTool, isOurTool, isContextLookupTool, ALLOWED_BUILTIN_TOOLS, qualifiedToolName } from '../tools/index.js';
export { isStateChanging };
import { ConfirmationBroker } from '../server/confirm.js';
import type { QuestionBroker } from '../server/question.js';
import type { UiControlBroker } from '../server/ui-control.js';
import type { AuditSink } from '../db/audit.js';
import { buildSystemPrompt, type AssistantMode } from './system-prompt.js';

// The backend package root — holds `.claude/skills/`. Skills are discovered from
// cwd upward, so we point the query cwd here.
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AgentDeps {
  env: Env;
  iris: IrisServices;
  broker: ConfirmationBroker;
  questions: QuestionBroker;
  ui: UiControlBroker;
  /** Operating mode for this turn. Defaults to 'agent'. */
  mode?: AssistantMode;
  /**
   * Session-scoped audit sink. Optional so a caller without a database still
   * gets the approval gate; the server always supplies one.
   */
  audit?: AuditSink;
}

/**
 * Build the `canUseTool` callback. It does two things — and, importantly, NOT a
 * third: it enforces CONTAINMENT (only our own catalog may run at all) and MODE
 * (which of those tools are AVAILABLE this turn). It no longer performs the
 * state-changing APPROVAL — that moved inside the tool handlers
 * (`tools/gate.ts`), because the callback is a position the SDK can be made to
 * skip while the handler still runs.
 *
 * Why the callback still has to exist at all: measured, with no `canUseTool` and
 * no `permissionMode`, the SDK refuses MCP tools outright ("Claude requested
 * permissions to use `mcp__sco__sco_compile_class`, but you haven't granted it
 * yet") and the handler never runs — so the in-handler gate would never be
 * reached. `permissionMode: 'dontAsk'` also denies and invites the model to find
 * another route; `permissionMode: 'bypassPermissions'` additionally needs
 * `allowDangerouslySkipPermissions: true` — two alarming flags to buy what this
 * callback buys. So the callback stays as the narrowest enabler that lets our
 * own gate run.
 *
 * Containment first: anything not in our catalog (a built-in that slipped past
 * the `tools` bound, a foreign MCP server) is DENIED here. Returning `allow` for
 * an unrecognized name would be the fail-OPEN hole this change is about — a
 * built-in like Bash used to sail through. Note it takes no ConfirmationBroker:
 * with nothing to prompt WITH, it cannot regress into a second, weaker approval
 * gate by a later edit.
 *
 * Mode then decides availability (tool DEFINITIONS are identical across modes so
 * the prompt-cache prefix survives; availability is decided here):
 *  - **Agent mode**: the `ui_*` directive tools are denied (Agent acts on IRIS
 *    directly, never driving the UI); IRIS tools run — state-changing ones prompt
 *    inside their handlers.
 *  - **Guided mode**: the read-only LOOKUP tools (`CONTEXT_LOOKUP_TOOLS`) are
 *    allowed — Guided has to be able to answer about an entity that is not on the
 *    user's current page without inventing it or navigating them away just to read
 *    it. Every other `sco_*` tool is denied with a redirect message (Guided teaches
 *    via the UI and never CHANGES IRIS); `ui_*` tools and `ask_user_question` run
 *    freely (they change only the local UI).
 */
export function makeCanUseTool(mode: AssistantMode) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    // Containment. `tools` + `strictMcpConfig` should already have made a
    // non-catalog tool unreachable; if one is reached the bound was widened
    // somewhere and the safe answer is no — a built-in like Bash used to sail
    // through here.
    if (!isOurTool(toolName)) {
      return { behavior: 'deny', message: `Tool ${toolName} is not available to this agent.` };
    }
    if (mode === 'guided') {
      // Guided mode may LOOK things up but never ACT. The read-only lookup tools are
      // what let it answer about an entity that is not on the user's current page (a
      // different object, a cube, a KPI) without either inventing an answer or
      // navigating the user away from what they were doing just to read something.
      if (isContextLookupTool(toolName) && !isStateChanging(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }
      // Everything else that would touch IRIS stays denied.
      if (isStateChanging(toolName) || isIrisTool(toolName)) {
        return {
          behavior: 'deny',
          message:
            'Guided mode does not CHANGE SCO. You may look things up with the read-only tools (sco_resolve_class, sco_list_properties, sco_list_methods, sco_match_property, sco_suggest_dimension_sources, sco_cube_info, sco_list_kpis, sco_get_kpi, sco_production_status, sco_list_config_items), but generating/compiling/building/creating/updating/deleting is not yours to do here. Guide the user through the workbench UI instead: use the ui_navigate / ui_open_form / ui_set_field / ui_highlight tools and explain each step. The user performs the final Save/Build themselves.',
        };
      }
      return { behavior: 'allow', updatedInput: input };
    }
    // Agent mode: the UI-directive tools are not for this mode.
    if (isUiTool(toolName)) {
      return {
        behavior: 'deny',
        message: 'The ui_* tools are for Guided mode only. In Agent mode, act on SCO directly with the sco_* tools.',
      };
    }
    // Our own tool, allowed in this mode. Read-only tools run freely; a
    // state-changing tool is allowed HERE and prompts inside its handler.
    return { behavior: 'allow', updatedInput: input };
  };
}

/** Is this an IRIS-touching tool (any `sco_*`, bare or qualified)? */
function isIrisTool(toolName: string): boolean {
  const bare = toolName.replace(new RegExp(`^mcp__${SCO_MCP_SERVER}__`), '');
  return bare.startsWith('sco_');
}

/**
 * Assemble the query() options for a turn. `resume` continues a prior SDK
 * session; `abortController` lets the caller stop the turn (e.g. the user
 * dismisses a question popup without answering).
 */
export function buildOptions(deps: AgentDeps, resume?: string, abortController?: AbortController): Options {
  const { env, iris, broker, questions, ui, mode = 'agent', audit } = deps;
  // Keep allowedTools EMPTY. A bare entry here auto-approves that tool before
  // canUseTool runs (the SDK warns: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). That no
  // longer bypasses the APPROVAL — the gate moved into the handlers, and the
  // measured proof is that with a bare name present the handler still ran and
  // still denied. It stays empty anyway: shadowing the callback would re-open
  // the containment + mode surface check below.
  const options: Options = {
    cwd: BACKEND_ROOT,
    settingSources: ['project'],
    skills: 'all',
    systemPrompt: buildSystemPrompt(env, mode),
    // The broker and the audit sink go to the SERVER, not to canUseTool: the
    // approval prompt and the audit write both happen inside each state-changing
    // tool's handler, in that order (see tools/gate.ts). The UiControlBroker
    // backs the guided-mode ui_* directive tools.
    mcpServers: { [SCO_MCP_SERVER]: createScoMcpServer(iris, questions, ui, broker, audit) },
    allowedTools: [],
    // THE TOOL-SURFACE BOUND. `allowedTools` above is NOT one — its own doc comment says
    // "to restrict which tools are available, use the `tools` option instead": it only
    // pre-approves, it never narrows what is OFFERED. Measured against the real CLI with
    // this exact option set and all 13 of our tools, reading `system/init`'s own list:
    //
    //   settingSources:['project'] + allowedTools:[] ...... 40 offered = 13 ours + 27 built-in
    //   + tools: ['Skill','AskUserQuestion'] .............. 15 offered = 13 ours + those 2
    //
    // The 27 included Bash, Write, Edit, WebFetch, Workflow and CronCreate. That is not
    // theoretical: asked to run a shell command, the agent executed it and printed the
    // output, and `canUseTool` was NEVER CONSULTED — because `isStateChanging('Bash')` is
    // false, so the gate returns `allow` for every built-in. An agent specified to reach
    // IRIS only through the `sco_*` tools could shell out.
    //
    // `Skill` must stay: the system prompt REQUIRES the model to invoke a skill before any
    // work, so dropping it would break skills-come-first. `AskUserQuestion` must stay for
    // the alias below to have anything to alias — with `tools: ['Skill']` alone the built-in
    // leaves the model's context entirely, which is exactly the condition the alias comment
    // warns about. Verified with both present: the model calls `AskUserQuestion` and our
    // MCP handler runs.
    //
    // Note `settingSources` is INDEPENDENT of this: skills are still discovered from project
    // settings with `tools` set, so containment costs no skills (measured both ways).
    //
    // Same list the canUseTool surface check uses, so the bound and the check cannot drift.
    tools: [...ALLOWED_BUILTIN_TOOLS],
    // Part of the bound, not hygiene. `tools` covers BUILT-INS only; a foreign MCP server is
    // a separate surface. Without this, the CLI connects servers declared in the cwd's
    // `.mcp.json` and offers their tools beside ours — containment failing in the likeliest
    // deployment there is, a developer running the backend from their own working directory.
    strictMcpConfig: true,
    // The SDK ships a BUILT-IN `AskUserQuestion` tool. In our headless/SSE setup
    // it has no interactive handler, so calling it directly dead-ends with "The
    // user did not answer the questions" — nothing reaches our tabbed-popup UI.
    // Only our own `ask_user_question` MCP tool is wired to the QuestionBroker →
    // `ask_request` SSE event → modal.
    //
    // Rather than forbid the built-in, we ALIAS it to our tool: when the model
    // emits `AskUserQuestion`, the SDK "resolves the mapped name instead" at the
    // execution path, so the built-in's call runs our handler and shows the same
    // modal. This way BOTH names reach the popup — we don't care which the model
    // picks. (We deliberately do NOT `disallowedTools` it: disallowing removes
    // the name from context, which would prevent the alias from ever firing.)
    toolAliases: { AskUserQuestion: qualifiedToolName('ask_user_question') },
    canUseTool: makeCanUseTool(mode),
    // Termination bound (see AGENT_MAX_TURNS in config/env.ts). A turn that hits it
    // ends with result subtype `error_max_turns`, which sse.ts already surfaces as an
    // error — so the bound is observable rather than a silent truncation.
    maxTurns: env.AGENT_MAX_TURNS,
    includePartialMessages: true,
    env: { ...process.env, ...providerEnv(env) },
    model: env.ANTHROPIC_MODEL,
  };
  // Resume the prior SDK session so follow-up turns keep full context
  // (skills already loaded, prior tool results, the pending confirmation, etc.)
  // instead of restarting from scratch.
  if (resume) options.resume = resume;
  // When aborted (e.g. the user dismisses a question popup), the query stops
  // and cleans up instead of hanging on the unanswered tool call.
  if (abortController) options.abortController = abortController;
  return options;
}

/**
 * HTTP statuses on a retry notice that mean "the credentials were refused".
 * Every one of the five providers answers a bad/expired/wrong-format credential
 * with 403 and an unsigned or unauthenticated request with 401.
 */
const CREDENTIAL_REJECTION_STATUSES = new Set([401, 403]);

/**
 * The SDK's own error names for the same thing, used when the retry notice
 * carries no status (`error_status` is null for connection-level failures).
 */
const CREDENTIAL_REJECTION_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed']);

/**
 * Is this SDK message a retry notice for a failure that RETRYING CANNOT FIX?
 *
 * The CLI classifies an auth rejection as retryable: it emits
 * `system/api_retry` and sleeps with exponential backoff, once per attempt, up
 * to `max_retries`, before finally failing the turn. With a rejected key every
 * one of those attempts is refused identically, so the user waits out the whole
 * retry budget staring at "Thinking…" and only then learns the key was refused — the
 * answer was knowable on attempt 1.
 *
 * Returns the error to fail the turn with (its text is what
 * `describeAiFailure()` classifies into the user-facing AI_KEY_INVALID_MESSAGE), or null
 * for a retry we should let proceed. A throttle (429), an overload or a 5xx IS
 * transient, and those keep the SDK's retries — cutting them short would turn a
 * momentary blip into a failed turn.
 */
export function credentialRejection(message: SDKMessage): Error | null {
  if (message.type !== 'system' || (message as { subtype?: string }).subtype !== 'api_retry') return null;
  const retry = message as unknown as { error_status: number | null; error?: string };
  const status = retry.error_status;
  const kind = retry.error ?? 'unknown';
  const refused =
    (status !== null && CREDENTIAL_REJECTION_STATUSES.has(status)) || CREDENTIAL_REJECTION_ERRORS.has(kind);
  if (!refused) return null;
  // No raw provider text here (AWS names accounts, ARNs and token fragments;
  // Azure and GCP name resources and principals) — just the status and the SDK's
  // error name, both of which isAiAuthFailure matches. Provider-neutral wording:
  // which of the five is in play is a matter for the configuration, not for a
  // string assembled from a retry notice.
  return new Error(`The Claude provider refused the credentials (HTTP ${status ?? 'none'}; ${kind}).`);
}

/**
 * Run a single agent turn. `prompt` is the new user message. When `resume` is
 * set, the SDK continues that prior session (no need to replay history into the
 * prompt). Yields raw SDKMessages for the server layer to map to SSE events.
 *
 * Throws immediately on a credential rejection rather than yielding the retry
 * notices and waiting out the SDK's backoff — see `credentialRejection()`. The
 * throw leaves the `for await` here, which closes the underlying query (the SDK
 * shuts the subprocess down through the iterator's `return`), and reaches the
 * route's catch, which reports the credentials as invalid.
 *
 * `queryImpl` is injectable for tests (same as `runOneShot`).
 */
export async function* runAgentTurn(
  deps: AgentDeps,
  prompt: string,
  resume?: string,
  abortController?: AbortController,
  queryImpl: QueryFn = query,
): AsyncGenerator<SDKMessage> {
  const options = buildOptions(deps, resume, abortController);
  for await (const message of queryImpl({ prompt, options })) {
    const refused = credentialRejection(message);
    if (refused) throw refused;
    yield message;
  }
}

/** The `query`-shaped LLM caller, injectable so callers can be unit-tested. */
export type QueryFn = typeof query;

/**
 * Run the LLM ONCE, non-agentically, and return its final text. This is the same
 * `query()` primitive `runAgentTurn` uses (same Bedrock model + credentials), but
 * with every agentic affordance switched OFF: no MCP servers, no skills, no
 * session, `maxTurns: 1`, and `tools: []` so the model cannot call anything and
 * therefore cannot loop — it just reads the prompt and answers in one turn.
 *
 * For pure "prompt in → text out" tasks (e.g. suggesting a field mapping) where a
 * conversational, tool-using, session-bound agent turn would be the wrong shape.
 * `queryImpl` is injectable for tests.
 */
export async function runOneShot(env: Env, prompt: string, queryImpl: QueryFn = query): Promise<string> {
  const options: Options = {
    systemPrompt:
      'You are a precise data-mapping assistant. Follow the instructions exactly and, ' +
      'when asked for JSON, respond with ONLY the JSON — no prose, no code fences.',
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    maxTurns: 1,
    env: { ...process.env, ...providerEnv(env) },
    model: env.ANTHROPIC_MODEL,
  };
  let finalText = '';
  for await (const message of queryImpl({ prompt, options })) {
    // Same fail-fast as a chat turn: Auto-map and the AI health probe would
    // otherwise sit through the SDK's whole retry budget for a refused key.
    const refused = credentialRejection(message);
    if (refused) throw refused;
    if (message.type === 'result' && 'result' in message && typeof message.result === 'string') {
      finalText = message.result;
    }
  }
  return finalText;
}
