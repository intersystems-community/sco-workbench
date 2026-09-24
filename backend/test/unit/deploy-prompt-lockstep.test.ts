// backend/test/unit/deploy-prompt-lockstep.test.ts
import { describe, it, expect } from 'vitest';
import { buildDeployPrompt, type WizardJob } from '../live-source/helpers/deploy-prompt.js';
import lockstep from '../../../ci/deploy-prompt-lockstep.json' with { type: 'json' };

// Lockstep guard: the live-source tier's deploy prompt MUST be the one the wizard's
// Deploy button builds (frontend/src/app/data-integration/deploy-prompt.ts).
// frontend/src/app/data-integration/deploy-prompt.spec.ts asserts the same fixture
// (ci/deploy-prompt-lockstep.json), so if either implementation drifts, one of the
// two suites goes red. The CONTRACT is shared (the fixture); the code is not,
// because the two workspaces build under separate tsconfigs.
describe('deploy prompt — backend twin of the wizard Deploy button', () => {
  const classNameByObject = lockstep.classNameByObject as Record<string, string>;

  it('has a case per adapter', () => {
    expect(lockstep.cases).toHaveLength(4);
  });

  for (const c of lockstep.cases) {
    it(`matches the shared fixture: ${c.name}`, () => {
      const prompt = buildDeployPrompt(c.job as unknown as WizardJob, classNameByObject);
      expect(prompt.split('\n')).toEqual(c.promptLines);
    });
  }

  it('never puts a raw username or password in the prompt', () => {
    // The wizard creates the IRIS Credentials entry BEFORE the agent turn, so the
    // payload carries only the entry NAME. A prompt that carried the secret would
    // put it in the chat transcript and the SDK session.
    for (const c of lockstep.cases) {
      const prompt = buildDeployPrompt(c.job as unknown as WizardJob, classNameByObject);
      expect(prompt).not.toMatch(/"(dbPassword|dbUsername|ftpPassword|ftpUsername)"/);
    }
  });
});
