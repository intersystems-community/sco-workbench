// backend/src/dashboard/ai-health.ts
import { aiConfigured, describeProvider, type ClaudeProviderId, type Env } from '../config/env.js';
import { runOneShot, type QueryFn } from '../agent/agent.js';
import { aiKeyMissingMessage, describeAiFailure } from '../agent/ai-errors.js';

/**
 * The one fact the proactive breaker needs: can the LLM be reached? Plus WHICH of
 * the five Claude providers answered (or refused), because with multi-provider
 * support "the AI is unavailable" is only half an answer — an operator needs to
 * know whether the probe even went to the provider they configured. This is what
 * makes GET /ai-health the per-provider connectivity test: one real round-trip
 * through whatever the environment selected, reported by name.
 *
 * No credential VALUE is ever included here — only the provider's identity, its
 * label, and a message already scrubbed by `describeAiFailure`.
 */
export interface AiHealth {
  available: boolean;
  /** Why not, when unavailable — the thrown error's message (for the tooltip). */
  reason?: string;
  /** The resolved provider id, or null when nothing about Claude is configured. */
  provider?: ClaudeProviderId | null;
  /** Human name of that provider, e.g. "Amazon Bedrock". */
  providerLabel?: string;
}

interface ProbeOpts {
  /** Injected LLM call, for tests. Defaults to a real minimal runOneShot. */
  runImpl?: (env: Env) => Promise<string>;
  /** Injected clock (ms), for TTL tests. Defaults to Date.now. */
  now?: () => number;
  /** Cache lifetime. A live server shares one probe across users for this long. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * A cached liveness probe for the chart advisor's LLM. `check()` runs at most ONE
 * real Bedrock round-trip per TTL window and coalesces concurrent callers onto a
 * single in-flight probe, so a page-load fan-out (every browser calling
 * /ai-health at once) costs one probe, not one per client. The distinction it
 * draws matches the per-request advisor's `unavailable`: only a THROW (auth/config/
 * network) is unavailable; any answer at all is "reachable". A minimal, cheap
 * prompt keeps the token cost of the probe near zero.
 *
 * Credentials are no longer a boot gate (the workbench runs without Claude), so
 * `check()` answers the ABSENT case itself, without a probe: there is
 * nothing to reach and no reason to spend a subprocess spawn discovering that.
 * The probe therefore exists for what a presence check cannot see — creds that are
 * present but INVALID (an expired token, the dummy AWS creds, a wrong region), the
 * 403-security-token case.
 */
export class AiHealthProbe {
  private readonly run: (env: Env) => Promise<string>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; health: AiHealth } | null = null;
  private inFlight: Promise<AiHealth> | null = null;

  constructor(private readonly env: Env, opts: ProbeOpts = {}) {
    this.run = opts.runImpl ?? ((env) => runOneShot(env, PROBE_PROMPT));
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async check(): Promise<AiHealth> {
    // Nothing configured — unavailable by definition. Not cached: it is derived
    // from static config, so there is no window to keep it in.
    if (!aiConfigured(this.env)) {
      return { available: false, reason: aiKeyMissingMessage(this.env), ...this.provider() };
    }
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.health;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async probe(): Promise<AiHealth> {
    let health: AiHealth;
    try {
      await this.run(this.env);
      health = { available: true, ...this.provider() };
    } catch (err) {
      // Same classifier the chat route and Auto-map use, so a refused credential
      // reads the same everywhere — and the raw provider text (AWS account ids and
      // ARNs, Azure resources, GCP principals) never leaves the server in this
      // response body. Anything else keeps its message.
      health = { available: false, reason: describeAiFailure(this.env, err), ...this.provider() };
    }
    this.cached = { at: this.now(), health };
    return health;
  }

  /** The provider fields every answer carries. Identity only, never credentials. */
  private provider(): Pick<AiHealth, 'provider' | 'providerLabel'> {
    const status = describeProvider(this.env);
    return { provider: status.id, providerLabel: status.label };
  }
}

/** Cheapest possible reachability check — a one-token reply is enough to prove the round-trip. */
const PROBE_PROMPT = 'Reply with the single word: OK.';
