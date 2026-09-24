import {
  setAiEnabled,
  isAiEnabled,
  AI_KEY_MISSING_PLACEHOLDER,
  AI_KEY_MISSING_SHORT,
  AI_KEY_MISSING_MESSAGE,
} from './ai-status';
import { loadAppConfig } from './app-config';

/**
 * The AI capability flag. Everything in the workbench that is backed by
 * Claude reads this to degrade BEFORE the click, so the two things that matter are
 * (a) an explicit `aiEnabled: false` from the backend reaches it, and (b) nothing
 * else does — a config.json that 404s, times out, or predates the field must leave
 * the assistant enabled rather than hide working features.
 */
function fakeFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
}

describe('ai-status', () => {
  // Module-level state, so a test that disables AI would leak into the next one.
  afterEach(() => setAiEnabled(true));

  it('is enabled before any config is applied', () => {
    // The compile-time default. A bundle that never reached /config.json still
    // offers the assistant; the backend is the one that refuses, with a reason.
    expect(isAiEnabled()).toBe(true);
  });

  it('an explicit false disables it, and true turns it back on', () => {
    setAiEnabled(false);
    expect(isAiEnabled()).toBe(false);
    setAiEnabled(true);
    expect(isAiEnabled()).toBe(true);
  });

  it('treats a missing/garbage value as enabled (fail open)', () => {
    for (const value of [undefined, null, '', 'false', 0, NaN]) {
      setAiEnabled(true);
      setAiEnabled(value);
      // Only the boolean false speaks. 'false' the STRING is what a mis-generated
      // config.json would contain, and it must not disable anything.
      expect(isAiEnabled(), `value ${String(value)}`).toBe(true);
    }
  });

  it('the composer placeholder is the exact short phrase', () => {
    // Rendered inside a one-line input: a sentence would be clipped.
    expect(AI_KEY_MISSING_PLACEHOLDER).toBe('Claude key not provided');
    expect(AI_KEY_MISSING_PLACEHOLDER).not.toMatch(/\.$/);
  });

  it('the long message names what to set and says the rest still works', () => {
    expect(AI_KEY_MISSING_MESSAGE).toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(AI_KEY_MISSING_MESSAGE).toContain('AWS_REGION');
    expect(AI_KEY_MISSING_MESSAGE).toContain('ANTHROPIC_MODEL');
    expect(AI_KEY_MISSING_MESSAGE).toMatch(/keeps working/i);
    // Every variant leads with the same phrase, so the wording is recognisable
    // whichever surface the user hits first.
    expect(AI_KEY_MISSING_MESSAGE.startsWith(AI_KEY_MISSING_PLACEHOLDER)).toBe(true);
    expect(AI_KEY_MISSING_SHORT.startsWith(AI_KEY_MISSING_PLACEHOLDER)).toBe(true);
  });
});

describe('loadAppConfig — aiEnabled', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setAiEnabled(true);
  });

  it('applies aiEnabled: false from /config.json', async () => {
    globalThis.fetch = fakeFetch({ apiBaseUrl: '', aiEnabled: false });
    await loadAppConfig();
    expect(isAiEnabled()).toBe(false);
  });

  it('leaves AI enabled when the field is absent (older backend / nginx config)', async () => {
    globalThis.fetch = fakeFetch({ apiBaseUrl: '', namespace: 'SCO' });
    await loadAppConfig();
    expect(isAiEnabled()).toBe(true);
  });

  it('leaves AI enabled when /config.json is missing or unreadable', async () => {
    globalThis.fetch = fakeFetch({}, false); // 404
    await loadAppConfig();
    expect(isAiEnabled()).toBe(true);

    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await loadAppConfig();
    expect(isAiEnabled()).toBe(true);
  });

  it('ignores a non-boolean aiEnabled', async () => {
    // A hand-edited config.json with a quoted value must not flip the flag either way.
    globalThis.fetch = fakeFetch({ aiEnabled: 'false' });
    await loadAppConfig();
    expect(isAiEnabled()).toBe(true);
  });
});
