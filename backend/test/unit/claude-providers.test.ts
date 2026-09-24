// backend/test/unit/claude-providers.test.ts
//
// Multi-provider Claude support (SC-2686). The Agent SDK takes no provider
// argument — it spawns the Claude Code CLI and that subprocess reads its provider
// from ITS OWN environment. So the whole feature reduces to two questions, and
// this file is about the hard cases of both:
//
//   resolveProvider(env)  — which of the five did the operator mean?
//   providerEnv(env)      — exactly what does the subprocess get told?
//
// The emphasis is deliberately on AMBIGUITY and CONTAMINATION rather than on the
// five happy paths: a workbench developer's own shell very plausibly exports
// CLAUDE_CODE_USE_BEDROCK=1 and ANTHROPIC_API_KEY (they use Claude Code), and the
// backend inherits `process.env`. A provider layer that only got the clean cases
// right would route those deployments to the wrong provider and blame the
// credentials.
import { describe, it, expect } from 'vitest';
import {
  aiConfigured,
  describeProvider,
  missingConfigHint,
  providerEnv,
  resolveProvider,
  PROVIDERS,
  PROVIDER_IDS,
  type ClaudeEnv,
} from '../../src/config/providers.js';

/** A ClaudeEnv fake. Partial on purpose — every field is optional in practice. */
function env(over: Partial<Record<string, unknown>> = {}): ClaudeEnv {
  return { CLAUDE_PROVIDER: 'auto', ...over } as unknown as ClaudeEnv;
}

/** A fully-configured environment for each provider, for the round-trip cases. */
const COMPLETE: Record<(typeof PROVIDER_IDS)[number], Partial<Record<string, unknown>>> = {
  anthropic: { ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_API_KEY: 'sk-ant-xxx' },
  bedrock: {
    ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
    AWS_REGION: 'us-east-1',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
  },
  'claude-aws': {
    ANTHROPIC_MODEL: 'claude-sonnet-5',
    AWS_REGION: 'us-east-1',
    ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_01ABCDEFGHIJKLMN',
    ANTHROPIC_AWS_API_KEY: 'sk-ant-aws-xxx',
  },
  vertex: {
    ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_VERTEX_PROJECT_ID: 'my-gcp-project',
    CLOUD_ML_REGION: 'global',
  },
  foundry: {
    // On Foundry the "model" is the Azure DEPLOYMENT name, not a Claude model id.
    ANTHROPIC_MODEL: 'my-sonnet-deployment',
    ANTHROPIC_FOUNDRY_RESOURCE: 'my-foundry-resource',
    ANTHROPIC_FOUNDRY_API_KEY: 'azure-key',
  },
};

describe('the provider table', () => {
  it('covers exactly the five documented deployment options', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    expect(PROVIDER_IDS).toHaveLength(5);
  });

  it('gives every provider except the Claude API its own routing flag', () => {
    // The Claude API is the CLI's DEFAULT destination and has no opt-in flag; the
    // other four each have exactly one, and no two may share it or `providerEnv`
    // could not turn one on and the rest off.
    const flags = PROVIDERS.map((p) => p.routingVar);
    expect(flags.filter(Boolean)).toHaveLength(4);
    expect(new Set(flags.filter(Boolean)).size).toBe(4);
    expect(PROVIDERS.find((p) => p.id === 'anthropic')?.routingVar).toBeUndefined();
  });

  for (const id of PROVIDER_IDS) {
    it(`resolves and configures ${id} from a complete environment`, () => {
      const e = env(COMPLETE[id]);
      expect(resolveProvider(e)?.id).toBe(id);
      expect(aiConfigured(e)).toBe(true);
    });
  }
});

describe('resolveProvider — explicit CLAUDE_PROVIDER wins outright', () => {
  it('is believed even when another provider is fully configured', () => {
    // The operator said Vertex. Reporting Bedrock because an AWS key happens to be
    // in the environment would send them to debug a provider they did not choose.
    const e = env({ ...COMPLETE.bedrock, CLAUDE_PROVIDER: 'vertex' });
    expect(resolveProvider(e)?.id).toBe('vertex');
    expect(describeProvider(e).source).toBe('explicit');
  });

  it('is believed even when it is INCOMPLETE — and then reports unconfigured', () => {
    // Silently falling back to the detectable Bedrock would give a working
    // assistant pointed at the wrong account, and the message would name AWS
    // variables to someone configuring GCP.
    const e = env({ ...COMPLETE.bedrock, CLAUDE_PROVIDER: 'vertex' });
    expect(aiConfigured(e)).toBe(false);
    expect(missingConfigHint(e)).toMatch(/ANTHROPIC_VERTEX_PROJECT_ID/);
    expect(missingConfigHint(e)).not.toMatch(/AWS_BEARER_TOKEN_BEDROCK/);
  });

  it('overrides a routing flag that says otherwise', () => {
    const e = env({ ...COMPLETE.foundry, CLAUDE_PROVIDER: 'foundry', CLAUDE_CODE_USE_BEDROCK: true });
    expect(resolveProvider(e)?.id).toBe('foundry');
    // ...and the contradicting flag is turned OFF for the subprocess, or Bedrock
    // would win the CLI's own precedence and the explicit setting would be a lie.
    expect(providerEnv(e)).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_FOUNDRY: '1' });
  });

  it('treats an absent CLAUDE_PROVIDER the same as "auto"', () => {
    // The unit-test fakes and any hand-built Env omit the field entirely.
    const e = { ...COMPLETE.bedrock } as unknown as ClaudeEnv;
    expect(resolveProvider(e)?.id).toBe('bedrock');
  });
});

describe('resolveProvider — routing flags, in the CLI\'s own precedence', () => {
  it('prefers Bedrock over Foundry, Vertex and Claude Platform on AWS', () => {
    // Not a preference of ours: the CLI routes this way, so resolving differently
    // would make our "provider" and the subprocess's provider disagree.
    const e = env({
      CLAUDE_CODE_USE_BEDROCK: true,
      CLAUDE_CODE_USE_FOUNDRY: true,
      CLAUDE_CODE_USE_VERTEX: true,
      CLAUDE_CODE_USE_ANTHROPIC_AWS: true,
    });
    expect(resolveProvider(e)?.id).toBe('bedrock');
  });

  it('prefers Foundry over Vertex and Claude Platform on AWS', () => {
    const e = env({ CLAUDE_CODE_USE_FOUNDRY: true, CLAUDE_CODE_USE_VERTEX: true, CLAUDE_CODE_USE_ANTHROPIC_AWS: true });
    expect(resolveProvider(e)?.id).toBe('foundry');
  });

  it('prefers Claude Platform on AWS only when nothing above it is flagged', () => {
    const e = env({ CLAUDE_CODE_USE_ANTHROPIC_AWS: true });
    expect(resolveProvider(e)?.id).toBe('claude-aws');
    expect(describeProvider(e).source).toBe('routing-flag');
  });

  it('beats detection: a flagged provider wins over another provider\'s credentials', () => {
    // The flag is a statement of intent; a stray key in the ambient environment is
    // not. This is the contaminated-shell case: a developer's exported
    // ANTHROPIC_API_KEY must not steal a Foundry deployment.
    const e = env({ ...COMPLETE.foundry, CLAUDE_CODE_USE_FOUNDRY: true, ANTHROPIC_API_KEY: 'sk-ant-stray' });
    expect(resolveProvider(e)?.id).toBe('foundry');
  });
});

describe('resolveProvider — auto-detection when no flag is set', () => {
  it('reads a bare AWS credential as Bedrock (the pre-multi-provider .env)', () => {
    // Back-compatibility, and the single most important case in this file: every
    // `.env` written before this change is exactly this shape.
    for (const credential of [
      { AWS_BEARER_TOKEN_BEDROCK: 'tok' },
      { AWS_PROFILE: 'bedrock' },
      { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' },
    ]) {
      expect(resolveProvider(env({ ...credential, AWS_REGION: 'us-east-1' }))?.id).toBe('bedrock');
    }
  });

  it('counts a container/CI ROLE as AWS credentials', () => {
    // An ECS task role or an EKS/GitLab web-identity role puts no key in the
    // environment. Without these three an entirely working role-based deployment
    // would be reported unconfigured and the assistant greyed out.
    const cases = [
      { AWS_ROLE_ARN: 'arn:aws:iam::1:role/app' },
      { AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token' },
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' },
    ];
    for (const role of cases) {
      const e = env({ ...role, AWS_REGION: 'us-east-1', ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6' });
      expect(resolveProvider(e)?.id).toBe('bedrock');
      expect(aiConfigured(e)).toBe(true);
    }
  });

  it('lets a DISTINCTIVE marker beat the generic AWS chain', () => {
    // A workspace id means Claude Platform on AWS even though its credentials are
    // AWS credentials — the generic family must not swallow the specific one.
    const e = env({ AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1', ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_01' });
    expect(resolveProvider(e)?.id).toBe('claude-aws');
  });

  it('lets Foundry and Vertex markers beat both generic families', () => {
    expect(
      resolveProvider(env({ ANTHROPIC_FOUNDRY_RESOURCE: 'res', AWS_PROFILE: 'dev', ANTHROPIC_API_KEY: 'sk' }))?.id,
    ).toBe('foundry');
    expect(
      resolveProvider(env({ ANTHROPIC_VERTEX_PROJECT_ID: 'proj', AWS_PROFILE: 'dev', ANTHROPIC_API_KEY: 'sk' }))?.id,
    ).toBe('vertex');
  });

  it('reads a bare Anthropic key as the Claude API, but only last', () => {
    expect(resolveProvider(env({ ANTHROPIC_API_KEY: 'sk-ant' }))?.id).toBe('anthropic');
    expect(resolveProvider(env({ ANTHROPIC_AUTH_TOKEN: 'bearer' }))?.id).toBe('anthropic');
    expect(resolveProvider(env({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }))?.id).toBe('anthropic');
    // ...and loses to any AWS credential, matching the historical default.
    expect(resolveProvider(env({ ANTHROPIC_API_KEY: 'sk-ant', AWS_PROFILE: 'dev' }))?.id).toBe('bedrock');
  });

  it('resolves NOTHING for an environment that says nothing about Claude', () => {
    expect(resolveProvider(env())).toBeNull();
    expect(resolveProvider({} as unknown as ClaudeEnv)).toBeNull();
    expect(aiConfigured(env())).toBe(false);
    expect(describeProvider(env())).toEqual({ id: null, label: 'none', configured: false, source: 'none' });
  });

  it('treats the EMPTY STRING as absent everywhere', () => {
    // This is the shipped `.env.example` state — `AWS_BEARER_TOKEN_BEDROCK=` with
    // nothing after it. A truthiness slip would advertise the AI to every user who
    // copied the example file and set no key.
    const blanks = {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      AWS_BEARER_TOKEN_BEDROCK: '',
      AWS_PROFILE: '',
      ANTHROPIC_VERTEX_PROJECT_ID: '',
      ANTHROPIC_FOUNDRY_RESOURCE: '',
      ANTHROPIC_AWS_WORKSPACE_ID: '',
    };
    expect(resolveProvider(env(blanks))).toBeNull();
    // Whitespace is not a value either — a key pasted as " " is a mistake, not a
    // credential, and reporting it as configured hides the mistake behind a 403.
    expect(resolveProvider(env({ ANTHROPIC_API_KEY: '   ' }))).toBeNull();
  });
});

describe('aiConfigured — per-provider completeness (the negative half)', () => {
  it('requires a model for EVERY provider', () => {
    // The CLI's built-in default drifts with its releases and may not be enabled in
    // the account, so an unpinned model is a configuration this workbench refuses
    // to advertise.
    for (const id of PROVIDER_IDS) {
      expect(aiConfigured(env({ ...COMPLETE[id], ANTHROPIC_MODEL: '' }))).toBe(false);
    }
  });

  it('rejects HALF an AWS access-key pair', () => {
    // A key id with no secret cannot sign anything.
    expect(aiConfigured(env({ ANTHROPIC_MODEL: 'm', AWS_REGION: 'r', AWS_ACCESS_KEY_ID: 'AKIA' }))).toBe(false);
    expect(aiConfigured(env({ ANTHROPIC_MODEL: 'm', AWS_REGION: 'r', AWS_SECRET_ACCESS_KEY: 'sec' }))).toBe(false);
  });

  it('rejects Bedrock without a region', () => {
    expect(aiConfigured(env({ ...COMPLETE.bedrock, AWS_REGION: '' }))).toBe(false);
  });

  it('rejects Claude Platform on AWS without a WORKSPACE ID', () => {
    // The provider sends it on every request and no AWS credential implies one, so
    // a missing workspace id is a guaranteed failure, not a maybe.
    const e = env({ ...COMPLETE['claude-aws'], CLAUDE_PROVIDER: 'claude-aws', ANTHROPIC_AWS_WORKSPACE_ID: '' });
    expect(aiConfigured(e)).toBe(false);
    expect(missingConfigHint(e)).toMatch(/ANTHROPIC_AWS_WORKSPACE_ID/);
  });

  it('accepts Claude Platform on AWS with SigV4 instead of a workspace API key', () => {
    const e = env({ ...COMPLETE['claude-aws'], ANTHROPIC_AWS_API_KEY: '', AWS_PROFILE: 'my-sso' });
    expect(aiConfigured(e)).toBe(true);
  });

  it('rejects Vertex without a project or without a region', () => {
    expect(aiConfigured(env({ ...COMPLETE.vertex, ANTHROPIC_VERTEX_PROJECT_ID: '' }))).toBe(false);
    expect(aiConfigured(env({ ...COMPLETE.vertex, CLOUD_ML_REGION: '' }))).toBe(false);
  });

  it('accepts Vertex with NO credential var — its credential is the ADC chain', () => {
    // gcloud's Application Default Credentials live in a file/metadata server the
    // backend cannot inspect. Requiring GOOGLE_APPLICATION_CREDENTIALS would grey
    // out a working `gcloud auth application-default login` setup.
    expect(aiConfigured(env({ ...COMPLETE.vertex, GOOGLE_APPLICATION_CREDENTIALS: '' }))).toBe(true);
  });

  it('rejects Foundry with no resource AND no base URL', () => {
    // The endpoint URL is built from the resource name; with neither there is
    // nothing to call.
    const e = env({ CLAUDE_PROVIDER: 'foundry', ANTHROPIC_MODEL: 'dep', ANTHROPIC_FOUNDRY_API_KEY: 'key' });
    expect(aiConfigured(e)).toBe(false);
    expect(missingConfigHint(e)).toMatch(/ANTHROPIC_FOUNDRY_RESOURCE/);
  });

  it('accepts Foundry on a base URL alone, and with an Entra ID sign-in for auth', () => {
    expect(
      aiConfigured(
        env({
          ANTHROPIC_MODEL: 'dep',
          ANTHROPIC_FOUNDRY_BASE_URL: 'https://res.services.ai.azure.com/anthropic',
          ANTHROPIC_FOUNDRY_API_KEY: '',
        }),
      ),
    ).toBe(true);
  });
});

describe('providerEnv — what the SDK subprocess is told', () => {
  it('writes EVERY routing flag, not just the selected one', () => {
    // The reason this matters: the backend inherits `process.env`, and a workbench
    // developer very plausibly has CLAUDE_CODE_USE_BEDROCK=1 exported for their own
    // Claude Code. Omitting the other flags would let that ambient value hijack a
    // Vertex deployment (Bedrock wins the CLI's precedence) and fail with a
    // credential error that names the wrong provider.
    const forwarded = providerEnv(env(COMPLETE.vertex));
    expect(forwarded).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
    });
  });

  it('turns every flag off for the Claude API, which has none of its own', () => {
    const forwarded = providerEnv(env(COMPLETE.anthropic));
    expect(forwarded).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
    });
  });

  it('forwards ONLY the selected provider\'s vars, so a stray key cannot travel', () => {
    // A Vertex deployment on a host that also has an AWS profile and an Anthropic
    // key exported: neither belongs in the child's environment for this call, and
    // forwarding them would only widen what a compromised subprocess could use.
    const forwarded = providerEnv(env({ ...COMPLETE.vertex, AWS_PROFILE: 'dev', ANTHROPIC_API_KEY: 'sk-ant' }));
    expect(forwarded.ANTHROPIC_VERTEX_PROJECT_ID).toBe('my-gcp-project');
    expect('AWS_PROFILE' in forwarded).toBe(false);
    expect('ANTHROPIC_API_KEY' in forwarded).toBe(false);
  });

  it('OMITS empty vars rather than forwarding a blank that ERASES an ambient value', () => {
    // Vertex and Foundry depend on this: their real credential (ADC / the Entra
    // chain) is resolved inside the subprocess from files and metadata servers, and
    // an explicit empty GOOGLE_APPLICATION_CREDENTIALS could break that resolution
    // rather than leave it alone.
    const forwarded = providerEnv(env({ ...COMPLETE.vertex, GOOGLE_APPLICATION_CREDENTIALS: '' }));
    expect('GOOGLE_APPLICATION_CREDENTIALS' in forwarded).toBe(false);
  });

  it('carries the model, whose FORM differs per provider', () => {
    expect(providerEnv(env(COMPLETE.bedrock)).ANTHROPIC_MODEL).toBe('us.anthropic.claude-sonnet-4-6');
    // On Foundry the value is the Azure deployment name, not a Claude model id.
    expect(providerEnv(env(COMPLETE.foundry)).ANTHROPIC_MODEL).toBe('my-sonnet-deployment');
  });

  it('forwards each provider\'s base-URL override (LLM gateway / custom endpoint)', () => {
    const cases: Array<[string, Partial<Record<string, unknown>>, string]> = [
      ['anthropic', COMPLETE.anthropic, 'ANTHROPIC_BASE_URL'],
      ['bedrock', COMPLETE.bedrock, 'ANTHROPIC_BEDROCK_BASE_URL'],
      ['claude-aws', COMPLETE['claude-aws'], 'ANTHROPIC_AWS_BASE_URL'],
      ['vertex', COMPLETE.vertex, 'ANTHROPIC_VERTEX_BASE_URL'],
      ['foundry', COMPLETE.foundry, 'ANTHROPIC_FOUNDRY_BASE_URL'],
    ];
    for (const [, complete, key] of cases) {
      const forwarded = providerEnv(env({ ...complete, [key]: 'https://gateway.example.com' }));
      expect(forwarded[key]).toBe('https://gateway.example.com');
    }
  });

  it('forwards nothing but the four off-switches when nothing is configured', () => {
    const forwarded = providerEnv(env());
    expect(Object.values(forwarded)).toEqual(['0', '0', '0', '0']);
  });
});

describe('describeProvider — how the answer is reported', () => {
  it('names the provider and how it was chosen', () => {
    expect(describeProvider(env({ ...COMPLETE.bedrock, CLAUDE_PROVIDER: 'bedrock' }))).toEqual({
      id: 'bedrock',
      label: 'Amazon Bedrock',
      configured: true,
      source: 'explicit',
    });
    expect(describeProvider(env({ ...COMPLETE.foundry, CLAUDE_CODE_USE_FOUNDRY: true })).source).toBe('routing-flag');
    expect(describeProvider(env(COMPLETE.anthropic)).source).toBe('detected');
  });

  it('reports an INCOMPLETE provider as resolved-but-unconfigured', () => {
    // "Which provider" and "is it usable" are separate answers; collapsing them
    // would leave the health endpoint unable to say WHERE the probe was aimed.
    const status = describeProvider(env({ CLAUDE_PROVIDER: 'vertex' }));
    expect(status).toMatchObject({ id: 'vertex', configured: false, source: 'explicit' });
  });

  it('exposes no credential material in any provider status or hint', () => {
    // Both ride to the browser (GET /ai-health), so a value from the environment
    // must never appear in either.
    for (const id of PROVIDER_IDS) {
      const e = env(COMPLETE[id]);
      const text = JSON.stringify(describeProvider(e)) + missingConfigHint(e);
      expect(text).not.toMatch(/sk-ant-xxx|bedrock-key|azure-key|sk-ant-aws-xxx|wrkspc_01ABCDEFGHIJKLMN/);
    }
  });
});
