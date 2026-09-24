/**
 * Boot the real Express app against a live IRIS, on an ephemeral port, backed by
 * an in-memory SQLite DB. Every integration suite uses this so it exercises the
 * true frontend→backend→IRIS path (auth gate, proxy, routers) rather than a
 * mock. Reuses the production composition roots (`createIrisServices`,
 * `createApp`) unchanged.
 *
 * Auth (SC-2603): the backend denies `/api/*` without a bearer token. Rather than
 * thread a header through every call site, `bootApp` pins a known token and
 * installs a scoped `fetch` wrapper that injects `Authorization: Bearer <token>`
 * for requests to THIS app's base URL only — mirroring what the SPA does (it
 * reads the token from /config.json and attaches it to every API call). IRIS-
 * direct client calls (different host) and other apps are untouched. The wrapper
 * is removed on `close()`.
 */
import { loadEnv } from '../../../src/config/env.js';
import { createIrisServices, type IrisServices } from '../../../src/iris/index.js';
import { createApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/db/sqlite.js';
import { ConfirmationBroker } from '../../../src/server/confirm.js';
import { QuestionBroker, type AskAnswers } from '../../../src/server/question.js';
import { UiControlBroker } from '../../../src/server/ui-control.js';
import type { AgentDeps } from '../../../src/agent/agent.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** A fixed token for the test run so requests are deterministic. */
const TEST_API_TOKEN = 'workbench-it-token';

export interface BootedApp {
  base: string;
  token: string;
  iris: IrisServices;
  db: ReturnType<typeof openDatabase>;
  server: Server;
  /**
   * Assemble `AgentDeps` for a headless live-agent turn (no SSE/UI attached).
   * The confirmation broker never prompts; the UI broker acks so the guided
   * `ui_*` directive tools resolve instead of hanging (the confirm.test.ts:313
   * pattern); the question broker AUTO-ANSWERS each question with its first
   * option so a clarifying question the live agent legitimately asks (e.g. "which
   * KPI?") does not deadlock the headless turn — mirroring a user who takes the
   * default. Test-only helper; no production change.
   *
   * `uiSetFieldGate` makes the headless UI broker FAITHFUL for `set_field`
   * instead of a blind yes-man: it is consulted for every `ui_set_field`
   * directive and its verdict becomes the ack. Return `null` to accept (the
   * default — real free-text fields like `kpiConditions.N` land as typed), or an
   * explicit `{applied:false, detail}` to reject — exactly what the real Angular
   * bridge does when a dropdown-backed field (e.g. `dimensions.N.cubeDimension`)
   * gets a value the cube does not expose (kpi.ts:600). Without this the broker
   * would ack `applied:true` for a non-exposed member, feeding the agent a false
   * success the real UI would never give.
   */
  agentDeps(opts?: {
    mode?: 'agent' | 'guided';
    uiSetFieldGate?: (path: string, value: unknown) => { applied: boolean; detail?: string } | null;
  }): AgentDeps;
  close(): Promise<void>;
}

/**
 * Boot the app + IRIS services + in-memory DB. Call `close()` in afterAll.
 *
 * `envOverrides` patches the loaded env for THIS app only — used by the sample-data
 * suite to point `SAMPLE_DATA_DIR` at a temp fixture folder, so it loads a handful of
 * known CSVs instead of whatever happens to sit in the repo's `SampleData/`.
 */
export function bootApp(envOverrides: Partial<ReturnType<typeof loadEnv>> = {}): BootedApp {
  // Pin the API token for this app so we can authenticate its /api/* calls.
  const env = { ...loadEnv(), WORKBENCH_API_TOKEN: TEST_API_TOKEN, ...envOverrides };
  const iris = createIrisServices(env);
  const db = openDatabase(':memory:');
  const app = createApp({ env, iris, db });
  const server = app.listen(0);
  // Node closes an idle keep-alive socket after 5s (`server.keepAliveTimeout`
  // default), while undici keeps it pooled — so the first request after a long
  // gap (a cleanup POST after polling a pipeline for a minute) can lose the race
  // and fail with ECONNRESET, which undici does not retry for a POST. 0 disables
  // the idle close; Node 19+ still drops idle sockets on `server.close()`.
  server.keepAliveTimeout = 0;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Install a scoped fetch wrapper: inject the bearer token for calls to `base`.
  const realFetch = globalThis.fetch;
  const wrapped: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith(base)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${TEST_API_TOKEN}`);
      return realFetch(input, { ...init, headers });
    }
    return realFetch(input, init);
  };
  globalThis.fetch = wrapped;

  return {
    base,
    token: TEST_API_TOKEN,
    iris,
    db,
    server,
    agentDeps: (opts?: {
      mode?: 'agent' | 'guided';
      uiSetFieldGate?: (path: string, value: unknown) => { applied: boolean; detail?: string } | null;
    }): AgentDeps => ({
      env,
      iris,
      // Headless brokers: confirmation/question never prompt (no UI attached); the
      // UI broker acks so the guided ui_* directive tools resolve instead of
      // hanging — the exact pattern confirm.test.ts:313 uses.
      broker: new ConfirmationBroker(() => {}),
      // Auto-answer each question with its first option (or "" free text when a
      // question ships no options) so a headless guided turn that legitimately
      // asks "which KPI?" resolves instead of hanging — a stand-in for the user
      // taking the default. Without this the turn stalls on the unanswered ask.
      questions: (() => {
        const q: QuestionBroker = new QuestionBroker((req) =>
          queueMicrotask(() => {
            const answers: AskAnswers = {};
            for (const question of req.questions) {
              const first = question.options[0]?.label;
              answers[question.header] = first ? { selected: [first] } : { selected: [], other: '' };
            }
            q.resolveAnswers(req.askId, answers);
          }),
        );
        return q;
      })(),
      ui: (() => {
        // Faithful ack: a `set_field` directive is judged by the caller's gate
        // (mirroring the Angular bridge's dropdown validation); everything else
        // (navigate/open_form/highlight) acks applied:true. A gate returning null
        // means "accept" (real free-text fields land as typed).
        const gate = opts?.uiSetFieldGate;
        const u = new UiControlBroker((req) =>
          queueMicrotask(() => {
            if (req.action === 'set_field' && gate) {
              const verdict = gate(req.target, (req as { value?: unknown }).value);
              u.ack(req.directiveId, verdict ?? { applied: true });
              return;
            }
            u.ack(req.directiveId, { applied: true });
          }),
        );
        return u;
      })(),
      mode: opts?.mode ?? 'agent',
    }),
    close: () =>
      new Promise<void>((resolve) => {
        // Restore the real fetch only if ours is still installed (nested boots
        // are not expected — suites run sequentially).
        if (globalThis.fetch === wrapped) globalThis.fetch = realFetch;
        server.close(() => {
          db.close();
          iris.close();
          resolve();
        });
      }),
  };
}

/** Read a JSON body, tolerating a non-JSON body (returns the raw text under `_raw`). */
export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { _raw: text } as unknown as T;
  }
}
