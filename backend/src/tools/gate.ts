import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { describeAction, type ConfirmationBroker } from '../server/confirm.js';
import type { AuditSink } from '../db/audit.js';
import { fail } from './result.js';

/**
 * Any tool definition, whatever its zod schema. `SdkMcpToolDefinition`'s schema
 * parameter makes each `tool()` call a distinct type, and the wrapper is
 * schema-agnostic: it inspects the args only as a plain record to describe them
 * to the user, and otherwise hands them to the wrapped handler untouched. The
 * `unknown` args type keeps that honest — the wrapper never reads a named field.
 */
type AnyToolDefinition = Omit<SdkMcpToolDefinition, 'handler'> & {
  handler: (args: never, extra: unknown) => ReturnType<SdkMcpToolDefinition['handler']>;
};

/**
 * Record-and-run gate on the only path to the side effect.
 *
 * State-changing IRIS actions (compile, add/enable config item, update
 * production, build cube, KPI create/update/delete) now run **without an
 * interactive approval prompt** — the product decision is that Deploy and the
 * other agent flows should just do the work. What this wrapper still guarantees,
 * and why it stays on the handler rather than being deleted, is the **audit
 * trail**: every mutating call is recorded (fail-closed) BEFORE the IRIS call
 * runs, from the one code path the SDK cannot route around.
 *
 * Why the handler and not the SDK's `canUseTool` callback: `canUseTool` is a
 * POSITION the SDK decides whether to visit, and two innocuous-looking options
 * make it skip that position. Measured against the real CLI:
 *
 *   config                                    callback  handler  outcome
 *   gate in canUseTool                         yes       no       (callback ran)
 *   + one bare name in `allowedTools`          NO        yes      callback SKIPPED
 *   + permissionMode:'bypassPermissions'       NO        yes      callback SKIPPED
 *   gate in the handler (this module)          n/a       yes      always runs
 *
 * The handler *is* the only path to the IRIS call, so recording here means a
 * mutation can never run unrecorded, regardless of SDK permission config.
 *
 * `broker` is retained in the signature (unused now) so the wiring in
 * `createScoMcpServer` and the tests don't have to change shape; auto-approval
 * is the policy, and re-introducing a prompt later is a one-line change here.
 */

/**
 * Wrap one tool definition so its execution is audited (and, historically,
 * confirmed). Applied only to the state-changing tools (see
 * `createScoMcpServer`); read-only tools are returned untouched.
 *
 * `audit` is optional so a caller with no database (the unit tests, and any
 * future non-persistent embedding) still runs. It is NOT optional in the
 * server: `createApp` always passes one.
 */
export function gateHandler<Def extends AnyToolDefinition>(
  def: Def,
  _broker: ConfirmationBroker,
  audit?: AuditSink,
): Def {
  const handler: Def['handler'] = async (args, extra) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const summary = describeAction(def.name, input);

    // ORDER MATTERS: RECORD → execute. Recording before dispatch makes an
    // unrecorded write impossible (recording after would leave a window where
    // the process dies between the IRIS call and the record, and the class stays
    // compiled either way). The action is auto-approved, so we log it as such —
    // the trail still answers "what ran, with what input, when."
    if (audit) {
      try {
        audit.record({ toolName: def.name, summary, input, decision: 'approve' });
      } catch (err) {
        // Fail CLOSED. A disk-full or locked database is exactly when an
        // unrecorded write is worst, so an action that cannot be recorded does
        // not happen. Note this returns before `def.handler` — the denial is the
        // point, not the message.
        const reason = err instanceof Error ? err.message : String(err);
        return fail(
          `This action was refused because it could not be recorded in the audit trail: ${reason}`,
        );
      }
    }

    return def.handler(args, extra);
  };
  return { ...def, handler };
}
