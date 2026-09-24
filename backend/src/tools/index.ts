import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { IrisServices } from '../iris/index.js';
import type { QuestionBroker } from '../server/question.js';
import type { UiControlBroker } from '../server/ui-control.js';
import type { ConfirmationBroker } from '../server/confirm.js';
import type { AuditSink } from '../db/audit.js';
import { gateHandler } from './gate.js';
import { askTools } from './ask-tools.js';
import { compileTools } from './compile-tools.js';
import { cubeTools } from './cube-tools.js';
import { integrationTools } from './integration-tools.js';
import { kpiTools } from './kpi-tools.js';
import { lookupTools } from './lookup-tools.js';
import { productionTools } from './production-tools.js';
import { schemaTools } from './schema-tools.js';
import { uiTools, UI_TOOL_NAMES, UI_REPORT_STATUS_TOOL } from './ui-tools.js';

/** The SDK MCP server name; tools are exposed as `mcp__sco__<toolName>`. */
export const SCO_MCP_SERVER = 'sco';

/**
 * Tools that change the state of the running IRIS instance. These are gated by
 * the confirmation broker FROM INSIDE their handlers (see gate.ts); everything
 * else runs freely.
 */
export const STATE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  'sco_import_class',
  'sco_compile_class',
  'sco_build_cube',
  'sco_add_config_item',
  'sco_remove_config_item',
  'sco_enable_config_item',
  'sco_update_production',
  'sco_create_kpi',
  'sco_update_kpi',
  'sco_delete_kpi',
]);

/**
 * Read-only LOOKUP tools that answer "what is X?" about the instance without changing
 * anything. These are available in BOTH modes.
 *
 * Guided mode needs them because its page context only covers the page the user is
 * ON: someone looking at the Customer object can perfectly well ask about Sales Order,
 * or ask a KPI question from the Data Model page. Without a way to look those up, the
 * assistant either answers from memory (i.e. invents) or has to `ui_navigate` away and
 * move the user's page out from under them just to read something. Reading is not
 * acting — nothing here writes to the instance, and the mutating tools stay denied in
 * Guided mode.
 */
export const CONTEXT_LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  // what does this class/object look like?
  'sco_resolve_class',
  'sco_list_properties',
  'sco_list_methods',
  'sco_match_property',
  'sco_suggest_dimension_sources',
  'sco_list_data_objects',
  'sco_get_data_object',
  'sco_row_count',
  // what cubes exist, and what shape are they?
  'sco_list_cubes',
  'sco_cube_info',
  'sco_cube_detail',
  'sco_cube_members',
  // what KPIs exist?
  'sco_list_kpis',
  'sco_get_kpi',
  // what is running?
  'sco_production_status',
  'sco_list_config_items',
]);

/** Is this a read-only lookup tool, allowed even in Guided mode? */
export function isContextLookupTool(toolName: string): boolean {
  const bare = toolName.replace(new RegExp(`^mcp__${SCO_MCP_SERVER}__`), '');
  return CONTEXT_LOOKUP_TOOLS.has(bare);
}

/** All tool names this server exposes (bare names, without the mcp__ prefix). */
export const ALL_TOOL_NAMES: readonly string[] = [
  // human-in-the-loop (read-only: blocks for user input, changes nothing)
  'ask_user_question',
  // schema introspection (read-only)
  'sco_resolve_class',
  'sco_list_properties',
  'sco_list_methods',
  'sco_match_property',
  'sco_suggest_dimension_sources',
  // discovery: what exists / what shape is it (read-only)
  'sco_list_cubes',
  'sco_cube_detail',
  'sco_cube_members',
  'sco_list_data_objects',
  'sco_get_data_object',
  'sco_row_count',
  // compile
  'sco_import_class',
  'sco_compile_class',
  // cube
  'sco_generate_cube_cls',
  'sco_build_cube',
  'sco_cube_info',
  // data-integration (read-only: deterministically generate the pipeline classes)
  'sco_generate_integration_classes',
  // kpi (read-only list/get; state-changing create/update/delete)
  'sco_list_kpis',
  'sco_get_kpi',
  'sco_create_kpi',
  'sco_update_kpi',
  'sco_delete_kpi',
  // production
  'sco_production_status',
  'sco_list_config_items',
  'sco_add_config_item',
  'sco_remove_config_item',
  'sco_enable_config_item',
  'sco_update_production',
  // guided-mode UI directives (read-only w.r.t. IRIS; drive the Angular UI)
  ...UI_TOOL_NAMES,
  // agent-mode UI directive: report a lifecycle step's real outcome to the UI
  UI_REPORT_STATUS_TOOL,
];

/**
 * UI-directive tools (Guided mode). These change only the local Angular UI, not
 * IRIS. They're available in Guided mode and DENIED in Agent mode; conversely
 * the `sco_*` tools are denied in Guided mode. Enforced in the permission gate.
 */
export const UI_TOOLS: ReadonlySet<string> = new Set(UI_TOOL_NAMES);

/** Is a tool (bare or qualified name) a Guided-mode UI-directive tool? */
export function isUiTool(toolName: string): boolean {
  const bare = toolName.replace(new RegExp(`^mcp__${SCO_MCP_SERVER}__`), '');
  return UI_TOOLS.has(bare);
}

/** Fully-qualified tool name as the SDK exposes it to allowedTools. */
export function qualifiedToolName(bare: string): string {
  return `mcp__${SCO_MCP_SERVER}__${bare}`;
}

/** Is a tool (bare or qualified name) state-changing and thus gated? */
export function isStateChanging(toolName: string): boolean {
  const bare = toolName.replace(new RegExp(`^mcp__${SCO_MCP_SERVER}__`), '');
  return STATE_CHANGING_TOOLS.has(bare);
}

/**
 * The built-in tools this agent legitimately offers, beside our own catalog.
 * Both are load-bearing and both are verified in the unit tests:
 * - `Skill`: the system prompt REQUIRES a skill to be invoked before any work.
 * - `AskUserQuestion`: aliased to our `ask_user_question`, so the built-in's call
 *   runs our handler and reaches the tabbed popup. It must be OFFERED (it is in
 *   the `tools` bound) or the model never emits the name and the alias never
 *   fires.
 *
 * Note this list is the OFFER surface, which is not the same as what the
 * `canUseTool` callback observes. Measured: the alias is resolved BEFORE the
 * callback, so when the model emits `AskUserQuestion` the callback is asked about
 * `mcp__sco__ask_user_question` — the target, never the built-in name. That is
 * why `isOurTool` recognizing our own catalog is sufficient for the alias path.
 */
export const ALLOWED_BUILTIN_TOOLS: readonly string[] = ['Skill', 'AskUserQuestion'];

/**
 * Is this a tool this agent is supposed to have at all? Used by the `canUseTool`
 * callback, which enforces containment and mode rather than the approval gate —
 * see `agent.ts`. Anything else (a built-in that slipped past the `tools` bound,
 * a foreign MCP server) is denied there rather than allowed.
 */
export function isOurTool(toolName: string): boolean {
  if (ALLOWED_BUILTIN_TOOLS.includes(toolName)) return true;
  const prefix = `mcp__${SCO_MCP_SERVER}__`;
  return toolName.startsWith(prefix) && ALL_TOOL_NAMES.includes(toolName.slice(prefix.length));
}

/**
 * Build the in-process MCP server exposing the FULL SUPERSET of tools (IRIS +
 * guided-mode UI directives). The set of tool DEFINITIONS is identical on every
 * turn regardless of mode — mode is enforced at the permission layer
 * (canUseTool) so the Bedrock prompt-cache prefix stays stable across mode
 * switches. The QuestionBroker backs `ask_user_question`; the UiControlBroker
 * backs the `ui_*` directive tools.
 *
 * The ConfirmationBroker gates the state-changing tools FROM INSIDE THEIR
 * HANDLERS (see `gate.ts` for the measured reason): the handler is the only path
 * to the IRIS call, whereas the `canUseTool` callback is a position the SDK can
 * be made to skip. Read-only tools (and the UI-directive tools, which touch only
 * the local UI) are wired through untouched.
 *
 * `audit` records each decision before the action runs, and a failure to record
 * denies it. Optional here only so a caller without a database still gets the
 * approval gate; the server always supplies one.
 */
export function createScoMcpServer(
  iris: IrisServices,
  questions: QuestionBroker,
  ui: UiControlBroker,
  broker: ConfirmationBroker,
  audit?: AuditSink,
) {
  const tools = [
    ...askTools(questions),
    ...schemaTools(iris),
    ...compileTools(iris),
    ...cubeTools(iris),
    ...integrationTools(iris),
    ...kpiTools(iris),
    ...lookupTools(iris),
    ...productionTools(iris),
    ...uiTools(ui),
  ];
  return createSdkMcpServer({
    name: SCO_MCP_SERVER,
    version: '0.1.0',
    // Gate exactly the tools STATE_CHANGING_TOOLS names — one list drives both the
    // wrapper and `isStateChanging`, so a new mutating tool cannot be gated in one
    // place and not the other.
    tools: tools.map((t) => (isStateChanging(t.name) ? gateHandler(t, broker, audit) : t)),
  });
}
