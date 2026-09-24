import { describe, it, expect } from 'vitest';
import {
  suggestMapping,
  sanitizeMappings,
  buildAutoMapPrompt,
  MIN_CONFIDENCE,
  type AutoMapRequest,
  type Mapping,
} from '../../src/util/auto-map.js';
import type { Env } from '../../src/config/env.js';
import type { QueryFn } from '../../src/agent/agent.js';
import { AI_KEY_INVALID_MESSAGE } from '../../src/agent/ai-errors.js';

/** A CONFIGURED install: model + region + one credential chain. The credential
 *  matters — suggestMapping refuses to call the LLM without one, so an
 *  env fake missing it would exercise the "Claude key not provided" path instead
 *  of the mapping logic under test. */
const env = {
  ANTHROPIC_MODEL: 'm',
  AWS_REGION: 'us-east-1',
  CLAUDE_CODE_USE_BEDROCK: true,
  AWS_BEARER_TOKEN_BEDROCK: 'test-token',
} as unknown as Env;

const req: AutoMapRequest = {
  targetClass: 'BOM',
  sourceFields: [
    { name: 'cust_nm', type: 'String' },
    { name: 'qty', type: 'Integer' },
    { name: 'junk', type: 'String' },
  ],
  targetProperties: [
    { name: 'CustomerName', dataType: '%String', required: true },
    { name: 'Quantity', dataType: '%Integer' },
    { name: 'OrderDate', dataType: '%Date' },
  ],
};

/** A fake `query` that yields a single result message carrying `text`. */
function fakeQuery(text: string): QueryFn {
  return (() =>
    (async function* () {
      yield { type: 'result', subtype: 'success', result: text } as never;
    })()) as unknown as QueryFn;
}

/** A fake `query` whose stream throws (LLM/transport failure). */
const throwingQuery = (() =>
  (async function* () {
    throw new Error('bedrock unavailable');
    // eslint-disable-next-line no-unreachable
    yield undefined as never;
  })()) as unknown as QueryFn;

describe('buildAutoMapPrompt', () => {
  it('includes the class, source fields with types, and target properties with required flag', () => {
    const p = buildAutoMapPrompt(req);
    expect(p).toContain('"BOM"');
    expect(p).toContain('cust_nm (String)');
    expect(p).toContain('CustomerName (%String) [required]');
    expect(p).toContain('OrderDate (%Date)');
    expect(p).toMatch(/ONLY this JSON/);
  });
});

describe('suggestMapping', () => {
  it('parses the model JSON and returns sanitized mappings', async () => {
    const reply = JSON.stringify({
      mappings: [
        { sourceField: 'cust_nm', targetProperty: 'CustomerName', confidence: 0.95, reason: 'name' },
        { sourceField: 'qty', targetProperty: 'Quantity', confidence: 0.9, reason: 'name' },
      ],
    });
    const res = await suggestMapping(env, req, fakeQuery(reply));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mappings.map((m) => [m.sourceField, m.targetProperty])).toEqual([
        ['cust_nm', 'CustomerName'],
        ['qty', 'Quantity'],
      ]);
    }
  });

  it('tolerates prose/code fences around the JSON', async () => {
    const reply = 'Here you go:\n```json\n{ "mappings": [ { "sourceField": "qty", "targetProperty": "Quantity", "confidence": 0.8, "reason": "x" } ] }\n```';
    const res = await suggestMapping(env, req, fakeQuery(reply));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mappings).toHaveLength(1);
  });

  it('returns ok:false on unparseable output', async () => {
    const res = await suggestMapping(env, req, fakeQuery('I could not do that.'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/parse/i);
  });

  it('returns ok:false when the LLM call throws', async () => {
    const res = await suggestMapping(env, req, throwingQuery);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('bedrock unavailable');
  });

  it('short-circuits to an empty mapping when there are no fields or properties', async () => {
    const res = await suggestMapping(env, { ...req, sourceFields: [] }, throwingQuery);
    expect(res).toEqual({ ok: true, mappings: [] });
  });

  // ── Claude unavailable ─────────────────────────────────
  it('reports the missing key WITHOUT calling the LLM when nothing is configured', async () => {
    let called = false;
    const spyQuery = (() => {
      called = true;
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: '{"mappings":[]}' } as never;
      })();
    }) as unknown as QueryFn;
    const unconfigured = { ANTHROPIC_MODEL: 'm', AWS_REGION: 'us-east-1' } as unknown as Env;

    const res = await suggestMapping(unconfigured, req, spyQuery);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/^Claude key not provided\./);
    // The point of the presence check: no subprocess is spawned to discover a fact
    // the config already stated.
    expect(called).toBe(false);
  });

  it('reports a REFUSED credential in plain words, not as the raw AWS text', async () => {
    const refusing = (() =>
      (async function* () {
        throw new Error('403 The security token included in the request is invalid (arn:aws:iam::123456789012:user/dev)');
        // eslint-disable-next-line no-unreachable
        yield undefined as never;
      })()) as unknown as QueryFn;

    const res = await suggestMapping(env, req, refusing);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toBe(AI_KEY_INVALID_MESSAGE);
      expect(res.message).toMatch(/Invalid credentials provided for Claude/);
      expect(res.message).not.toMatch(/arn:aws|123456789012/);
    }
  });

  it('still keeps a non-credential failure\'s own message', async () => {
    // Regression guard on the classifier: the invalid-credentials message must not swallow every
    // failure, or a throttle/outage reads as a bad key.
    const throttled = (() =>
      (async function* () {
        throw new Error('ThrottlingException: Too many requests');
        // eslint-disable-next-line no-unreachable
        yield undefined as never;
      })()) as unknown as QueryFn;

    const res = await suggestMapping(env, req, throttled);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('ThrottlingException');
  });
});

describe('sanitizeMappings', () => {
  it('drops phantom field/property names', () => {
    const raw: Mapping[] = [
      { sourceField: 'ghost', targetProperty: 'CustomerName', confidence: 1, reason: '' },
      { sourceField: 'cust_nm', targetProperty: 'Ghost', confidence: 1, reason: '' },
    ];
    expect(sanitizeMappings(raw, req)).toEqual([]);
  });

  it('drops below-threshold confidence', () => {
    const raw: Mapping[] = [
      { sourceField: 'cust_nm', targetProperty: 'CustomerName', confidence: MIN_CONFIDENCE - 0.01, reason: '' },
    ];
    expect(sanitizeMappings(raw, req)).toEqual([]);
  });

  it('enforces bijection, keeping the higher-confidence claim on a contested target', () => {
    // All three are above MIN_CONFIDENCE so this exercises the bijection rule, not
    // the threshold: cust_nm and junk both validly claim CustomerName; junk wins on
    // confidence and cust_nm is dropped because the target is taken.
    const raw: Mapping[] = [
      { sourceField: 'cust_nm', targetProperty: 'CustomerName', confidence: 0.7, reason: '' },
      { sourceField: 'junk', targetProperty: 'CustomerName', confidence: 0.99, reason: '' },
      { sourceField: 'qty', targetProperty: 'Quantity', confidence: 0.7, reason: '' },
    ];
    const out = sanitizeMappings(raw, req);
    // junk wins CustomerName (higher confidence); cust_nm is then dropped (target taken).
    expect(out.map((m) => [m.sourceField, m.targetProperty])).toEqual([
      ['junk', 'CustomerName'],
      ['qty', 'Quantity'],
    ]);
  });
});
