import { randomUUID } from 'node:crypto';

/**
 * Human-in-the-loop confirmation broker.
 *
 * The agent's canUseTool callback asks this broker to confirm a state-changing
 * IRIS action. The broker emits a `confirm_request` to the UI (via the provided
 * emitter), then returns a promise that resolves when the UI POSTs the user's
 * decision back (resolveDecision) — or auto-resolves in non-interactive tests.
 */

export interface ConfirmRequest {
  confirmId: string;
  toolName: string;
  /** Compact description of the action for the UI prompt. */
  summary: string;
  input: Record<string, unknown>;
}

export type Decision = 'approve' | 'reject';

export interface ConfirmEmitter {
  (req: ConfirmRequest): void;
}

interface Pending {
  resolve: (d: Decision) => void;
  request: ConfirmRequest;
}

export class ConfirmationBroker {
  private pending = new Map<string, Pending>();

  constructor(private readonly emit: ConfirmEmitter) {}

  /** Ask the user to approve an action. Resolves with their decision. */
  request(toolName: string, summary: string, input: Record<string, unknown>): Promise<Decision> {
    const confirmId = randomUUID();
    const request: ConfirmRequest = { confirmId, toolName, summary, input };
    return new Promise<Decision>((resolve) => {
      this.pending.set(confirmId, { resolve, request });
      this.emit(request);
    });
  }

  /** Resolve a pending confirmation from the UI. Returns false if unknown. */
  resolveDecision(confirmId: string, decision: Decision): boolean {
    const p = this.pending.get(confirmId);
    if (!p) return false;
    this.pending.delete(confirmId);
    p.resolve(decision);
    return true;
  }

  /** Reject all outstanding confirmations (e.g. on client disconnect). */
  rejectAll(): void {
    for (const [, p] of this.pending) p.resolve('reject');
    this.pending.clear();
  }

  get outstanding(): number {
    return this.pending.size;
  }
}

/** Build a short human-readable summary of a gated tool action. */
export function describeAction(toolName: string, input: Record<string, unknown>): string {
  const bare = toolName.replace(/^mcp__sco__/, '');
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (bare) {
    case 'sco_import_class':
      return `Import class ${s('className') ?? '(unknown)'} into SCO.`;
    case 'sco_compile_class':
      return `Import and compile class ${s('className') ?? '(unknown)'} in SCO.`;
    case 'sco_build_cube':
      return `Build (populate) cube ${s('cubeName') ?? '(unknown)'} in SCO.`;
    case 'sco_add_config_item': {
      // enabled defaults to false — the host is configured but NOT started.
      const action = input.enabled === true ? 'Add and enable' : 'Add (disabled)';
      const cls = s('className') ?? '(unknown)';
      const named = s('name');
      const host = named && named !== cls ? `${cls} as "${named}"` : cls;
      return `${action} ${host} on production ${s('productionName') ?? '(active)'}.`;
    }
    case 'sco_enable_config_item':
      return `${input.enabled === false ? 'Disable' : 'Enable'} config item ${s('name') ?? '(unknown)'} on the running production.`;
    case 'sco_remove_config_item':
      return `Remove config item ${s('name') ?? '(unknown)'} from production ${s('productionName') ?? '(active)'}.`;
    case 'sco_update_production':
      return 'Apply pending changes to the running production.';
    case 'sco_create_kpi': {
      const def = input.definition as { name?: unknown } | undefined;
      const name = typeof def?.name === 'string' ? def.name : '(unknown)';
      return `Create Business KPI "${name}" in SCO.`;
    }
    case 'sco_update_kpi':
      return `Update Business KPI "${s('name') ?? '(unknown)'}" in SCO.`;
    case 'sco_delete_kpi':
      return `Delete Business KPI "${s('name') ?? '(unknown)'}" from SCO.`;
    default:
      return `Run ${bare}.`;
  }
}
