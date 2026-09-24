// backend/src/config/providers.ts
//
// WHICH Claude does the AI Assistant talk to, and with WHOSE credentials?
//
// The Claude Agent SDK does not take a provider argument. It spawns the Claude
// Code CLI as a subprocess and that subprocess picks its provider from ITS OWN
// environment — so "supporting five providers" is entirely a question of which
// environment variables we hand the child (see `providerEnv` at the bottom).
// This module is the single place that knows the five options, the variables
// each one needs, and how to pick one from a `.env`.
//
// The five, using the names the Claude Code docs use:
//   anthropic   Claude API (Anthropic Console) — inference at Anthropic
//   bedrock     Amazon Bedrock                 — inference in your AWS account
//   claude-aws  Claude Platform on AWS         — Anthropic's API, AWS auth + Marketplace billing
//   vertex      Google Cloud's Agent Platform (formerly Vertex AI)
//   foundry     Microsoft Foundry (Azure)
//
// Reference: https://code.claude.com/docs/en/third-party-integrations
//
// Nothing here is a validity check. Every function below asks only "is the
// configuration PRESENT and internally complete", because that is all a process
// can know without spending a round-trip. Present-but-refused credentials are a
// call-time answer — see agent/ai-errors.ts and dashboard/ai-health.ts.
import { z } from 'zod';

/** The provider ids, in a stable order for enums and docs. */
export const PROVIDER_IDS = ['anthropic', 'bedrock', 'claude-aws', 'vertex', 'foundry'] as const;

export type ClaudeProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Boolean-ish env values: "1"/"true"/"yes"/"on" (case-insensitive) are true.
 *
 * Deliberately NO default. These are the CLI's provider ROUTING flags, and an
 * unset flag has to stay distinguishable from an explicit `=0`: `CLAUDE_PROVIDER`
 * and the auto-detection below both key off "did the user opt this one in".
 * (`CLAUDE_CODE_USE_BEDROCK` used to default to `'1'`, which made Bedrock the
 * only reachable provider no matter what else was configured.)
 */
const flag = () =>
  z
    .string()
    .optional()
    .transform((v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

/** An optional string var. Empty string counts as absent everywhere below. */
const optional = () => z.string().optional();

/**
 * Every Claude/provider variable the backend reads, as a zod shape that
 * `config/env.ts` spreads into the full `EnvSchema`. Kept here, beside the
 * provider table that consumes them, so adding a provider touches one file.
 *
 * ALL OPTIONAL, deliberately: the workbench's own features (data model,
 * integration wizard, cubes, KPIs, dashboards) are plain IRIS calls that need no
 * LLM, so an install with no Claude configuration at all must BOOT and run. What
 * it must not do is pretend the AI is there — `aiConfigured()` is the single
 * source of truth for that, and it rides to the SPA on GET /config.json.
 */
const ClaudeProviderSchema = z.object({
  // ---- Provider selection ----
  // 'auto' (the default) resolves the provider from the variables that are
  // actually set — see `resolveProvider`. Set it explicitly to remove all doubt,
  // which also makes a misconfiguration report the provider you MEANT rather
  // than silently falling through to another one.
  //
  // The empty string is normalized to undefined BEFORE the enum sees it, so it
  // falls through to the 'auto' default. Without that, a `.env` carrying a bare
  // `CLAUDE_PROVIDER=` — the shape every other commented-out setting in
  // `.env.example` takes — would fail the enum and refuse to BOOT the whole
  // workbench over a setting the operator left blank on purpose.
  CLAUDE_PROVIDER: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['auto', ...PROVIDER_IDS]).default('auto'),
  ),

  // The model. Required for every provider (see `configured` below): the CLI's
  // own default drifts with its releases and may not be enabled in the account,
  // so the workbench pins one. Its FORM is provider-specific — a Bedrock
  // inference-profile id, a Vertex model id, a Foundry *deployment name*, or a
  // plain Claude API model id.
  ANTHROPIC_MODEL: optional(),

  // ---- The CLI's provider routing flags ----
  CLAUDE_CODE_USE_BEDROCK: flag(),
  CLAUDE_CODE_USE_ANTHROPIC_AWS: flag(),
  CLAUDE_CODE_USE_VERTEX: flag(),
  CLAUDE_CODE_USE_FOUNDRY: flag(),

  // ---- anthropic: Claude API (Anthropic Console) ----
  ANTHROPIC_API_KEY: optional(),
  // Bearer-token auth, for an LLM gateway that does not take an Anthropic key.
  ANTHROPIC_AUTH_TOKEN: optional(),
  // A long-lived subscription token from `claude setup-token`.
  CLAUDE_CODE_OAUTH_TOKEN: optional(),
  ANTHROPIC_BASE_URL: optional(),

  // ---- bedrock: Amazon Bedrock ----
  AWS_REGION: optional(),
  ANTHROPIC_BEDROCK_BASE_URL: optional(),

  // ---- claude-aws: Claude Platform on AWS ----
  // The workspace id is REQUIRED by the provider (sent as anthropic-workspace-id
  // on every request) and is not implied by the AWS credentials.
  ANTHROPIC_AWS_WORKSPACE_ID: optional(),
  ANTHROPIC_AWS_API_KEY: optional(),
  ANTHROPIC_AWS_BASE_URL: optional(),

  // ---- vertex: Google Cloud's Agent Platform ----
  ANTHROPIC_VERTEX_PROJECT_ID: optional(),
  // 'global', a multi-region ('us', 'eu'), or a region ('us-east5').
  CLOUD_ML_REGION: optional(),
  // Service-account key / external-account config file. Absent means the
  // ambient Application Default Credentials chain (e.g. `gcloud auth`).
  GOOGLE_APPLICATION_CREDENTIALS: optional(),
  ANTHROPIC_VERTEX_BASE_URL: optional(),

  // ---- foundry: Microsoft Foundry (Azure) ----
  ANTHROPIC_FOUNDRY_RESOURCE: optional(),
  ANTHROPIC_FOUNDRY_BASE_URL: optional(),
  ANTHROPIC_FOUNDRY_API_KEY: optional(),
  ANTHROPIC_FOUNDRY_AUTH_TOKEN: optional(),

  // ---- Shared AWS credential chain (bedrock AND claude-aws) ----
  AWS_ACCESS_KEY_ID: optional(),
  AWS_SECRET_ACCESS_KEY: optional(),
  AWS_SESSION_TOKEN: optional(),
  AWS_BEARER_TOKEN_BEDROCK: optional(),
  AWS_PROFILE: optional(),
  // Role-based credentials as a container/CI runtime injects them. Recognized so
  // an ECS/EKS task role counts as "credentials present" — without these three a
  // role-only deployment would be reported unconfigured even though it works.
  AWS_ROLE_ARN: optional(),
  AWS_WEB_IDENTITY_TOKEN_FILE: optional(),
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: optional(),
});

/** The shape `config/env.ts` spreads into the full environment schema. */
export const claudeProviderShape = ClaudeProviderSchema.shape;

/**
 * The provider-relevant slice of the environment. `Env` is structurally
 * assignable to this, so nothing below needs to import the full `Env` type (and
 * there is no import cycle with `config/env.ts`).
 *
 * Every field is read through `has()`/`Boolean()` so a partially-populated fake
 * (as the unit tests build) is safe.
 */
export type ClaudeEnv = z.infer<typeof ClaudeProviderSchema>;

/** Is this var set to something non-empty? The empty string counts as ABSENT. */
function has(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

/** Can the AWS SDK credential chain resolve SOMETHING from this environment? */
function hasAwsCredentials(env: ClaudeEnv): boolean {
  return (
    has(env.AWS_BEARER_TOKEN_BEDROCK) ||
    has(env.AWS_PROFILE) ||
    (has(env.AWS_ACCESS_KEY_ID) && has(env.AWS_SECRET_ACCESS_KEY)) ||
    has(env.AWS_ROLE_ARN) ||
    has(env.AWS_WEB_IDENTITY_TOKEN_FILE) ||
    has(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)
  );
}

/** The AWS credential vars both AWS-backed providers forward to the subprocess. */
const AWS_CHAIN_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const satisfies readonly (keyof ClaudeEnv)[];

/** One Claude deployment option and everything the backend needs to know about it. */
export interface ClaudeProvider {
  readonly id: ClaudeProviderId;
  /** Human name, as the Claude Code docs write it. Used in UI/log messages. */
  readonly label: string;
  /**
   * The CLI's opt-in flag for this provider, if it has one. The Claude API is
   * the CLI's default route and therefore has none.
   */
  readonly routingVar?: keyof ClaudeEnv;
  /**
   * Does the environment IDENTIFY this provider without its routing flag? Keyed
   * on the variable only this provider uses, so detection cannot be ambiguous.
   */
  readonly detected: (env: ClaudeEnv) => boolean;
  /**
   * Is everything this provider needs present? A `true` here is what enables the
   * AI features in the UI; it does NOT promise the credentials are accepted.
   */
  readonly configured: (env: ClaudeEnv) => boolean;
  /** What to tell the user to set when `configured` is false. */
  readonly missingHint: string;
  /** The provider's own vars, forwarded to the SDK subprocess when set. */
  readonly vars: readonly (keyof ClaudeEnv)[];
}

/**
 * The five providers.
 *
 * Note the deliberate asymmetry in `configured`. Bedrock and Claude Platform on
 * AWS require a resolvable credential because theirs live in environment
 * variables; Vertex and Foundry do NOT, because their normal credential is
 * ambient and invisible to us — Google's Application Default Credentials and
 * Microsoft Entra ID's default credential chain are resolved inside the
 * subprocess from files, metadata servers and IdP sessions we cannot inspect.
 * Requiring a key for those two would report a perfectly good `gcloud`/`az
 * login` setup as unconfigured and grey out a working assistant. The cost is the
 * opposite error — the UI offers the assistant and the first call reports
 * "invalid credentials" — which is the same, clearly-explained outcome an
 * expired key already produces.
 */
export const PROVIDERS: readonly ClaudeProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude API)',
    // No routing flag: this is the CLI's default destination.
    detected: (env) =>
      has(env.ANTHROPIC_API_KEY) || has(env.ANTHROPIC_AUTH_TOKEN) || has(env.CLAUDE_CODE_OAUTH_TOKEN),
    configured: (env) =>
      has(env.ANTHROPIC_MODEL) &&
      (has(env.ANTHROPIC_API_KEY) || has(env.ANTHROPIC_AUTH_TOKEN) || has(env.CLAUDE_CODE_OAUTH_TOKEN)),
    missingHint:
      'Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) plus ANTHROPIC_MODEL to enable the AI features.',
    vars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    routingVar: 'CLAUDE_CODE_USE_BEDROCK',
    // Any resolvable AWS credential means Bedrock — it is both the historical
    // default of this workbench and first in the CLI's routing precedence, so a
    // bare AWS environment keeps working exactly as it did.
    detected: (env) => hasAwsCredentials(env),
    configured: (env) => has(env.ANTHROPIC_MODEL) && has(env.AWS_REGION) && hasAwsCredentials(env),
    missingHint:
      'Set the AWS credentials (AWS_BEARER_TOKEN_BEDROCK, or AWS_PROFILE, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) plus AWS_REGION and ANTHROPIC_MODEL to enable the AI features.',
    vars: ['AWS_REGION', 'ANTHROPIC_BEDROCK_BASE_URL', ...AWS_CHAIN_VARS],
  },
  {
    id: 'claude-aws',
    label: 'Claude Platform on AWS',
    routingVar: 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    detected: (env) => has(env.ANTHROPIC_AWS_WORKSPACE_ID) || has(env.ANTHROPIC_AWS_API_KEY),
    // The workspace id is not optional here: the provider rejects a request
    // without it, and no AWS credential implies one.
    configured: (env) =>
      has(env.ANTHROPIC_MODEL) &&
      has(env.ANTHROPIC_AWS_WORKSPACE_ID) &&
      has(env.AWS_REGION) &&
      (has(env.ANTHROPIC_AWS_API_KEY) || hasAwsCredentials(env)),
    missingHint:
      'Set ANTHROPIC_AWS_WORKSPACE_ID, AWS_REGION, ANTHROPIC_MODEL and either ANTHROPIC_AWS_API_KEY or AWS credentials to enable the AI features.',
    vars: [
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_AWS_BASE_URL',
      'AWS_REGION',
      ...AWS_CHAIN_VARS,
    ],
  },
  {
    id: 'vertex',
    label: "Google Cloud's Agent Platform (Vertex AI)",
    routingVar: 'CLAUDE_CODE_USE_VERTEX',
    detected: (env) => has(env.ANTHROPIC_VERTEX_PROJECT_ID),
    // Credentials come from the ADC chain, which we cannot see — see the note
    // above the table. Project and region we CAN require, and must: the request
    // is addressed to the project in ANTHROPIC_VERTEX_PROJECT_ID specifically.
    configured: (env) =>
      has(env.ANTHROPIC_MODEL) && has(env.ANTHROPIC_VERTEX_PROJECT_ID) && has(env.CLOUD_ML_REGION),
    missingHint:
      'Set ANTHROPIC_VERTEX_PROJECT_ID, CLOUD_ML_REGION and ANTHROPIC_MODEL (and sign in with gcloud, or set GOOGLE_APPLICATION_CREDENTIALS) to enable the AI features.',
    vars: [
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'CLOUD_ML_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'ANTHROPIC_VERTEX_BASE_URL',
    ],
  },
  {
    id: 'foundry',
    label: 'Microsoft Foundry',
    routingVar: 'CLAUDE_CODE_USE_FOUNDRY',
    detected: (env) =>
      has(env.ANTHROPIC_FOUNDRY_RESOURCE) ||
      has(env.ANTHROPIC_FOUNDRY_BASE_URL) ||
      has(env.ANTHROPIC_FOUNDRY_API_KEY) ||
      has(env.ANTHROPIC_FOUNDRY_AUTH_TOKEN),
    // The endpoint is built from the resource name, so one of resource/base URL
    // is mandatory. The credential may be an Entra ID default-chain session.
    configured: (env) =>
      has(env.ANTHROPIC_MODEL) &&
      (has(env.ANTHROPIC_FOUNDRY_RESOURCE) || has(env.ANTHROPIC_FOUNDRY_BASE_URL)),
    missingHint:
      'Set ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL) and ANTHROPIC_MODEL — the deployment name — plus ANTHROPIC_FOUNDRY_API_KEY or an Entra ID sign-in, to enable the AI features.',
    vars: [
      'ANTHROPIC_FOUNDRY_RESOURCE',
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    ],
  },
];

/** Look a provider up by id. */
export function providerById(id: ClaudeProviderId): ClaudeProvider {
  const found = PROVIDERS.find((p) => p.id === id);
  // Unreachable while the id type and the table agree; a throw beats returning
  // undefined and having every caller widen for a case that cannot happen.
  if (!found) throw new Error(`Unknown Claude provider: ${id}`);
  return found;
}

/**
 * Order in which an explicit ROUTING FLAG wins, mirroring the CLI's own provider
 * routing so our answer and the subprocess's answer cannot disagree: Bedrock and
 * Foundry take precedence, then Vertex, then Claude Platform on AWS (which its
 * docs describe as opt-in behind those). The Claude API has no flag and is not
 * in this list.
 */
const FLAG_PRECEDENCE: readonly ClaudeProviderId[] = ['bedrock', 'foundry', 'vertex', 'claude-aws'];

/**
 * Order in which a provider is INFERRED from the variables present, when no flag
 * is set. Distinctive markers (a Foundry resource, a Vertex project, an AWS
 * workspace id) are checked before the two generic credential families — a bare
 * AWS credential means Bedrock, and a bare `ANTHROPIC_API_KEY` means the Claude
 * API — so a specific configuration is never swallowed by a generic one.
 */
const DETECTION_ORDER: readonly ClaudeProviderId[] = ['foundry', 'vertex', 'claude-aws', 'bedrock', 'anthropic'];

/** Is this provider's routing flag set? */
function isRouted(provider: ClaudeProvider, env: ClaudeEnv): boolean {
  return Boolean(provider.routingVar && env[provider.routingVar]);
}

/**
 * Which provider is this environment for? Three steps, in order:
 *
 *   1. `CLAUDE_PROVIDER` names one explicitly — believed without inspection, so
 *      an incomplete configuration reports what the operator MEANT.
 *   2. A routing flag is set (`CLAUDE_CODE_USE_BEDROCK=1` and friends), resolved
 *      in the CLI's own precedence.
 *   3. Otherwise inferred from the variables that are set.
 *
 * Returns null when the environment says nothing about Claude at all — the
 * no-AI install, which boots and runs every non-AI feature.
 */
export function resolveProvider(env: ClaudeEnv): ClaudeProvider | null {
  const selected = env.CLAUDE_PROVIDER;
  if (selected && selected !== 'auto') return providerById(selected);
  for (const id of FLAG_PRECEDENCE) {
    const provider = providerById(id);
    if (isRouted(provider, env)) return provider;
  }
  for (const id of DETECTION_ORDER) {
    const provider = providerById(id);
    if (provider.detected(env)) return provider;
  }
  return null;
}

/**
 * Is Claude usable at all with this configuration? True only when a provider
 * resolves AND everything that provider needs is present.
 *
 * This is a CAPABILITY, not a boot gate: it used to be a schema `.refine` that
 * threw "No AWS credentials found", which made the whole workbench unstartable
 * over a feature most of it does not need. Every AI entry point asks this first,
 * and the answer is published to the SPA on GET /config.json so the UI can say
 * "Claude key not provided" up front instead of offering a control that cannot
 * work.
 *
 * It is a PRESENCE check, not a validity check — it cannot tell a live key from
 * an expired one. Present-but-rejected credentials surface at call time (see
 * agent/ai-errors.ts).
 */
export function aiConfigured(env: ClaudeEnv): boolean {
  const provider = resolveProvider(env);
  return provider ? provider.configured(env) : false;
}

/** What the health probe and the log line report about the current provider. */
export interface ProviderStatus {
  /** null when nothing about Claude is configured. */
  id: ClaudeProviderId | null;
  label: string;
  configured: boolean;
  /** How the provider was chosen — useful when the answer is a surprise. */
  source: 'explicit' | 'routing-flag' | 'detected' | 'none';
}

/** Describe the resolved provider, for /ai-health and the boot log. */
export function describeProvider(env: ClaudeEnv): ProviderStatus {
  const provider = resolveProvider(env);
  if (!provider) return { id: null, label: 'none', configured: false, source: 'none' };
  const source =
    env.CLAUDE_PROVIDER && env.CLAUDE_PROVIDER !== 'auto'
      ? 'explicit'
      : isRouted(provider, env)
        ? 'routing-flag'
        : 'detected';
  return { id: provider.id, label: provider.label, configured: provider.configured(env), source };
}

/**
 * The provider-specific half of the "no Claude configured" message: which
 * variables THIS deployment is missing. Naming Bedrock's variables to someone
 * configuring Vertex is worse than saying nothing.
 */
export function missingConfigHint(env: ClaudeEnv): string {
  const provider = resolveProvider(env);
  if (!provider) {
    return (
      'Configure one of the five Claude providers in .env — set CLAUDE_PROVIDER to ' +
      `${PROVIDER_IDS.join(', ')} and that provider's credentials — to enable the AI features.`
    );
  }
  return `Provider: ${provider.label}. ${provider.missingHint}`;
}

/**
 * The env vars the Claude Agent SDK subprocess needs for the RESOLVED provider.
 * Spread over `{ ...process.env }` when passing to `query({ options: { env } })`.
 *
 * Two rules, both load-bearing:
 *
 * 1. **Every routing flag is written, not just the selected one.** The selected
 *    provider's flag is `'1'` and the other three are `'0'`. Omitting the others
 *    would let an AMBIENT flag reroute the child: a developer who uses Claude
 *    Code themselves very likely has `CLAUDE_CODE_USE_BEDROCK=1` exported, which
 *    would silently hijack a Vertex- or Foundry-configured workbench (Bedrock
 *    wins the CLI's precedence) and fail with a confusing credential error.
 *
 * 2. **Only vars we actually HAVE are forwarded.** These vars are optional, so a
 *    blanket `AWS_REGION: env.AWS_REGION` would forward `''` and thereby BLANK
 *    OUT a value the ambient environment supplied — turning a working setup into
 *    a broken one. Omitting the key instead leaves the ambient value alone.
 *    (That matters most for the credentials we deliberately do not require:
 *    Vertex's ADC and Foundry's Entra chain live outside these variables.)
 */
export function providerEnv(env: ClaudeEnv): Record<string, string | undefined> {
  const provider = resolveProvider(env);
  const out: Record<string, string | undefined> = {};
  for (const candidate of PROVIDERS) {
    if (candidate.routingVar) out[candidate.routingVar] = candidate.id === provider?.id ? '1' : '0';
  }
  if (!provider) return out;
  // The model is shared across providers; its FORM is what differs.
  for (const key of ['ANTHROPIC_MODEL' as const, ...provider.vars]) {
    const value = env[key];
    if (typeof value === 'string' && has(value)) out[key] = value;
  }
  return out;
}
