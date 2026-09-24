import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';
import type { Env } from '../../src/config/env.js';

// Minimal env cast, matching confirm.test.ts (line 331). buildSystemPrompt reads only a few fields.
const env = {
  IRIS_NAMESPACE: 'SC', ANTHROPIC_MODEL: 'm', IRIS_WEB_PORT: 52773, IRIS_SUPERSERVER_PORT: 1972,
} as unknown as Env;

// The stable marker the steer must carry. If the steer's wording is reworded, keep this phrase (or
// update BOTH the prompt and this constant in lockstep — that is the point of the guard).
const STEER_MARKER = 'SCO 1.8.0';

describe('system prompt carries the 1.7.3 KPI-condition steer (both modes)', () => {
  it('is present in the agent-mode prompt', () => {
    expect(buildSystemPrompt(env, 'agent')).toContain(STEER_MARKER);
  });
  it('is present in the guided-mode prompt', () => {
    expect(buildSystemPrompt(env, 'guided')).toContain(STEER_MARKER);
  });
});
