// backend/src/server/preflight-routes.ts
import { Router, type Request, type Response } from 'express';
import type { Env } from '../config/env.js';
import { checkScoPreflight, type PreflightResult } from '../iris/sco-preflight.js';

/**
 * `GET /api/preflight` — the setup healthcheck the SPA gates on before it renders
 * the Workbench. Confirms, in one upstream probe (see iris/sco-preflight.ts):
 *   1. an SCO instance is up at the configured host/port,
 *   2. the configured credentials authenticate against it, and
 *   3. its version is at least SCO_MIN_VERSION.
 *
 * MUST be in LOCAL_API_PREFIXES (iris-proxy.ts) or the proxy forwards it to SCO and
 * it 404s.
 *
 * **Answers 200 even when the check FAILS.** The HTTP status reports whether the
 * diagnosis was produced, not what it says — a blocked verdict is a successful
 * diagnosis, and the body is the part the UI needs. Returning 503 would force the
 * SPA to read its verdict out of an error handler, where a genuine transport failure
 * and "SCO is down" become indistinguishable. `ok` in the body is the single gate.
 *
 * Never cached: a user who starts their container and presses Retry must get the new
 * answer, not the one from before they fixed it.
 */
export function createPreflightRouter(env: Env): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    const result = await runPreflight(env);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  return router;
}

/**
 * Run the preflight against the configured instance.
 *
 * Only the CONNECTION details come from env — they describe this deployment. The
 * minimum version and the probe timeout do not: they are build constants in
 * iris/sco-preflight.ts, because they state what this Workbench build requires, and
 * an operator lowering the minimum would not conjure the missing SCO endpoints, only
 * trade one clear startup message for a scatter of broken pages.
 */
export function runPreflight(env: Env): Promise<PreflightResult> {
  return checkScoPreflight({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
  });
}
