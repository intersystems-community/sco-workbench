import { setApiBaseUrl, setNamespace, setApiToken } from './api';
import { setAiEnabled } from './ai-status';

/**
 * Runtime configuration fetched once at app startup from `/config.json`.
 *
 * `/config.json` is served by whoever serves the frontend — in the single Docker
 * image the Node backend generates it from its `.env` (API_BASE_URL); in a split
 * deployment the frontend's web server (nginx) provides it. This lets one built
 * bundle be configured per-environment WITHOUT rebuilding, which a compile-time
 * `environment.ts` value cannot do.
 */
export interface AppConfig {
  /** Backend API origin, e.g. '' (same origin) or 'https://api.example.com'. */
  apiBaseUrl?: string;
  /** IRIS namespace, sourced from the backend's SCO_NAMESPACE env. */
  namespace?: string;
  /** API bearer token for the browser→backend hop (SC-2603). */
  apiToken?: string;
  /**
   * Whether the backend has Claude (AWS Bedrock) credentials at all.
   * Absent — an older backend, or an nginx-served config in a split deployment —
   * means "assume yes": see ai-status.ts for why the default is fail-open.
   */
  aiEnabled?: boolean;
}

/**
 * Load `/config.json` and apply it. Fetched from the app's own origin (a plain
 * relative path) because the API base isn't known until this resolves. Failure
 * is non-fatal: a missing or malformed file leaves the compile-time default in
 * place (same origin), so the app still boots.
 */
export async function loadAppConfig(): Promise<void> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = (await res.json()) as AppConfig;
    if (typeof cfg.apiBaseUrl === 'string') setApiBaseUrl(cfg.apiBaseUrl);
    if (typeof cfg.namespace === 'string') setNamespace(cfg.namespace);
    if (typeof cfg.apiToken === 'string') setApiToken(cfg.apiToken);
    // Only an explicit boolean speaks here; a missing field must leave the AI
    // enabled rather than disable the assistant on a config we couldn't read.
    if (typeof cfg.aiEnabled === 'boolean') setAiEnabled(cfg.aiEnabled);
  } catch {
    // No/!invalid config.json — keep the compile-time default (same origin).
  }
}
