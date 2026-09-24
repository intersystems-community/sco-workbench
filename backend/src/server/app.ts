import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { aiConfigured, type Env } from '../config/env.js';
import type { IrisServices } from '../iris/index.js';
import { SessionRepository } from '../db/sessions.js';
import { createSqliteAuditSink } from '../db/audit.js';
import { ConfirmationBroker, type Decision } from './confirm.js';
import { QuestionBroker, type AskAnswers } from './question.js';
import { UiControlBroker, type UiAckResult } from './ui-control.js';
import { openSse, emitSdkMessage, newEmitContext } from './sse.js';
import { createIrisProxy } from './iris-proxy.js';
import { createAuthMiddleware, SharedSecretVerifier, resolveApiToken } from './auth.js';
import { createCubeRouter } from './cube-routes.js';
import { createPreflightRouter } from './preflight-routes.js';
import { CubeDraftRepository } from '../db/cube-drafts.js';
import { createKpiDraftRouter } from './kpi-draft-routes.js';
import { KpiDraftRepository } from '../db/kpi-drafts.js';
import { createDataBrowserRouter } from './data-browser-routes.js';
import { createDashboardRouter } from './dashboard-routes.js';
import { createIssueRouter } from './issue-routes.js';
import { DashboardRepository } from '../db/dashboards.js';
import { runAgentTurn } from '../agent/agent.js';
import { aiKeyMissingMessage, describeAiFailure } from '../agent/ai-errors.js';
import type { AssistantMode } from '../agent/system-prompt.js';
import { createConnectionTestRouter } from './connection-test-routes.js';
import { createIntrospectRouter } from './introspect-routes.js';
import { createAutoMapRouter } from './auto-map-routes.js';
import { createUploadRouter } from './upload-routes.js';
import { PendingUploadStore } from './upload-store.js';
import { createIntegrationCaseRouter } from './integration-case-routes.js';
import { IntegrationCaseRepository } from '../db/integration-cases.js';
import { createCredentialRouter } from './credential-routes.js';
import { createDriverJarRouter } from './driver-jar-routes.js';
import { createSampleDataRouter } from './sample-data-routes.js';
import { resolveSampleDataDir } from '../util/sample-data.js';
import { errorEnvelope, apiNotFound } from './error-middleware.js';
import { ValidationError, ConflictError, NotFoundError } from '../iris/iris-error.js';

export interface AppDeps {
  env: Env;
  iris: IrisServices;
  db: Database.Database;
  /** Absolute path to the built frontend (served statically) — optional in dev. */
  frontendDir?: string;
}

/**
 * Build the transcript prefix fed to the agent for a turn. For the MVP we fold
 * prior turns into the prompt (the SDK query is stateless per call here).
 */
function buildPrompt(repo: SessionRepository, sessionId: string, userMessage: string): string {
  const history = repo.getMessages(sessionId).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (history.length === 0) return userMessage;
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  return `Conversation so far:\n${transcript}\n\nUser: ${userMessage}`;
}

/**
 * Prepend an ephemeral per-turn header stating the active mode and current UI
 * state, so a mid-session mode switch takes effect and Guided mode knows where
 * the user is / what's filled. Ephemeral: not persisted, not in the system
 * prompt. The `[SESSION MODE]`/`[UI CONTEXT]` markers are stable labels the
 * mode personas reference.
 */
export function withTurnHeader(base: string, mode: AssistantMode, uiContext: string): string {
  const parts = [`[SESSION MODE: ${mode}]`];
  if (uiContext) parts.push(`[UI CONTEXT]\n${uiContext}`);
  parts.push(base);
  return parts.join('\n\n');
}

/**
 * Normalize a raw /ui-ack request body into a UiAckResult. A non-boolean
 * `applied` FAILS CLOSED (-> false): a malformed ack becomes a visible failure,
 * never a silent success. The real frontend always posts a boolean `applied`.
 */
export function normalizeUiAckResult(body: { applied?: unknown; detail?: unknown }): UiAckResult {
  return {
    applied: typeof body.applied === 'boolean' ? body.applied : false,
    detail: typeof body.detail === 'string' ? body.detail : undefined,
  };
}

export function createApp(deps: AppDeps): Express {
  const { env, iris, db } = deps;
  const repo = new SessionRepository(db);
  const app = express();

  const { token: apiToken, generated } = resolveApiToken(env);
  if (generated) {
    // No WORKBENCH_API_TOKEN configured — surface the ephemeral token once so a
    // non-browser (curl) caller on the trusted host can use it. Browsers get it
    // automatically from /config.json.
    // eslint-disable-next-line no-console
    console.log(`[auth] No WORKBENCH_API_TOKEN set; generated an ephemeral API token for this run: ${apiToken}`);
  }
  const verifier = new SharedSecretVerifier(apiToken);

  app.use(express.json({ limit: '2mb' }));

  // Deny-by-default auth on every /api/* request — the IRIS proxy AND our local
  // routes. Scoped to /api so the SPA shell, static assets, /healthz and
  // /config.json load without a token (the browser fetches the token from
  // /config.json, then authenticates its API calls). Mounted BEFORE the proxy so
  // an unauthenticated IRIS-bound call is refused before it can reach IRIS as the
  // configured service user.
  app.use('/api', createAuthMiddleware(verifier));

  // IRIS reverse-proxy. Mounted AFTER express.json(); it re-streams the parsed
  // body onto the proxied request (fixRequestBody) so POST/PUT bodies reach IRIS
  // intact. It only intercepts IRIS-bound /api/* calls (see pathFilter); our own
  // /api/agent, /api/sessions and /api/cubes routes fall through to the stack.
  app.use(createIrisProxy(env));

  // --- Frontend runtime config ---
  // The Angular app fetches this at startup (provideAppInitializer) to learn the
  // backend API origin, so one built bundle works same-origin or split-deployed
  // without a rebuild. Sourced from env.API_BASE_URL (empty = same origin).
  //
  // `aiEnabled` is the AI CAPABILITY: false when no Bedrock credentials
  // are configured, so the SPA can degrade up front — the chat composer says
  // "Claude key not provided" instead of accepting a message that can only fail,
  // and the AI-backed buttons explain themselves instead of spinning. It is a
  // presence check only; present-but-rejected credentials surface per call as the
  // "invalid credentials" message. No credential VALUE is exposed here, only the boolean.
  app.get('/config.json', (_req: Request, res: Response) => {
    res.json({
      apiBaseUrl: env.API_BASE_URL,
      namespace: env.SCO_NAMESPACE,
      apiToken,
      aiEnabled: aiConfigured(env),
    });
  });

  // --- Health ---
  app.get('/healthz', async (_req: Request, res: Response) => {
    const health: Record<string, unknown> = { ok: true, namespace: env.SCO_NAMESPACE };
    try {
      // Atelier reachability: reading a (probably absent) doc still round-trips auth.
      await iris.atelier.readClass('%Studio.Project').catch(() => undefined);
      health.atelier = 'reachable';
    } catch {
      health.atelier = 'unreachable';
    }
    res.json(health);
  });

  // --- Sessions ---
  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: repo.listSessions() });
  });
  app.post('/api/sessions', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title : 'New session';
    res.json({ session: repo.createSession(title) });
  });
  app.get('/api/sessions/:id', (req, res, next) => {
    const session = repo.getSession(req.params.id);
    if (!session) return next(new NotFoundError('Session not found'));
    return res.json({ session, messages: repo.getMessages(req.params.id) });
  });

  // --- Setup preflight: is SCO up, do the credentials work, is it new enough?
  //     The SPA blocks on this before rendering the Workbench, so it must stay
  //     cheap and dependency-free. Must also be listed in LOCAL_API_PREFIXES. ---
  app.use('/api/preflight', createPreflightRouter(env));

  // --- Cube CRUD (direct IRIS BI, no SCO API) ---
  app.use('/api/cubes', createCubeRouter(iris, new CubeDraftRepository(db)));

  // --- KPI drafts (local save-draft store; real KPI CRUD goes via the SCO
  //     proxy at /api/scbi/v1/kpi/definitions). ---
  app.use('/api/kpi-drafts', createKpiDraftRouter(new KpiDraftRepository(db), iris));

  // --- Read-only row counts for the Dashboard (SQL COUNT(*); scdata sends no
  //     total-count header). Must also be listed in LOCAL_API_PREFIXES. ---
  app.use('/api/data-browser', createDataBrowserRouter(iris));

  // --- Dashboard (D2 + Track A): cube-shape + chart-data + chart-spec (stateless
  //     charting), plus GET/PUT /layout persisting the saved dashboard via
  //     DashboardRepository. Local; must also be listed in LOCAL_API_PREFIXES. ---
  app.use('/api/dashboard', createDashboardRouter(iris, env, new DashboardRepository(db)));

  // --- Issue Management page: category list + nav counts + one issue's detail.
  //     Reads SCO's issue API server-side (it is paged; the browser cannot filter
  //     the full set). Must also be listed in LOCAL_API_PREFIXES. ---
  app.use('/api/issues', createIssueRouter(iris));

  // The DI case repository is shared by the persistence router below AND by the
  // Test Connection / introspection routers, which read a reopened case's persisted
  // secret (password / SFTP key / cloud credentials file) so the user need not
  // re-enter what they already saved. Created here so it precedes all three.
  const integrationCases = new IntegrationCaseRepository(db);

  // --- Data Integration: Test Connection (per source adapter) ---
  // One router, one subpath per adapter (sql/ftp/sftp/cloud). Excluded from the
  // IRIS proxy via LOCAL_API_PREFIXES in iris-proxy.ts so it reaches Express.
  app.use('/api/data-integration/test-connection', createConnectionTestRouter(integrationCases));

  // --- Data Integration: source introspection (schemas → tables → columns) ---
  // Reads a connected source's structure so the Data Entity step populates its
  // pickers from the real server. Same /api/data-integration prefix (proxy-excluded).
  app.use('/api/data-integration/introspect', createIntrospectRouter(undefined, integrationCases));

  // --- Data Integration: AI-suggested field mapping (Mapping step) ---
  // One-shot LLM call that suggests source→target property pairings. Same
  // /api/data-integration prefix (proxy-excluded).
  app.use('/api/data-integration/auto-map', createAutoMapRouter(env));

  // --- Data Integration: case persistence + file uploads ---
  // The case repository durably stores each DI case (passwords encrypted) and the
  // bytes of its uploaded files; the shared upload store holds freshly-uploaded
  // bytes in memory until they are copied into SQLite at step-save. The uploads
  // router streams files into the user's IRIS container at Deploy, sourcing bytes
  // from the in-memory store when fresh or from the durable SQLite copy after a
  // refresh/restart. Same /api/data-integration prefix (proxy-excluded).
  const uploadStore = new PendingUploadStore();
  app.use('/api/data-integration/cases', createIntegrationCaseRouter(integrationCases, uploadStore));
  app.use('/api/data-integration/uploads', createUploadRouter(iris, env, uploadStore, integrationCases));

  // --- Data Integration: create the IRIS credential entry a pipeline references ---
  // Generated name (from the workbench) + user's username/password → upserted into
  // IRIS over the Native SDK, so the secret never enters the agent prompt. The
  // `/from-case/:id` route (Deploy) reads the DECRYPTED password from the case
  // store, since a restored case only holds a redacted password in the browser.
  app.use('/api/data-integration/credentials', createCredentialRouter(iris, integrationCases));

  // --- Data Integration: stage a non-IRIS SQL driver JAR into the IRIS container ---
  // For a PostgreSQL (etc.) source, push its JDBC driver JAR into IRIS at Deploy so
  // the Java Gateway can load it, and return the in-container path the deployed
  // GenericService uses as JDBCClasspath. IRIS needs nothing staged. Same
  // /api/data-integration prefix (proxy-excluded).
  app.use('/api/data-integration/driver-jar', createDriverJarRouter(iris, env));

  // --- Sample data sets: the "Load sample data" page's listing and its load ---
  // Reads the SampleData directory (SAMPLE_DATA_DIR, else the repo's own folder) and
  // adds a set's CSVs to the SCO data model's own SC_Data tables. The load stages each
  // CSV inside the IRIS container (Native SDK) so IRIS's LOAD DATA can read it, then
  // deletes it. Local; must also be listed in LOCAL_API_PREFIXES.
  app.use(
    '/api/sample-data',
    createSampleDataRouter(resolveSampleDataDir(env), {
      sql: iris.atelier,
      native: iris.native,
      stageDir: env.SCO_UPLOAD_CSV_DIR,
    }),
  );

  // --- Confirmation + question registries (per-session, kept for a turn) ---
  const brokers = new Map<string, ConfirmationBroker>();
  const questionBrokers = new Map<string, QuestionBroker>();
  const uiBrokers = new Map<string, UiControlBroker>();
  // AbortController per active turn, so a cancelled question can stop the turn.
  const turnAborts = new Map<string, AbortController>();

  // Delete a chat session and its messages. Aborts any in-flight turn for it
  // first, and tears down its brokers, so nothing keeps referencing a gone session.
  app.delete('/api/sessions/:id', (req, res, next) => {
    const id = req.params.id;
    if (!repo.getSession(id)) return next(new NotFoundError('Session not found'));
    // Stop a running turn and clean up its per-session channels.
    turnAborts.get(id)?.abort();
    brokers.get(id)?.rejectAll();
    questionBrokers.get(id)?.cancelAll();
    uiBrokers.get(id)?.ackAll();
    turnAborts.delete(id);
    brokers.delete(id);
    questionBrokers.delete(id);
    uiBrokers.delete(id);
    repo.deleteSession(id);
    return res.json({ ok: true });
  });

  // Frontend acks a Guided-mode UI directive once it's applied, unblocking the
  // agent so the next step (or the summary) runs only after the UI caught up.
  app.post('/api/agent/ui-ack', (req, res, next) => {
    const { sessionId, directiveId } = req.body ?? {};
    if (typeof sessionId !== 'string' || typeof directiveId !== 'string') {
      return next(new ValidationError('sessionId and directiveId are required.'));
    }
    const ub = uiBrokers.get(sessionId);
    if (!ub) return next(new ConflictError('No active turn awaiting a UI ack.'));
    // Pass the frontend's result through so `ui_set_field` can report whether the
    // value actually landed (a select/checkbox value that matched no option did not).
    // A malformed payload fails closed (see normalizeUiAckResult).
    const result = normalizeUiAckResult(req.body ?? {});
    const resolved = ub.ack(directiveId, result);
    return resolved ? res.json({ ok: true }) : next(new NotFoundError('Unknown directiveId.'));
  });

  app.post('/api/agent/confirm', (req, res, next) => {
    const { sessionId, confirmId, decision } = req.body ?? {};
    if (typeof sessionId !== 'string' || typeof confirmId !== 'string') {
      return next(new ValidationError('sessionId and confirmId are required.'));
    }
    const broker = brokers.get(sessionId);
    if (!broker) return next(new ConflictError('No active turn awaiting confirmation.'));
    const d: Decision = decision === 'approve' ? 'approve' : 'reject';
    const resolved = broker.resolveDecision(confirmId, d);
    return resolved ? res.json({ ok: true }) : next(new NotFoundError('Unknown confirmId.'));
  });

  // Resolve an `ask_user_question` prompt with the user's tabbed-popup answers,
  // or cancel it (`cancel: true`) — dismissing the popup stops the whole turn.
  app.post('/api/agent/answer', (req, res, next) => {
    const { sessionId, askId, answers, cancel } = req.body ?? {};
    if (typeof sessionId !== 'string' || typeof askId !== 'string') {
      return next(new ValidationError('sessionId and askId are required.'));
    }
    const qb = questionBrokers.get(sessionId);
    if (!qb) return next(new ConflictError('No active turn awaiting an answer.'));

    if (cancel === true) {
      const cancelled = qb.cancel(askId);
      // Abort the turn so the agent stops instead of hanging on the unanswered
      // tool call; the SDK query unwinds and the chat handler reports it.
      turnAborts.get(sessionId)?.abort();
      return cancelled ? res.json({ ok: true }) : next(new NotFoundError('Unknown askId.'));
    }

    if (typeof answers !== 'object' || !answers) {
      return next(new ValidationError('answers (or cancel:true) is required.'));
    }
    const resolved = qb.resolveAnswers(askId, answers as AskAnswers);
    return resolved ? res.json({ ok: true }) : next(new NotFoundError('Unknown askId.'));
  });

  // --- Chat (SSE) ---
  app.post('/api/agent/chat', async (req, res, next) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return next(new ValidationError('message is required.'));

    // No credentials configured: answer over SSE (the client speaks SSE here, not
    // the JSON error envelope) and spend nothing. Reported as a turn error so the
    // panel renders it in the transcript like any other failed turn. No session is
    // created or persisted — nothing happened, so there is no history to keep.
    if (!aiConfigured(env)) {
      const sse = openSse(res);
      sse.send('error', { message: aiKeyMissingMessage(env) });
      sse.close();
      return undefined;
    }

    // Operating mode ('agent' | 'guided') and the compact UI-state block, both
    // sent per turn by the frontend. Mode defaults to 'agent' (legacy behavior).
    const mode: AssistantMode = req.body?.mode === 'guided' ? 'guided' : 'agent';
    const uiContext = typeof req.body?.uiContext === 'string' ? req.body.uiContext.trim() : '';
    // Optional short label the UI shows for this user turn instead of the full
    // prompt (e.g. a Deploy's friendly one-liner). Persisted for history rendering
    // only; the agent still receives the full `message`.
    const displayText = typeof req.body?.displayText === 'string' ? req.body.displayText.trim() : '';

    // Resolve or create the session.
    let sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    if (!sessionId || !repo.getSession(sessionId)) {
      sessionId = repo.createSession(message.slice(0, 60)).id;
    }

    const sse = openSse(res);
    const broker = new ConfirmationBroker((request) => sse.send('confirm_request', { sessionId, ...request }));
    brokers.set(sessionId, broker);
    const questions = new QuestionBroker((request) => sse.send('ask_request', { sessionId, ...request }));
    questionBrokers.set(sessionId, questions);
    // Guided-mode UI-directive channel: emits `ui_directive` SSE events the
    // frontend applies to the live workbench (navigate / open form / set field /
    // highlight). BLOCKS until the frontend acks (POST /api/agent/ui-ack), so the
    // agent's next step runs only after the UI actually caught up.
    const ui = new UiControlBroker((request) => sse.send('ui_directive', { sessionId, ...request }));
    uiBrokers.set(sessionId, ui);
    const abortController = new AbortController();
    turnAborts.set(sessionId, abortController);

    // Only a real mid-turn client disconnect should abort. We watch the SSE
    // RESPONSE stream, not the request: `req`'s 'close' fires as soon as the
    // POST body is read (i.e. immediately), which would abort every turn on
    // send. `res` 'close' fires when the connection actually drops — but it
    // also fires on our own normal `sse.close()`, so guard with `turnDone`.
    let turnDone = false;
    res.on('close', () => {
      if (turnDone) return; // normal end of turn — not a disconnect
      broker.rejectAll();
      questions.cancelAll();
      ui.ackAll();
      abortController.abort();
    });

    repo.appendMessage(sessionId, {
      role: 'user',
      content: message,
      // Store the friendly label only when it actually differs from the prompt.
      displayText: displayText && displayText !== message ? displayText : null,
    });
    sse.send('session', { sessionId });

    // Resume the prior SDK session if this chat session already has one, so the
    // agent keeps full context (loaded skills, prior tool results) instead of
    // starting over. We do NOT replay history into the prompt when resuming.
    const existing = repo.getSession(sessionId);
    const resumeId = existing?.sdkSessionId ?? undefined;
    const baseText = resumeId ? message : buildPrompt(repo, sessionId, message);
    // Prepend an EPHEMERAL per-turn header telling the model the active mode and
    // the current UI state. This is NOT persisted (only the raw message is) and
    // is NOT in the system prompt (which stays byte-stable per mode for caching);
    // re-stating the mode each turn is what makes a mid-session switch take hold.
    const prompt = withTurnHeader(baseText, mode, uiContext);

    // Scoped to THIS session, so the tool layer never has to know about
    // sessions. Every state-changing tool call is recorded through it before the
    // action runs; if the write fails the action is refused (see tools/gate.ts).
    const audit = createSqliteAuditSink(db, sessionId);

    let finalText: string | undefined;
    const emitCtx = newEmitContext();
    try {
      for await (const sdkMessage of runAgentTurn({ env, iris, broker, questions, ui, mode, audit }, prompt, resumeId, abortController)) {
        // Capture the SDK session id (present on every message) the first time
        // we see it, so subsequent turns resume this conversation.
        const sid = (sdkMessage as { session_id?: string }).session_id;
        if (sid && !repo.getSession(sessionId)?.sdkSessionId) {
          repo.setSdkSessionId(sessionId, sid);
        }
        const text = emitSdkMessage(sse, sdkMessage, emitCtx);
        if (text !== undefined) finalText = text;
      }
      // Persist the full turn timeline (prose + tool steps + summary) so a page
      // refresh can replay it — not just the final summary text.
      if (emitCtx.events.length) {
        repo.appendMessage(sessionId, {
          role: 'assistant',
          content: finalText ?? '',
          toolCalls: emitCtx.events,
        });
      }
      sse.send('done', { sessionId });
    } catch (err) {
      // An aborted turn (user dismissed a question, hit Stop, or disconnected)
      // is expected — report it as a clean stop, not an error.
      if (abortController.signal.aborted) {
        // Persist whatever timeline we accumulated before the stop.
        if (emitCtx.events.length) {
          repo.appendMessage(sessionId, { role: 'assistant', content: finalText ?? '', toolCalls: emitCtx.events });
        }
        sse.send('stopped', { sessionId });
      } else {
        // Credentials that Bedrock REFUSES get the actionable "invalid credentials"
        // explanation rather than the raw AWS text (which names accounts/ARNs and
        // reads as noise in a chat bubble). Every other failure keeps its own message
        // — a throttle or a network drop must not be mistaken for a bad key.
        sse.send('error', { message: describeAiFailure(env, err) });
      }
    } finally {
      turnDone = true; // mark before closing so res 'close' isn't seen as a disconnect
      brokers.delete(sessionId);
      broker.rejectAll();
      questionBrokers.delete(sessionId);
      questions.cancelAll();
      uiBrokers.delete(sessionId);
      ui.ackAll();
      turnAborts.delete(sessionId);
      sse.close();
    }
    return undefined;
  });

  // Unknown /api/* paths return the JSON error envelope (not the SPA index).
  // Mounted before the static handler so it only claims API routes.
  app.use(apiNotFound());

  // --- Static frontend (production single-image) ---
  if (deps.frontendDir && existsSync(deps.frontendDir)) {
    // index.html must NOT be cached: it is the entry point that names the
    // content-hashed bundles, so a stale cached copy points at hashes that no
    // longer exist after a new build — the server then returns the SPA fallback
    // (HTML) for the missing `.js`, the app fails to boot, and every route 404s.
    // The hashed assets themselves are safe to cache forever (their name changes
    // when their content does), so scope no-cache to index.html only.
    const noCacheIndex = (res: Response, filePath: string): void => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    };
    app.use(express.static(deps.frontendDir, { setHeaders: noCacheIndex }));
    app.get(/^(?!\/api|\/healthz).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: deps.frontendDir });
    });
  }

  // Single error handler for the backend-owned routes: serializes a typed
  // IrisError into the { error, code, ...details } envelope. Mounted LAST so it
  // catches anything the routers forward via next(err). Does not touch proxied
  // SCO responses (those never throw into Express).
  app.use(errorEnvelope(env.NODE_ENV === 'production'));

  return app;
}
