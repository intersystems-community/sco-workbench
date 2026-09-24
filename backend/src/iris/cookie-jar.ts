/**
 * Process-wide store for the IRIS CSP session cookie, used by `irisFetch`.
 *
 * Why this exists: `%Api.Atelier` does not end its CSP session, and the
 * `/api/atelier` web application has a 3600s timeout. Node's `fetch` keeps no
 * cookie jar, so every cookieless Atelier request opened a *new* session, and
 * each open session holds one IRIS license connection. Connections are capped
 * per `user@clientIP`, so a few dozen Atelier calls exhausted the bucket and
 * every password-authenticated `/api/*` route began failing with
 * `ERROR #5915: Unable to allocate a license`. Replaying the session cookie
 * keeps the whole process on one session instead of one per request.
 *
 * Deliberately narrower than RFC 6265: cookies are scoped to the exact request
 * origin (`Domain` is never parsed or honored) and only `CSP`-prefixed names are
 * stored. The worst case is failing to send a cookie we could have, which just
 * degrades to the old behaviour — it can never send a cookie somewhere it
 * doesn't belong. Expiry is not parsed either: IRIS answers a stale or unknown
 * session id with a 200 plus a fresh `Set-Cookie`, so overwriting on every
 * response already covers it.
 *
 * Two assumptions worth knowing:
 *  - All IRIS clients are built from one fixed `env.SCO_USER`/`SCO_PASSWORD`
 *    (see `iris/index.ts`), so a single shared session per application is
 *    correct. If the backend ever authenticates to IRIS as the end user, this
 *    store would need to be keyed on the credential too, or one user's request
 *    could join another's authenticated session.
 *  - Requests sharing the session are not isolated from each other. Atelier is
 *    stateless per request, so this is fine today.
 *
 * Never log cookie values — a CSP session id is enough to hijack the session.
 */

interface StoredCookie {
  value: string;
  /** Cookie path; a request path must be at or below this to match. */
  path: string;
}

/** origin -> cookie name -> cookie. Keying by name gives newest-value-wins. */
const jar = new Map<string, Map<string, StoredCookie>>();

/** Only IRIS session cookies are stored (CSPSESSIONID-…, CSPWSERVERID). */
const CSP_NAME = /^csp/i;

/** Parse a URL into the pieces the jar keys on, or undefined if unusable. */
function locate(url: string): { origin: string; path: string } | undefined {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname };
  } catch {
    return undefined;
  }
}

/** RFC 6265 §5.1.4 default-path: the request path up to its last `/`. */
function defaultPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** RFC 6265 §5.1.4 path-match: equal, a prefix ending in `/`, or a `/` boundary. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Record every CSP cookie a response set, overwriting any previous value. */
export function rememberSetCookies(res: Response, url: string): void {
  // Unit tests stub `fetch` with object literals that have no `headers`, and
  // `getSetCookie` is what parses multi-valued set-cookie correctly (Node 18.14+).
  if (typeof res?.headers?.getSetCookie !== 'function') return;
  const raw = res.headers.getSetCookie();
  if (!raw.length) return;
  const at = locate(url);
  if (!at) return;

  for (const header of raw) {
    const semi = header.indexOf(';');
    const pair = semi === -1 ? header : header.slice(0, semi);
    const attrs = semi === -1 ? [] : header.slice(semi + 1).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // An empty value is a deletion; drop the cookie rather than echoing it back.
    if (!CSP_NAME.test(name) || !value) continue;

    let path = defaultPath(at.path);
    for (const attr of attrs) {
      const sep = attr.indexOf('=');
      if (sep === -1) continue;
      if (attr.slice(0, sep).trim().toLowerCase() !== 'path') continue;
      const declared = attr.slice(sep + 1).trim();
      if (declared.startsWith('/')) path = declared;
    }

    let byName = jar.get(at.origin);
    if (!byName) jar.set(at.origin, (byName = new Map()));
    byName.set(name, { value, path });
  }
}

/**
 * Add the stored cookies that apply to `url`. Returns `init` unchanged (by
 * identity) when there is nothing to send, so the no-cookie path is exactly what
 * it was before. A `Cookie` header the caller set always wins.
 */
export function withStoredCookies(init: RequestInit, url: string): RequestInit {
  const at = locate(url);
  const byName = at ? jar.get(at.origin) : undefined;
  if (!at || !byName?.size) return init;

  const send: string[] = [];
  for (const [name, cookie] of byName) {
    if (pathMatches(cookie.path, at.path)) send.push(`${name}=${cookie.value}`);
  }
  if (!send.length) return init;
  const cookie = send.join('; ');

  const headers = init.headers;
  // The clients all pass a plain object; preserve that shape rather than
  // normalizing to `Headers`, which would change what callers/tests observe.
  if (headers instanceof Headers || Array.isArray(headers)) {
    const merged = new Headers(headers);
    if (merged.has('cookie')) return init;
    merged.set('cookie', cookie);
    return { ...init, headers: merged };
  }
  if (headers && Object.keys(headers).some((k) => /^cookie$/i.test(k))) return init;
  return { ...init, headers: { ...headers, Cookie: cookie } };
}

/** Drop every stored cookie. For tests, so cases can't leak into each other. */
export function resetCookieJar(): void {
  jar.clear();
}
