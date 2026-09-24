import { createProxyMiddleware, fixRequestBody, type Options } from 'http-proxy-middleware';
import type { RequestHandler } from 'express';
import type { Env } from '../config/env.js';

/**
 * Authenticating reverse-proxy for the IRIS REST APIs the Angular workbench
 * consumes directly (scdata / scmodel / scsam / scbi / deepsee, etc.).
 *
 * The browser only ever talks to *our* backend; this middleware forwards the
 * IRIS-bound `/api/*` calls to the user-managed IRIS web port, injecting the
 * HTTP Basic credentials server-side so they never reach the client. This
 * replaces what the Angular app's dev `proxy.conf.js` / prod `nginx.conf`
 * used to do — now folded into the single Node process that also hosts the
 * agent, so there's one origin, one config source (`.env`), and one auth model.
 *
 * Path handling mirrors the app's original dev proxy exactly:
 *   - `/api/deepsee/...`  → passed through unchanged (already namespaced inside IRIS).
 *   - every other `/api/...` → rewritten to `/api/{namespace}/...`, where the
 *     namespace comes from `SCO_NAMESPACE` (NOT a hardcoded "SC").
 *
 * Our own endpoints (`/api/agent`, `/api/sessions`, `/api/cubes`,
 * `/api/kpi-drafts`) and `/healthz` are excluded via `pathFilter`, so the proxy
 * calls `next()` for them and the request continues to the normal Express stack.
 *
 * Mounted AFTER `express.json()`: the body parser consumes the request stream,
 * so we re-stream the parsed JSON onto the proxied request via `fixRequestBody`
 * in `proxyReq` (otherwise proxied POST/PUT bodies reach IRIS empty). GET/DELETE
 * have no body and are unaffected.
 */

/** Response headers IRIS uses for pagination; expose them to the browser. */
const EXPOSE_HEADERS = 'totalcount,returncount,pageindex,pagesize,orderby';

/** Our own API namespaces, which must NOT be proxied to IRIS. */
const LOCAL_API_PREFIXES = ['/api/agent', '/api/sessions', '/api/cubes', '/api/kpi-drafts', '/api/data-browser', '/api/data-integration', '/api/dashboard', '/api/issues', '/api/sample-data', '/api/preflight'] as const;

/** Node socket error codes that mean a timeout rather than a hard refusal. */
const TIMEOUT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

export function createIrisProxy(env: Env): RequestHandler {
  const target = `http://${env.SCO_HOST}:${env.SCO_WEB_PORT}`;
  const authHeader = 'Basic ' + Buffer.from(`${env.SCO_USER}:${env.SCO_PASSWORD}`).toString('base64');
  // The SQL/REST APIs live under /api/{namespace}; the namespace is configurable.
  const nsPrefix = `/api/${env.SCO_NAMESPACE}`;
  // Optional web-app path prefix in front of the whole /api tree (blank if none).
  const webPrefix = env.SCO_WEB_PREFIX ? `/${env.SCO_WEB_PREFIX.replace(/^\/+|\/+$/g, '')}` : '';

  const options: Options = {
    target,
    changeOrigin: true,
    // Upstream response timeout: if IRIS accepts the socket but never responds,
    // fail fast with a 504 envelope instead of hanging the browser request.
    proxyTimeout: env.SCO_PROXY_TIMEOUT_MS,
    // Proxy only IRIS-bound API calls; leave our own routes and everything else
    // for the rest of the Express stack (the middleware calls next() on no-match).
    pathFilter: (path: string) =>
      path.startsWith('/api/') && !LOCAL_API_PREFIXES.some((p) => path.startsWith(p)),
    pathRewrite: (path: string) => {
      const rewritten = path.startsWith('/api/deepsee')
        ? path // deepsee endpoints are already namespaced inside SCO
        : path.replace(/^\/api/, nsPrefix);
      return `${webPrefix}${rewritten}`;
    },
    on: {
      proxyReq: (proxyReq, req, res) => {
        // Inject IRIS credentials server-side; the browser never sees them.
        proxyReq.setHeader('Authorization', authHeader);
        // Re-stream the JSON body that express.json() already consumed. Without
        // this, proxied POST/PUT bodies arrive empty at IRIS ("Invalid JSON
        // input"). fixRequestBody rewrites body + content-length onto proxyReq.
        fixRequestBody(proxyReq, req as Parameters<typeof fixRequestBody>[1]);
        void res;
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers['access-control-expose-headers'] = EXPOSE_HEADERS;
      },
      error: (err, _req, res) => {
        // `res` is the ServerResponse for HTTP requests. Surface a clean error
        // envelope rather than letting the socket hang when IRIS is unreachable
        // or slow. Shape matches the backend routes' envelope ({ error, code }).
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        const timedOut = code !== undefined && TIMEOUT_CODES.has(code);
        const status = timedOut ? 504 : 502;
        const errorCode = timedOut ? 'SCO_TIMEOUT' : 'SCO_UNREACHABLE';
        if ('headersSent' in res && !res.headersSent && 'writeHead' in res) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `SCO proxy failed: ${message}`, code: errorCode }));
        }
      },
    },
  };

  return createProxyMiddleware(options) as unknown as RequestHandler;
}
