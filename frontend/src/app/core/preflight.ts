/**
 * Setup preflight state: has this Workbench confirmed it can talk to SCO?
 *
 * Runs ONCE during bootstrap (see app.config.ts), before the router picks a page, so
 * the Workbench is never rendered against an instance that is down, rejecting our
 * credentials, or too old to serve its features. The verdict is held here as module
 * state — the same pattern as `apiBaseUrl` / `aiEnabled` — because the route guard,
 * the blocking screen, and any later Retry all need the one answer.
 *
 * FAIL CLOSED. Every path that cannot positively confirm SCO is reachable, authentic
 * and new enough leaves the gate shut. That includes the request itself failing: if
 * we cannot even ask, we do not know, and "we don't know" must not open the door.
 */
import { apiUrl, authHeaders } from './api';

/** Why the gate is shut. Mirrors the backend's PreflightReason one-for-one. */
export type PreflightReason =
  | 'unreachable'
  | 'timeout'
  | 'unauthenticated'
  | 'api-not-found'
  | 'version-too-old'
  | 'version-unreadable'
  | 'http-error'
  /** Frontend-only: the preflight request itself never completed. */
  | 'preflight-failed';

/** The backend's verdict, plus the frontend-only failure case. */
export interface PreflightResult {
  ok: boolean;
  reason?: PreflightReason;
  version?: string;
  minimumVersion: string;
  endpoint: string;
  namespace: string;
  user: string;
  detail?: string;
}

/**
 * Until the check runs, the gate is SHUT (`ok: false`). A bug that skipped the
 * bootstrap initializer must not read as "all clear".
 */
const UNKNOWN: PreflightResult = {
  ok: false,
  reason: 'preflight-failed',
  minimumVersion: '',
  endpoint: '',
  namespace: '',
  user: '',
  detail: 'The setup check has not run yet.',
};

let result: PreflightResult = UNKNOWN;

/** The current verdict. */
export function preflightResult(): PreflightResult {
  return result;
}

/** Has SCO been confirmed usable? The one thing the route guard asks. */
export function scoReady(): boolean {
  return result.ok;
}

/** Overwrite the verdict. Exported for the bootstrap path and for tests. */
export function setPreflightResult(next: PreflightResult): void {
  result = next;
}

/** Reset to the pre-check state. For tests, so one spec cannot leak into the next. */
export function resetPreflightResult(): void {
  result = UNKNOWN;
}

/**
 * Ask the backend and store the verdict. Never throws: a rejected request becomes a
 * `preflight-failed` verdict so bootstrap always completes and the user gets the
 * blocking screen (which can explain itself and offer Retry) rather than a blank page.
 *
 * `cache: 'no-store'` because the whole point of Retry is to see a CHANGED answer
 * after the user starts their container or fixes a password.
 *
 * Uses `fetch` + `authHeaders()` rather than `HttpClient`: this runs inside a
 * bootstrap initializer, so it re-adds by hand the bearer header the HTTP
 * interceptor would otherwise attach. `loadAppConfig` has already put the token in
 * place (app.config.ts orders them).
 */
export async function runPreflight(): Promise<PreflightResult> {
  try {
    const res = await fetch(apiUrl('/api/preflight'), {
      cache: 'no-store',
      headers: authHeaders(),
    });
    if (!res.ok) {
      setPreflightResult({
        ...UNKNOWN,
        detail: `The Workbench server answered HTTP ${res.status} for its own setup check.`,
      });
      return result;
    }
    const body = (await res.json()) as PreflightResult;
    // Trust only an explicit `ok: true`; a malformed body keeps the gate shut.
    setPreflightResult(body && typeof body.ok === 'boolean' ? body : { ...UNKNOWN, detail: 'The setup check returned an unreadable result.' });
  } catch (err: unknown) {
    setPreflightResult({
      ...UNKNOWN,
      detail: `Could not reach the Workbench server itself: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return result;
}

