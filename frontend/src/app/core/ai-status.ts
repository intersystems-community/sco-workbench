/**
 * Whether the backend has Claude credentials at all.
 *
 * The workbench's own features are IRIS calls and need no LLM, so an install with
 * no Bedrock credentials still runs — it just must not offer AI it cannot deliver.
 * The backend publishes the capability on `/config.json` as `aiEnabled`; this is
 * where the SPA keeps it, and every AI-backed control reads it to degrade UP FRONT
 * (a composer that says "Claude key not provided", a Deploy that explains itself)
 * instead of failing after the click.
 *
 * Mutable module state set once during bootstrap, the same pattern as
 * `apiBaseUrl` / `namespace` / `apiToken` in ./api.ts.
 *
 * DEFAULT TRUE, deliberately: a `/config.json` that never loads, or one served by
 * an older backend (or by nginx in a split deployment) that has no `aiEnabled`
 * field, must not silently disable the assistant. Only an explicit `false` turns
 * it off. A key that is present but REJECTED is not visible here at all — that
 * surfaces per call as the backend's "invalid credentials provided" message.
 */
let aiEnabled = true;

/** Apply the backend's `aiEnabled` capability. Called once at startup from the
 *  config loader; anything other than an explicit `false` leaves AI enabled. */
export function setAiEnabled(value: unknown): void {
  aiEnabled = value !== false;
}

/** Does the backend have Claude credentials configured? */
export function isAiEnabled(): boolean {
  return aiEnabled;
}

/** Composer placeholder when there is no key — short enough for the input box. */
export const AI_KEY_MISSING_PLACEHOLDER = 'Claude key not provided';

/** One-line form, for a toast or an inline notice where a paragraph would not be
 *  read (the long version below is for a modal, which has room). */
export const AI_KEY_MISSING_SHORT = 'Claude key not provided.';

/** The explanation shown where there is room for one (modal, toast). Says what to
 *  do about it, and that the rest of the workbench is unaffected. */
export const AI_KEY_MISSING_MESSAGE =
  'Claude key not provided. This action is handled by the AI assistant, which needs AWS Bedrock credentials configured on the server (AWS_BEARER_TOKEN_BEDROCK, or AWS_PROFILE, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, plus AWS_REGION and ANTHROPIC_MODEL). Everything else in the workbench keeps working without it.';
