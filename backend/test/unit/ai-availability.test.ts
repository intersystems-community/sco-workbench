// backend/test/unit/ai-availability.test.ts
//
// Graceful degradation when Claude is unavailable. Two questions, kept
// apart on purpose:
//
//   aiConfigured(env)          — is there anything to call? (presence, cheap, sync)
//   describeAiFailure(env,err) — a call was made and failed: whose fault, and what
//                                do we tell the user?
//
// The pair is what lets the UI say "Claude key not provided" BEFORE a click and
// "Invalid credentials provided…" after one, instead of one vague error covering both.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { aiConfigured, providerEnv, type Env } from '../../src/config/env.js';
import {
  describeAiFailure,
  isAiAuthFailure,
  aiKeyMissingMessage,
  AI_KEY_INVALID_MESSAGE,
} from '../../src/agent/ai-errors.js';

/**
 * An Env fake carrying only the AI-relevant vars. No provider flag and no
 * CLAUDE_PROVIDER, so these cases exercise the AUTO-DETECTION path: an AWS
 * credential alone resolves to Bedrock, which is what every pre-multi-provider
 * `.env` in the wild looks like.
 */
function aiEnv(over: Partial<Record<string, unknown>> = {}): Env {
  return { ANTHROPIC_MODEL: 'us.anthropic.claude', AWS_REGION: 'us-east-1', ...over } as unknown as Env;
}

/** The "nothing configured" message for a given env, for assertions below. */
const missing = (env: Env) => aiKeyMissingMessage(env);

describe('aiConfigured — is Claude callable at all (Bedrock, auto-detected)', () => {
  it('accepts a bearer token', () => {
    expect(aiConfigured(aiEnv({ AWS_BEARER_TOKEN_BEDROCK: 'tok' }))).toBe(true);
  });

  it('accepts a named profile', () => {
    expect(aiConfigured(aiEnv({ AWS_PROFILE: 'bedrock' }))).toBe(true);
  });

  it('accepts a complete access-key pair', () => {
    expect(aiConfigured(aiEnv({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }))).toBe(true);
  });

  it('rejects HALF an access-key pair', () => {
    // A key id with no secret cannot sign anything; the old boot gate drew the
    // same line and it must not soften into "looks configured".
    expect(aiConfigured(aiEnv({ AWS_ACCESS_KEY_ID: 'AKIA' }))).toBe(false);
    expect(aiConfigured(aiEnv({ AWS_SECRET_ACCESS_KEY: 'secret' }))).toBe(false);
  });

  it('treats the EMPTY string as absent, not as a value', () => {
    // This is the shipped `.env.example` state (`AWS_BEARER_TOKEN_BEDROCK=` with
    // nothing after it). A truthiness slip here would advertise the AI to every
    // user who copied the example file and never set a key.
    expect(aiConfigured(aiEnv({ AWS_BEARER_TOKEN_BEDROCK: '' }))).toBe(false);
    expect(aiConfigured(aiEnv({ AWS_PROFILE: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' }))).toBe(false);
  });

  it('needs a model AND a region, not just credentials', () => {
    expect(aiConfigured(aiEnv({ ANTHROPIC_MODEL: '', AWS_BEARER_TOKEN_BEDROCK: 'tok' }))).toBe(false);
    expect(aiConfigured(aiEnv({ AWS_REGION: '', AWS_BEARER_TOKEN_BEDROCK: 'tok' }))).toBe(false);
  });

  it('is false for a completely bare environment', () => {
    expect(aiConfigured({} as unknown as Env)).toBe(false);
  });
});

describe('providerEnv — what the SDK subprocess is handed (Bedrock)', () => {
  it('forwards the vars that are set', () => {
    const forwarded = providerEnv(aiEnv({ AWS_BEARER_TOKEN_BEDROCK: 'tok', CLAUDE_CODE_USE_BEDROCK: true }));
    expect(forwarded).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      ANTHROPIC_MODEL: 'us.anthropic.claude',
      AWS_BEARER_TOKEN_BEDROCK: 'tok',
    });
  });

  it('OMITS absent/empty vars instead of forwarding a blank', () => {
    // These vars are optional, so a blanket `AWS_REGION: env.AWS_REGION` would
    // hand the child an empty AWS_REGION and thereby ERASE one the ambient
    // environment (or an AWS profile) supplied — breaking a setup that worked.
    // Absent keys leave the inherited value alone. All that is left is the four
    // routing flags, which are always written (see claude-providers.test.ts).
    const forwarded = providerEnv(aiEnv({ AWS_REGION: '', ANTHROPIC_MODEL: '', AWS_PROFILE: '' }));
    expect(Object.keys(forwarded).sort()).toEqual([
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_VERTEX',
    ]);
    expect('AWS_REGION' in forwarded).toBe(false);
    expect('AWS_PROFILE' in forwarded).toBe(false);
  });
});

describe('isAiAuthFailure — is this error about the credentials', () => {
  const rejections = [
    'An error occurred (UnrecognizedClientException) when calling the InvokeModel operation',
    'InvalidSignatureException: Signature expired',
    'SignatureDoesNotMatch: the request signature we calculated does not match',
    'The AWS Access Key Id you provided does not exist: InvalidAccessKeyId',
    'ExpiredTokenException: The security token included in the request is expired',
    '403 The security token included in the request is invalid',
    'AccessDeniedException: You do not have access to the model',
    'User is not authorized to perform bedrock:InvokeModel',
    'CredentialsProviderError: Could not load credentials from any providers',
    'Request failed with status code 401',
    // Google Cloud's Agent Platform — the ADC failure its own troubleshooting
    // quotes verbatim, and the API's name for a rejected OAuth credential.
    'Error: Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication',
    'UNAUTHENTICATED: Request had invalid authentication credentials',
    'invalid_grant: reauth related error',
    // Microsoft Foundry — the Entra ID chain failure its docs quote verbatim.
    'Failed to get token from azureADTokenProvider: ChainedTokenCredential authentication failed',
    'DefaultAzureCredential failed to retrieve a token from the included credentials',
    // The Anthropic API's own name for a rejected key.
    'authentication_error: invalid x-api-key',
    // The Agent SDK's own error names, which is how the failure reaches us when the
    // CLI subprocess reports it (an api_retry notice can carry a null HTTP status,
    // leaving the name as the only signal — see ai-fail-fast.test.ts).
    'The Claude provider refused the credentials (HTTP none; authentication_failed).',
    'The Claude provider refused the credentials (HTTP none; oauth_org_not_allowed).',
  ];
  for (const message of rejections) {
    it(`recognizes: ${message.slice(0, 44)}…`, () => {
      expect(isAiAuthFailure(new Error(message))).toBe(true);
    });
  }

  const notCredentials = [
    'ThrottlingException: Too many requests, please wait',
    'connect ETIMEDOUT 52.94.0.1:443',
    'socket hang up',
    'ValidationException: the model id is not supported in this region',
    'The agent reached its step limit for a single message and stopped.',
    'Request failed with status code 500',
  ];
  for (const message of notCredentials) {
    it(`does NOT blame the key for: ${message.slice(0, 40)}…`, () => {
      // Misreporting a throttle or an outage as invalid credentials sends the user off
      // to regenerate a perfectly good credential.
      expect(isAiAuthFailure(new Error(message))).toBe(false);
    });
  }

  it('tolerates a non-Error rejection', () => {
    expect(isAiAuthFailure('403 forbidden')).toBe(true);
    expect(isAiAuthFailure(undefined)).toBe(false);
    expect(isAiAuthFailure(null)).toBe(false);
    expect(isAiAuthFailure({ nope: true })).toBe(false);
  });
});

describe('describeAiFailure — what the user is told', () => {
  const configured = aiEnv({ AWS_BEARER_TOKEN_BEDROCK: 'tok' });

  it('says the key is INVALID when configured credentials are refused', () => {
    const message = describeAiFailure(configured, new Error('403 The security token included in the request is invalid'));
    expect(message).toBe(AI_KEY_INVALID_MESSAGE);
    expect(message).toMatch(/^Invalid credentials provided for Claude\./);
  });

  it('tells the user what to DO, briefly', () => {
    // A bare "Invalid key" named nothing actionable and read like a workbench bug
    // rather than a server setting. This says what is wrong, what to do, and that a
    // restart is needed to pick the fix up (the environment is read once at boot) —
    // and stays short: it lands in a chat bubble and a toast, where a paragraph of
    // variable names went unread.
    expect(AI_KEY_INVALID_MESSAGE).toMatch(/[Ii]nvalid credentials/);
    expect(AI_KEY_INVALID_MESSAGE).toMatch(/Claude/);
    expect(AI_KEY_INVALID_MESSAGE).toMatch(/correct credentials/);
    expect(AI_KEY_INVALID_MESSAGE).toMatch(/restart the server/i);
    expect(AI_KEY_INVALID_MESSAGE.length).toBeLessThan(200);
    // And it stays a DIFFERENT message from "not configured": one sends the user to
    // add credentials, the other to fix the ones they already have.
    expect(AI_KEY_INVALID_MESSAGE).not.toBe(missing(configured));
    expect(AI_KEY_INVALID_MESSAGE).not.toMatch(/not provided/);
  });

  it('carries no credential material of its own', () => {
    // It is shown in a browser, so it must name nothing from the environment.
    expect(AI_KEY_INVALID_MESSAGE).not.toMatch(/AKIA|Bearer |arn:aws/);
  });

  it('does not leak the raw AWS text (account ids, ARNs, token fragments)', () => {
    const raw = 'AccessDeniedException: User arn:aws:iam::123456789012:user/dev is not authorized (token AKIAV3RYS3CR3T)';
    const message = describeAiFailure(configured, new Error(raw));
    expect(message).not.toMatch(/123456789012|AKIAV3RYS3CR3T|arn:aws/);
  });

  it('says the key is MISSING when nothing is configured, whatever the error said', () => {
    // A call attempted with no credentials fails with whatever the SDK says about
    // the unresolvable chain — which would otherwise be reported as an invalid
    // key, sending the user to fix a key they never set.
    const bare = aiEnv();
    const message = describeAiFailure(bare, new Error('Could not load credentials from any providers'));
    expect(message).toBe(missing(bare));
    expect(message).toMatch(/^Claude key not provided\./);
  });

  it('names the vars to set FOR THE PROVIDER IN PLAY, so the message is actionable', () => {
    // The half-configured Bedrock env auto-detects Bedrock, so it must name AWS
    // variables...
    const halfBedrock = aiEnv({ AWS_PROFILE: 'dev', ANTHROPIC_MODEL: '' });
    expect(missing(halfBedrock)).toMatch(/Amazon Bedrock/);
    expect(missing(halfBedrock)).toMatch(/AWS_BEARER_TOKEN_BEDROCK/);
    expect(missing(halfBedrock)).toMatch(/AWS_REGION/);
    expect(missing(halfBedrock)).toMatch(/ANTHROPIC_MODEL/);

    // ...and a Foundry deployment must NOT. Naming AWS variables to an operator
    // configuring Azure is the exact wrong-thing-to-fix this pair exists to avoid.
    const halfFoundry = { CLAUDE_PROVIDER: 'foundry', ANTHROPIC_FOUNDRY_RESOURCE: 'my-res' } as unknown as Env;
    expect(missing(halfFoundry)).toMatch(/Microsoft Foundry/);
    expect(missing(halfFoundry)).toMatch(/ANTHROPIC_FOUNDRY_RESOURCE/);
    expect(missing(halfFoundry)).not.toMatch(/AWS_/);
  });

  it('names the CHOICE when nothing at all is configured', () => {
    // With no provider resolvable there is no provider-specific hint to give, and
    // guessing one would send the user down an arbitrary path.
    const nothing = {} as unknown as Env;
    expect(missing(nothing)).toMatch(/^Claude key not provided\./);
    expect(missing(nothing)).toMatch(/CLAUDE_PROVIDER/);
    expect(missing(nothing)).toMatch(/bedrock/);
    expect(missing(nothing)).toMatch(/vertex/);
    expect(missing(nothing)).toMatch(/foundry/);
  });

  it('passes any other failure through unchanged', () => {
    expect(describeAiFailure(configured, new Error('ThrottlingException: slow down'))).toBe(
      'ThrottlingException: slow down',
    );
  });

  it('falls back to a readable line for a thrown non-Error / empty message', () => {
    expect(describeAiFailure(configured, new Error(''))).toBe('The AI service could not be reached.');
    expect(describeAiFailure(configured, undefined)).toBe('The AI service could not be reached.');
  });
});

/**
 * The boot path itself. The SCHEMA used to refuse a credential-less
 * environment (a `.refine` that threw "No AWS credentials found"), so an install
 * without Claude could not start at all — every UI affordance below is pointless
 * if the process exits first. These tests parse a REAL process.env, so they pin
 * the removal of that gate rather than the behaviour of a hand-built Env object.
 */
describe('loadEnv with no Claude configuration', () => {
  /** EVERY provider's vars blanked, plus the four vars IRIS genuinely requires.
   *  Blanking (not deleting) also stops dotenv from filling them back in from a
   *  developer's .env — it never overrides an already-defined key. All five
   *  providers have to be blanked now, not just Bedrock: a stray ANTHROPIC_API_KEY
   *  or CLAUDE_CODE_USE_VERTEX in the ambient environment would otherwise resolve a
   *  provider and make "no Claude configuration" untrue. */
  function stubKeylessEnv(): void {
    for (const key of [
      'CLAUDE_PROVIDER',
      'ANTHROPIC_MODEL',
      // routing flags
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      // anthropic
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      // bedrock / claude-aws
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_PROFILE',
      'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'ANTHROPIC_AWS_API_KEY',
      // vertex
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'CLOUD_ML_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      // foundry
      'ANTHROPIC_FOUNDRY_RESOURCE',
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    ]) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('SCO_HOST', 'localhost');
    vi.stubEnv('SCO_NAMESPACE', 'TESTNS');
    vi.stubEnv('SCO_USER', 'tester');
    vi.stubEnv('SCO_PASSWORD', 'secret');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('parses (the app boots) and reports the AI as unconfigured', async () => {
    stubKeylessEnv();
    vi.resetModules(); // loadEnv() memoizes, so take a fresh module instance
    const mod = await import('../../src/config/env.js');

    const env = mod.loadEnv(); // must not throw: this IS the boot path
    expect(mod.aiConfigured(env)).toBe(false);
    expect(mod.resolveProvider(env)).toBeNull();
    // Nothing to hand the SDK subprocess beyond the four routing switches (all
    // off) — and crucially no empty AWS_REGION/ANTHROPIC_MODEL that would blank an
    // ambient value.
    const forwarded = mod.providerEnv(env);
    expect(Object.keys(forwarded).sort()).toEqual([
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_VERTEX',
    ]);
    expect(Object.values(forwarded)).toEqual(['0', '0', '0', '0']);
    // The rest of the configuration is unaffected by the missing key.
    expect(env.SCO_HOST).toBe('localhost');
  });

  it('boots with a BLANK CLAUDE_PROVIDER rather than failing the enum', async () => {
    // `.env.example` writes optional settings as a bare `KEY=`. If the enum
    // rejected the empty string, that shape would refuse to start the server.
    stubKeylessEnv();
    vi.stubEnv('CLAUDE_PROVIDER', '');
    vi.resetModules();
    const mod = await import('../../src/config/env.js');

    const env = mod.loadEnv();
    expect(env.CLAUDE_PROVIDER).toBe('auto');
  });

  it('refuses to boot on a MISSPELLED provider instead of silently auto-detecting', async () => {
    // Failing loud is right here: silently ignoring `CLAUDE_PROVIDER=bedrok` would
    // route to whatever happened to be detectable, which is the confusing outcome
    // the explicit setting exists to prevent.
    stubKeylessEnv();
    vi.stubEnv('CLAUDE_PROVIDER', 'bedrok');
    vi.resetModules();
    const mod = await import('../../src/config/env.js');

    expect(() => mod.loadEnv()).toThrow(/CLAUDE_PROVIDER/);
  });

  it('reports the AI as configured once a bearer token, region and model are set', async () => {
    stubKeylessEnv();
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-6');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'bedrock-token');
    vi.resetModules();
    const mod = await import('../../src/config/env.js');

    const env = mod.loadEnv();
    expect(mod.aiConfigured(env)).toBe(true);
    // No CLAUDE_CODE_USE_BEDROCK and no CLAUDE_PROVIDER here: this is the
    // AUTO-DETECTION path, and it must still land on Bedrock — every `.env` written
    // before multi-provider support looks exactly like this.
    expect(mod.describeProvider(env)).toMatchObject({ id: 'bedrock', source: 'detected' });
    expect(mod.providerEnv(env)).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
    });
  });
});
