import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/sqlite.js';
import { createApp, normalizeUiAckResult } from '../../src/server/app.js';
import { listToolAudit } from '../../src/db/audit.js';
import type { AgentDeps } from '../../src/agent/agent.js';
import type { Env } from '../../src/config/env.js';
import type { IrisServices } from '../../src/iris/index.js';

// Mock the agent so no Bedrock/IRIS call happens; emit a couple of SDK messages.
// Capture the args runAgentTurn is called with so we can assert resume behavior.
const agentCalls: Array<{ prompt: string; resume?: string; deps: AgentDeps }> = [];
vi.mock('../../src/agent/agent.js', () => ({
  runAgentTurn: async function* (deps: AgentDeps, prompt: string, resume?: string) {
    agentCalls.push({ prompt, resume, deps });
    yield { type: 'system', subtype: 'init', session_id: 'sdk-sess-123' };
    // A test hook: a prompt asking to "boom" makes the turn throw mid-stream, so
    // we can exercise the chat error branch (SSE `error` event, not a crash).
    if (prompt.includes('boom')) throw new Error('agent exploded');
    // A second hook: "badkey" fails the way Bedrock fails a rejected credential,
    // so the chat route's error mapping (the invalid-credentials message) is exercised end to end.
    if (prompt.includes('badkey')) {
      throw new Error('403 The security token included in the request is invalid (arn:aws:iam::123456789012:user/dev)');
    }
    yield { type: 'stream_event', session_id: 'sdk-sess-123', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } };
    yield { type: 'result', subtype: 'success', session_id: 'sdk-sess-123', result: 'Hi there.' };
  },
}));

/** fetch + parse JSON as `any` for terse test assertions. */
async function json(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  return res.json();
}

// A fully configured install, Claude included: the chat route refuses to start a
// turn at all without credentials, so an env fake missing them would
// exercise the degraded path in every chat test below. The degraded path has its
// own suite ("Claude unavailable") using a deliberately credential-less env.
const env = {
  SCO_NAMESPACE: 'SC',
  SCO_HOST: 'localhost',
  SCO_WEB_PORT: 52773,
  WORKBENCH_API_TOKEN: 'test-token',
  ANTHROPIC_MODEL: 'us.anthropic.claude',
  AWS_REGION: 'us-east-1',
  AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-token',
} as unknown as Env;

const iris = {
  atelier: { readClass: async () => '' },
  native: {},
  namespace: 'SC',
  close: () => {},
} as unknown as IrisServices;

const authHeader = { Authorization: 'Bearer test-token' } as const;

describe('normalizeUiAckResult (SC-2662 fail-closed)', () => {
  it('maps a non-boolean applied to false (fail closed)', () => {
    expect(normalizeUiAckResult({ applied: 'yes' }).applied).toBe(false);
    expect(normalizeUiAckResult({}).applied).toBe(false);
    expect(normalizeUiAckResult({ applied: null }).applied).toBe(false);
  });
  it('passes a real boolean applied through unchanged', () => {
    expect(normalizeUiAckResult({ applied: true }).applied).toBe(true);
    expect(normalizeUiAckResult({ applied: false }).applied).toBe(false);
  });
  it('keeps a string detail, drops a non-string one', () => {
    expect(normalizeUiAckResult({ applied: true, detail: 'landed' }).detail).toBe('landed');
    expect(normalizeUiAckResult({ applied: true, detail: 42 }).detail).toBeUndefined();
  });
});

describe('HTTP app', () => {
  let server: Server;
  let base: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    const app = createApp({ env, iris, db });
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('healthz returns ok with the namespace', async () => {
    const res = await fetch(`${base}/healthz`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect((body as { namespace: string }).namespace).toBe('SC');
  });

  it('rejects an unauthenticated proxied IRIS path with 401 before it reaches IRIS', async () => {
    // /api/scdata/* is proxied to IRIS. The gate is mounted before the proxy, so
    // this 401s WITHOUT any IRIS round-trip — proving the proxy path is covered,
    // not just the local routes.
    const res = await fetch(`${base}/api/scdata/v1/carriers`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects an unauthenticated local route with 401', async () => {
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('allows a local route with the valid token', async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: authHeader });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token with 401', async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: { Authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('serves /config.json without a token and delivers the api token in it', async () => {
    const res = await fetch(`${base}/config.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { apiToken: string }).apiToken).toBe('test-token');
  });

  it('advertises aiEnabled:true in /config.json when Claude is configured', async () => {
    const body = await json(`${base}/config.json`);
    expect(body.aiEnabled).toBe(true);
    // The capability is a boolean — no credential value may ride along on this
    // UNAUTHENTICATED endpoint.
    expect(JSON.stringify(body)).not.toContain('test-bedrock-token');
  });

  it('creates and lists sessions', async () => {
    const created = await json(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ title: 'Test session' }),
    });
    expect(created.session.id).toBeTruthy();

    const list = await json(`${base}/api/sessions`, { headers: authHeader });
    expect(list.sessions.map((s: { id: string }) => s.id)).toContain(created.session.id);
  });

  it('deletes a session (and 404s when deleting an unknown one)', async () => {
    const created = await json(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ title: 'Delete me' }),
    });
    const del = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(del.status).toBe(200);
    // Gone from the list.
    const list = await json(`${base}/api/sessions`, { headers: authHeader });
    expect(list.sessions.map((s: { id: string }) => s.id)).not.toContain(created.session.id);
    // Deleting again → 404.
    const again = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(again.status).toBe(404);
  });

  it('rejects chat without a message', async () => {
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('confirm endpoint 409s when there is no active turn', async () => {
    const res = await fetch(`${base}/api/agent/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ sessionId: 'nope', confirmId: 'x', decision: 'approve' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('CONFLICT');
  });

  it('broker endpoints 400 on missing fields (VALIDATION envelope)', async () => {
    for (const path of ['/api/agent/confirm', '/api/agent/answer', '/api/agent/ui-ack']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({}),
      });
      expect(res.status, path).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('VALIDATION');
    }
  });

  it('answer + ui-ack endpoints 409 when there is no active turn', async () => {
    const answer = await fetch(`${base}/api/agent/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ sessionId: 'nope', askId: 'x', answers: {} }),
    });
    expect(answer.status).toBe(409);
    const ack = await fetch(`${base}/api/agent/ui-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ sessionId: 'nope', directiveId: 'x' }),
    });
    expect(ack.status).toBe(409);
  });

  it('GET a nonexistent session → 404 NOT_FOUND envelope', async () => {
    const res = await fetch(`${base}/api/sessions/does-not-exist`, { headers: authHeader });
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe('NOT_FOUND');
  });

  it('an unknown LOCAL /api path → 404 NOT_FOUND envelope (not the SPA index)', async () => {
    // A path under a local prefix (/api/agent) that no route matches falls
    // through to apiNotFound. (Unknown non-local /api/* paths are forwarded to
    // IRIS by the proxy instead — that's a different, intended behavior.)
    const res = await fetch(`${base}/api/agent/no-such-route`, { headers: authHeader });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('streams a chat turn as SSE and persists the assistant reply', async () => {
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toMatch(/event: token/);
    expect(text).toMatch(/event: result/);
    expect(text).toMatch(/Hi there\./);
    expect(text).toMatch(/event: done/);
  });

  it('emits an SSE error event when the agent turn throws (not aborted)', async () => {
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'boom please' }),
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toMatch(/event: error/);
    expect(text).toMatch(/agent exploded/);
    // The turn still ends cleanly (no hang): the stream closes.
    expect(text).not.toMatch(/event: done/);
  });

  it('reports a REFUSED credential in plain words, without the raw AWS text', async () => {
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'badkey please' }),
    });
    const text = await res.text();

    expect(text).toMatch(/event: error/);
    expect(text).toMatch(/Invalid credentials provided for Claude/);
    expect(text).toMatch(/restart the server/); // actionable, not just a verdict
    // The AWS message names an IAM ARN and an account id; neither belongs in a
    // chat bubble.
    expect(text).not.toMatch(/arn:aws|123456789012|security token/);
  });

  it('captures the SDK session id and resumes it on the follow-up turn', async () => {
    agentCalls.length = 0;
    // First turn — no resume, creates the session.
    const first = await json(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'first' }),
    }).catch(async () => {
      // chat returns SSE, not JSON; read the sessionId out of the stream instead.
      return null;
    });
    void first;
    // Re-fetch to read the created session id from the stream.
    const r1 = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'first' }),
    });
    const t1 = await r1.text();
    const sid = /"sessionId":"([^"]+)"/.exec(t1)?.[1];
    expect(sid).toBeTruthy();
    // First call had no resume; a later call for the same session must resume 'sdk-sess-123'.
    const r2 = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ sessionId: sid, message: 'second' }),
    });
    await r2.text();
    const secondCall = agentCalls[agentCalls.length - 1]!;
    expect(secondCall.resume).toBe('sdk-sess-123');
    // On resume we send the raw message (not a folded transcript), prefixed with
    // the ephemeral per-turn mode header (defaults to agent).
    expect(secondCall.prompt).toBe('[SESSION MODE: agent]\n\nsecond');
  });

  it('hands the agent an audit sink bound to THIS session', async () => {
    agentCalls.length = 0;
    const r = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'audit me' }),
    });
    const sid = /"sessionId":"([^"]+)"/.exec(await r.text())?.[1];

    // The gate can only fail closed if it is actually GIVEN a sink. Without this
    // the whole item can be removed from app.ts with the suite still green.
    const { audit } = agentCalls[agentCalls.length - 1]!.deps;
    expect(audit, 'createApp did not pass an audit sink to the agent').toBeDefined();

    // ...and it must write to this session's trail, not an unrelated one.
    audit!.record({ toolName: 'sco_build_cube', summary: 'Build cube C', input: {}, decision: 'approve' });
    expect(listToolAudit(db, sid!).map((e) => e.toolName)).toEqual(['sco_build_cube']);
  });
});

/**
 * An install with NO Claude credentials. The workbench itself is IRIS,
 * not Claude, so this must boot and serve everything — it just has to be honest
 * about the one feature it cannot offer, and cheap about saying so.
 */
describe('HTTP app — Claude unavailable', () => {
  let server: Server;
  let base: string;
  let db: ReturnType<typeof openDatabase>;
  /** Same env as above, minus every credential chain. */
  const noAiEnv = {
    SCO_NAMESPACE: 'SC',
    SCO_HOST: 'localhost',
    SCO_WEB_PORT: 52773,
    WORKBENCH_API_TOKEN: 'test-token',
    ANTHROPIC_MODEL: 'us.anthropic.claude',
    AWS_REGION: 'us-east-1',
  } as unknown as Env;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    const app = createApp({ env: noAiEnv, iris, db });
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('still boots and serves the app: /healthz and /config.json answer', async () => {
    // The whole point of the change — no credentials is no longer fatal.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/config.json`)).status).toBe(200);
  });

  it('advertises aiEnabled:false so the SPA can degrade before the first click', async () => {
    const body = await json(`${base}/config.json`);
    expect(body.aiEnabled).toBe(false);
    // Everything else is unaffected — this is a capability flag, not a kill switch.
    expect(body.apiToken).toBe('test-token');
    expect(body.namespace).toBe('SC');
  });

  it('answers a chat turn with "Claude key not provided" over SSE, spending nothing', async () => {
    agentCalls.length = 0;
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'hello' }),
    });

    // SSE, not the JSON error envelope: the client speaks SSE on this route, and a
    // 4xx body it cannot parse would surface as a generic network failure.
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toMatch(/event: error/);
    expect(text).toMatch(/Claude key not provided/);
    expect(text).not.toMatch(/event: done/);
    // No agent turn was started — no subprocess, no tokens.
    expect(agentCalls).toHaveLength(0);
  });

  it('creates no session for a turn it refused', async () => {
    await (await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ message: 'hello' }),
    })).text();

    // Nothing happened, so there is no history to keep — the chat list must not
    // fill up with empty sessions each time someone hits Send.
    const list = await json(`${base}/api/sessions`, { headers: authHeader });
    expect(list.sessions).toHaveLength(0);
  });

  it('still validates the request before reporting the missing key', async () => {
    // The missing key doesn't swallow the 400 contract: an empty message is still
    // a validation error, not a "Claude key not provided" SSE stream.
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('still requires the API token — the AI gate is not an auth bypass', async () => {
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(401);
  });
});

// The single-image deploy serves the built SPA statically. index.html names the
// content-hashed bundles, so it MUST NOT be cached: a stale cached index points
// at hashes a new build no longer has, the server returns the SPA fallback (HTML)
// for the missing `.js`, and the app never boots. Hashed assets, whose names
// change with their content, are safe to cache. (Learned live: a cached index
// made every route 404 after an in-place rebuild.)
describe('static SPA serving cache headers', () => {
  let server: Server;
  let base: string;
  let db: ReturnType<typeof openDatabase>;
  let frontendDir: string;

  beforeEach(async () => {
    frontendDir = mkdtempSync(join(tmpdir(), 'wb-spa-'));
    writeFileSync(join(frontendDir, 'index.html'), '<!doctype html><title>SPA</title><script src="main-ABC123.js"></script>');
    writeFileSync(join(frontendDir, 'main-ABC123.js'), 'console.log("app");');
    db = openDatabase(':memory:');
    const app = createApp({ env, iris, db, frontendDir });
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(frontendDir, { recursive: true, force: true });
  });

  it('serves index.html at / with Cache-Control: no-cache', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
  });

  it('serves the SPA fallback for a deep client route with no-cache (not a cached stale index)', async () => {
    const res = await fetch(`${base}/workbench`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
  });

  it('does NOT force no-cache on content-hashed assets (they may cache)', async () => {
    const res = await fetch(`${base}/main-ABC123.js`);
    expect(res.status).toBe(200);
    // The hashed bundle must not carry the index-only no-cache directive.
    expect(res.headers.get('cache-control') ?? '').not.toMatch(/no-cache/);
  });
});
