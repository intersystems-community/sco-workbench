import { environment } from '../../environments/environment';

/**
 * The backend API origin the frontend prepends to every API call. Resolved at
 * RUNTIME from `/config.json` (see app-config.ts) so one built image can be
 * deployed same-origin or with a separate backend without rebuilding. Until the
 * runtime config loads, it falls back to the compile-time `environment` value
 * (default '' = same origin).
 *
 * It is intentionally mutable module state: `setApiBaseUrl()` is called once,
 * during app bootstrap, before any component or service issues a request.
 */
let apiBaseUrl = environment.apiBaseUrl;

/** Set the API base origin. Called once at startup from the config loader. */
export function setApiBaseUrl(value: string | undefined | null): void {
  apiBaseUrl = value ?? '';
}

/**
 * The IRIS namespace, sourced from the backend's SCO_NAMESPACE env via
 * /config.json. Used where a stored artifact records its namespace (e.g. a KPI's
 * deepseeKpiSpec.namespace, a cube's namespace) so the UI need not ask for it.
 * Defaults to 'SC' until the runtime config loads.
 */
let namespace = 'SC';

/** Set the IRIS namespace. Called once at startup from the config loader. */
export function setNamespace(value: string | undefined | null): void {
  namespace = value || 'SC';
}

/** The configured IRIS namespace (from env via /config.json). */
export function getNamespace(): string {
  return namespace;
}

/**
 * The API bearer token, sourced from the backend at startup via /config.json
 * (see app-config.ts). Mutable module state, set once during bootstrap — the
 * same pattern as apiBaseUrl/namespace. Both frontend transports read it here:
 * the HttpClient interceptor and the assistant service's raw fetch() calls.
 */
let apiToken = '';

/** Set the API bearer token. Called once at startup from the config loader. */
export function setApiToken(value: string | undefined | null): void {
  apiToken = value ?? '';
}

/** The configured API bearer token, or '' if none. */
export function getApiToken(): string {
  return apiToken;
}

/** Authorization header for a backend call, or {} when no token is configured. */
export function authHeaders(): Record<string, string> {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

/**
 * Build a full URL for a backend API call by prepending the configured base
 * origin to a root-relative path. With an empty base this returns the path
 * unchanged (same-origin relative request).
 *
 * Call this at REQUEST TIME, not at module load — the base is set during
 * bootstrap, so capturing it in a module-level `const` would freeze the
 * pre-config default. Services should compute their base lazily (a getter or
 * per-call) rather than `const BASE = apiUrl(...)`.
 *
 * @param path a root-relative path beginning with "/", e.g. "/api/sessions".
 */
export function apiUrl(path: string): string {
  if (!apiBaseUrl) return path;
  return `${apiBaseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}
