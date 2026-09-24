// backend/src/agent/ai-errors.ts
import { aiConfigured, missingConfigHint, type Env } from '../config/env.js';

/**
 * The invariant opening of the "no Claude configured" message. The frontend keys
 * its own placeholder off this exact wording ("Claude key not provided"), and the
 * sentence that FOLLOWS it is provider-specific — so the prefix is the contract
 * and the rest is assembled per deployment by `aiKeyMissingMessage()`.
 */
export const AI_KEY_MISSING_PREFIX = 'Claude key not provided.';

/**
 * What the user is told when no Claude credentials are configured at all. The
 * workbench still runs — this is the message its AI entry points return instead
 * of attempting a call that cannot succeed.
 *
 * It takes `env` because the workbench supports FIVE Claude providers (see
 * config/providers.ts) and the actionable half of the message differs for each:
 * naming Bedrock's AWS variables to an operator who configured Vertex or Foundry
 * sends them to fix the wrong thing, which is the exact failure this message pair
 * exists to avoid. With nothing configured at all it names the choice itself.
 */
export function aiKeyMissingMessage(env: Env): string {
  return `${AI_KEY_MISSING_PREFIX} ${missingConfigHint(env)}`;
}

/**
 * What the user is told when credentials ARE configured but the provider rejects
 * them. It says more than a bare "Invalid key" — what is wrong, what to do, and
 * that a restart is needed to pick the fix up (the environment is read once at
 * boot) — while staying short enough to read in a chat bubble or a toast.
 *
 * Provider-neutral on purpose: it is one sentence for all five providers, and
 * what it deliberately does NOT include is the raw provider text, which names
 * accounts, ARNs, resources and token fragments that should not appear in a chat
 * bubble. The paired sibling is `aiKeyMissingMessage()` above — same shape,
 * different cause, and the two must stay distinguishable: "not configured" sends
 * the user to add credentials, "invalid" sends them to fix the ones they have.
 */
export const AI_KEY_INVALID_MESSAGE =
  'Invalid credentials provided for Claude. Please use the correct credentials and restart the server to use the AI features.';

/**
 * Does this error mean "the provider refused the credentials"? Matched on message
 * text because the failure reaches us as a plain Error from the Agent SDK
 * subprocess, not as a typed cloud-SDK exception with a `name` we could switch on.
 *
 * The patterns are the credential-rejection family across all five providers: the
 * AWS STS/SigV4 error names, the classic "security token ... is invalid" (what a
 * dummy or expired AWS key produces), an unresolvable credential chain, Google's
 * and Azure's equivalents, the Agent SDK's own error names for a refused
 * credential, and the 401/403 status codes.
 * Anything else — a network partition, a throttle, a missing model — is NOT a
 * credential problem and keeps its own message, because telling a user their key
 * is invalid when the provider is merely throttling sends them to fix the wrong
 * thing.
 */
export function isAiAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return [
    // AWS (Amazon Bedrock, Claude Platform on AWS)
    /UnrecognizedClientException/i,
    /InvalidSignatureException/i,
    /SignatureDoesNotMatch/i,
    /InvalidAccessKeyId/i,
    /ExpiredToken/i,
    /security token .* (is )?invalid/i,
    /AccessDenied/i,
    /\bnot authorized\b/i,
    /could not load credentials/i,
    // Google Cloud's Agent Platform: the ADC chain failing to resolve, and the
    // API's own name for a rejected/absent OAuth credential.
    /could not load the default credentials/i,
    /UNAUTHENTICATED/,
    /invalid_grant/i,
    // Microsoft Foundry: the Entra ID / Azure SDK credential-chain failures, both
    // of which the docs quote verbatim for a missing or unusable credential.
    /azureADTokenProvider/i,
    /ChainedTokenCredential authentication failed/i,
    /DefaultAzureCredential/i,
    // The Anthropic API's own name for a rejected key.
    /authentication_error/i,
    // The Agent SDK's SDKAssistantMessageError names, which arrive instead of the
    // provider's text when the failure is reported by the CLI subprocess itself
    // (e.g. the api_retry notice `credentialRejection()` turns into a throw).
    /authentication_failed/i,
    /oauth_org_not_allowed/i,
    /\b(401|403)\b/,
  ].some((pattern) => pattern.test(message));
}

/**
 * The user-facing message for a failed AI call. Three outcomes, in order:
 *   1. nothing configured        → aiKeyMissingMessage() ("Claude key not provided…")
 *   2. configured but rejected   → AI_KEY_INVALID_MESSAGE ("Invalid credentials provided…")
 *   3. anything else             → the underlying message, unchanged
 *
 * Case 1 is checked first because a call attempted with no credentials fails with
 * whatever the SDK happens to say about the missing chain, which would otherwise
 * be misreported as an invalid key.
 */
export function describeAiFailure(env: Env, err: unknown): string {
  if (!aiConfigured(env)) return aiKeyMissingMessage(env);
  if (isAiAuthFailure(err)) return AI_KEY_INVALID_MESSAGE;
  if (err instanceof Error && err.message) return err.message;
  return 'The AI service could not be reached.';
}
