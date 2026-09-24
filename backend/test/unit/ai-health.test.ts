// backend/test/unit/ai-health.test.ts
//
// The cached AI liveness probe behind the dashboard's proactive circuit breaker.
// It answers ONE question — can the LLM be reached at all? — and caches the answer
// so repeated page loads and concurrent users share a single real Bedrock probe
// rather than each spending tokens. Only an OUTAGE (the call threw: auth/config/
// network) is "unavailable"; a model that answers at all is available (a bad answer
// is the per-request advisor's problem, not the breaker's).
import { describe, it, expect, vi } from 'vitest';
import { AiHealthProbe } from '../../src/dashboard/ai-health.js';
import type { Env } from '../../src/config/env.js';

/** A CONFIGURED install — model + region + a credential. Without the credential
 *  `check()` short-circuits to "Claude key not provided" and never probes at all,
 *  which is its own test at the bottom of this file. */
const env = {
  ANTHROPIC_MODEL: 'test',
  AWS_REGION: 'us-east-1',
  AWS_BEARER_TOKEN_BEDROCK: 'test-token',
} as unknown as Env;

/** A fake runOneShot: resolves (reachable) or rejects (outage), counting calls. */
function fakeQuery(behavior: 'ok' | 'throw', counter: { n: number }) {
  return async () => {
    counter.n++;
    if (behavior === 'throw') throw new Error('403 The security token included in the request is invalid');
    return 'OK';
  };
}

describe('AiHealthProbe', () => {
  it('reports available when the probe call resolves', async () => {
    const counter = { n: 0 };
    const probe = new AiHealthProbe(env, { runImpl: fakeQuery('ok', counter) });
    // Every answer also names WHICH of the five Claude providers was probed — with
    // multi-provider support, "reachable" without a provider leaves an operator
    // unable to tell whether the probe even went where they configured it.
    expect(await probe.check()).toEqual({
      available: true,
      provider: 'bedrock',
      providerLabel: 'Amazon Bedrock',
    });
    expect(counter.n).toBe(1);
  });

  it('reports unavailable with the reason when the probe call throws (an outage)', async () => {
    const counter = { n: 0 };
    const probe = new AiHealthProbe(env, { runImpl: fakeQuery('throw', counter) });
    const health = await probe.check();
    expect(health.available).toBe(false);
    // A refused credential gets the same actionable wording as every other AI
    // entry point, and the raw AWS text (which named an ARN and an account id)
    // does not travel in this response body.
    expect(health.reason).toMatch(/Invalid credentials provided for Claude/);
    expect(health.reason).toMatch(/restart the server/);
    expect(health.reason).not.toMatch(/security token|arn:aws/);
  });

  it('keeps a NON-credential failure\'s own message as the reason', async () => {
    // The breaker's tooltip should say "throttled" when it was throttled — the
    // credential wording must not swallow every outage.
    const probe = new AiHealthProbe(env, {
      runImpl: async () => { throw new Error('ThrottlingException: Too many requests'); },
    });
    expect((await probe.check()).reason).toBe('ThrottlingException: Too many requests');
  });

  it('caches within the TTL — a second check does NOT spend a second probe', async () => {
    const counter = { n: 0 };
    let clock = 1000;
    const probe = new AiHealthProbe(env, { runImpl: fakeQuery('ok', counter), now: () => clock, ttlMs: 60_000 });
    await probe.check();
    clock += 30_000; // still inside the window
    await probe.check();
    expect(counter.n).toBe(1); // one real probe served both
  });

  it('re-probes after the TTL expires', async () => {
    const counter = { n: 0 };
    let clock = 1000;
    const probe = new AiHealthProbe(env, { runImpl: fakeQuery('ok', counter), now: () => clock, ttlMs: 60_000 });
    await probe.check();
    clock += 61_000; // past the window
    await probe.check();
    expect(counter.n).toBe(2);
  });

  it('collapses concurrent callers onto ONE in-flight probe (no thundering herd on load)', async () => {
    const counter = { n: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const probe = new AiHealthProbe(env, {
      runImpl: async () => { counter.n++; await gate; return 'OK'; },
    });
    const a = probe.check();
    const b = probe.check(); // fired before the first resolves
    release();
    const [ha, hb] = await Promise.all([a, b]);
    expect(ha).toMatchObject({ available: true, provider: 'bedrock' });
    expect(hb).toMatchObject({ available: true, provider: 'bedrock' });
    expect(counter.n).toBe(1); // both awaited the same probe
  });

  it('a transient outage is not cached forever — a later check can recover', async () => {
    const counter = { n: 0 };
    let clock = 1000;
    let behavior: 'ok' | 'throw' = 'throw';
    const probe = new AiHealthProbe(env, {
      runImpl: async () => { counter.n++; if (behavior === 'throw') throw new Error('down'); return 'OK'; },
      now: () => clock, ttlMs: 10_000,
    });
    expect((await probe.check()).available).toBe(false);
    behavior = 'ok';
    clock += 11_000;
    expect((await probe.check()).available).toBe(true);
  });

  it('reports the missing key WITHOUT probing when no credentials are configured', async () => {
    // The workbench boots without Claude, so "no key" is a normal state,
    // not an outage to discover the expensive way: spawning the SDK subprocess
    // could only fail, and its error text would blame the wrong thing.
    const counter = { n: 0 };
    const unconfigured = { ANTHROPIC_MODEL: 'test', AWS_REGION: 'us-east-1' } as unknown as Env;
    const probe = new AiHealthProbe(unconfigured, { runImpl: fakeQuery('ok', counter) });

    const health = await probe.check();

    expect(health.available).toBe(false);
    expect(health.reason).toMatch(/Claude key not provided/i);
    expect(counter.n).toBe(0); // nothing was spent finding out
  });

  it('treats a model or region with no credential chain as unconfigured', async () => {
    const counter = { n: 0 };
    // A region + model but no bearer token / profile / access-key pair — exactly
    // what a copied .env.example gives you (`AWS_BEARER_TOKEN_BEDROCK=` is empty).
    const partial = {
      ANTHROPIC_MODEL: 'test',
      AWS_REGION: 'us-east-1',
      AWS_BEARER_TOKEN_BEDROCK: '',
      AWS_ACCESS_KEY_ID: 'AKIA_ONLY_HALF',
    } as unknown as Env;
    const probe = new AiHealthProbe(partial, { runImpl: fakeQuery('ok', counter) });

    expect((await probe.check()).available).toBe(false);
    expect(counter.n).toBe(0);
  });
});
