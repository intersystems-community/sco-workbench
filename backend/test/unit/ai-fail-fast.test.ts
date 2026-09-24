// backend/test/unit/ai-fail-fast.test.ts
//
// A REJECTED key must fail fast. The Agent SDK treats an auth rejection as a
// retryable error: it emits `system/api_retry` and sleeps with exponential
// backoff, once per attempt, up to `max_retries`, before failing the turn. With
// a bad key every attempt is refused identically, so the user watched
// "Thinking…" for the whole retry budget and only then learned the key was
// refused — an answer that was knowable on attempt 1.
//
// So: a retry we KNOW cannot succeed ends the turn immediately, while a retry
// that plausibly can (throttle, overload, 5xx, a dropped connection) is left
// alone — cutting those short would turn a momentary blip into a failed turn.
import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { credentialRejection, runOneShot, runAgentTurn, type QueryFn, type AgentDeps } from '../../src/agent/agent.js';
import { describeAiFailure, AI_KEY_INVALID_MESSAGE } from '../../src/agent/ai-errors.js';
import type { Env } from '../../src/config/env.js';

/** A CONFIGURED install — otherwise describeAiFailure reports the MISSING key
 *  and these tests would pass for the wrong reason. */
const env = {
  ANTHROPIC_MODEL: 'us.anthropic.claude',
  AWS_REGION: 'us-east-1',
  CLAUDE_CODE_USE_BEDROCK: true,
  AWS_BEARER_TOKEN_BEDROCK: 'a-rejected-token',
  AGENT_MAX_TURNS: 5,
} as unknown as Env;

/** Minimal deps: with `queryImpl` injected, buildOptions only has to be built,
 *  never used, so the brokers and IRIS services are never touched. */
const deps = { env, iris: {}, broker: {}, questions: {}, ui: {} } as unknown as AgentDeps;

/** An `api_retry` notice as the SDK emits it. `error_status` is null for
 *  connection-level failures that never got an HTTP response. */
function apiRetry(status: number | null, error: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 2000,
    error_status: status,
    error,
    uuid: '11111111-1111-1111-1111-111111111111',
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1' } as unknown as SDKMessage;
const RESULT = (text: string) =>
  ({ type: 'result', subtype: 'success', session_id: 'sess-1', result: text }) as unknown as SDKMessage;

interface Trace {
  /** Messages the stream actually produced — the second attempt must not appear. */
  produced: string[];
  /** Did the consumer close the stream (the SDK's subprocess-teardown path)? */
  closed: boolean;
}

/** A fake `query` yielding `messages`, recording what it produced and whether it
 *  was closed early. The `finally` fires when the consumer throws out of its
 *  `for await`, which is how the real SDK learns to kill the CLI subprocess. */
function fakeStream(messages: SDKMessage[], trace: Trace): QueryFn {
  return (() =>
    (async function* () {
      try {
        for (const m of messages) {
          trace.produced.push(`${m.type}/${(m as { subtype?: string }).subtype ?? ''}`);
          yield m as never;
        }
      } finally {
        trace.closed = true;
      }
    })()) as unknown as QueryFn;
}

function newTrace(): Trace {
  return { produced: [], closed: false };
}

describe('credentialRejection — which retries are hopeless', () => {
  const hopeless: Array<[string, number | null, string]> = [
    ['a 403 (the rejected/expired/wrong-format key)', 403, 'authentication_failed'],
    ['a 401 (unauthenticated request)', 401, 'unknown'],
    ['no status but the SDK names an auth failure', null, 'authentication_failed'],
    ['no status but the org is not allowed', null, 'oauth_org_not_allowed'],
  ];
  for (const [what, status, error] of hopeless) {
    it(`stops the turn for ${what}`, () => {
      const err = credentialRejection(apiRetry(status, error));
      expect(err).toBeInstanceOf(Error);
      // The whole point: the route's classifier must turn this into the short
      // user-facing message, not into a raw pass-through.
      expect(describeAiFailure(env, err)).toBe(AI_KEY_INVALID_MESSAGE);
    });
  }

  const transient: Array<[string, number | null, string]> = [
    ['a throttle', 429, 'rate_limit'],
    ['an overloaded model', 529, 'overloaded'],
    ['a server error', 500, 'server_error'],
    ['a dropped connection (no HTTP response at all)', null, 'unknown'],
    ['a gateway timeout', 504, 'server_error'],
  ];
  for (const [what, status, error] of transient) {
    it(`leaves the SDK's retries alone for ${what}`, () => {
      // Ending the turn here would convert a blip the SDK would have ridden out
      // into a failure, and (worse) report it as invalid credentials.
      expect(credentialRejection(apiRetry(status, error))).toBeNull();
    });
  }

  it('ignores messages that are not retry notices', () => {
    expect(credentialRejection(INIT)).toBeNull();
    expect(credentialRejection(RESULT('hello'))).toBeNull();
    expect(
      credentialRejection({ type: 'assistant', message: { content: [] } } as unknown as SDKMessage),
    ).toBeNull();
    // A 403 reported on some OTHER system message is not the retry loop we are
    // short-circuiting; the turn's own error path handles it.
    expect(
      credentialRejection({ type: 'system', subtype: 'status', error_status: 403 } as unknown as SDKMessage),
    ).toBeNull();
  });

  it('carries the status and the SDK error name, and no raw AWS text', () => {
    const err = credentialRejection(apiRetry(403, 'authentication_failed'))!;
    expect(err.message).toMatch(/403/);
    expect(err.message).toMatch(/authentication_failed/);
    // Nothing account-identifying can appear: we build the message ourselves
    // rather than forwarding the CLI's ("… arn:aws:iam::123456789012:user/dev").
    expect(err.message).not.toMatch(/arn:aws|AKIA|Bearer/);
  });
});

describe('runOneShot (Auto-map, the AI health probe)', () => {
  it('throws at the FIRST refused attempt instead of waiting out the retries', async () => {
    const trace = newTrace();
    const stream = fakeStream(
      [
        INIT,
        apiRetry(403, 'authentication_failed'),
        // Everything below is what the SDK would produce over the next several
        // backoff sleeps. Reaching any of it means we sat through the wait.
        apiRetry(403, 'authentication_failed'),
        apiRetry(403, 'authentication_failed'),
        RESULT(''),
      ],
      trace,
    );

    await expect(runOneShot(env, 'hi', stream)).rejects.toThrow(/refused the credentials/i);
    expect(trace.produced).toEqual(['system/init', 'system/api_retry']);
    expect(trace.closed).toBe(true); // the subprocess is torn down, not orphaned
  });

  it('reports the failure as invalid credentials through the normal classifier', async () => {
    const stream = fakeStream([apiRetry(403, 'authentication_failed')], newTrace());
    const err = await runOneShot(env, 'hi', stream).catch((e: unknown) => e);
    expect(describeAiFailure(env, err)).toBe(AI_KEY_INVALID_MESSAGE);
  });

  it('rides out a transient retry and still returns the answer', async () => {
    const trace = newTrace();
    const stream = fakeStream([INIT, apiRetry(429, 'rate_limit'), RESULT('{"mappings":[]}')], trace);
    await expect(runOneShot(env, 'hi', stream)).resolves.toBe('{"mappings":[]}');
    expect(trace.produced).toHaveLength(3); // nothing was cut short
  });
});

describe('runAgentTurn (the chat panel)', () => {
  /** Drain the turn, returning the messages it yielded and the error it threw. */
  async function drain(messages: SDKMessage[], trace: Trace) {
    const yielded: SDKMessage[] = [];
    let thrown: unknown;
    try {
      for await (const m of runAgentTurn(deps, 'What is data model?', undefined, undefined, fakeStream(messages, trace))) {
        yielded.push(m);
      }
    } catch (err) {
      thrown = err;
    }
    return { yielded, thrown };
  }

  it('ends the turn at the first refused attempt, so the panel explains itself at once', async () => {
    const trace = newTrace();
    const { yielded, thrown } = await drain(
      [INIT, apiRetry(403, 'authentication_failed'), apiRetry(403, 'authentication_failed'), RESULT('')],
      trace,
    );

    expect(describeAiFailure(env, thrown)).toBe(AI_KEY_INVALID_MESSAGE);
    // The init message reached the route (it records the SDK session id); the
    // retry notice itself is NOT yielded — it becomes the throw.
    expect(yielded.map((m) => m.type)).toEqual(['system']);
    expect((yielded[0] as { subtype?: string }).subtype).toBe('init');
    expect(trace.produced).toEqual(['system/init', 'system/api_retry']);
    expect(trace.closed).toBe(true);
  });

  it('passes a transient retry through and finishes the turn normally', async () => {
    const trace = newTrace();
    const { yielded, thrown } = await drain([INIT, apiRetry(429, 'rate_limit'), RESULT('Hi there.')], trace);

    expect(thrown).toBeUndefined();
    expect(yielded).toHaveLength(3);
    expect(trace.closed).toBe(true);
  });
});
