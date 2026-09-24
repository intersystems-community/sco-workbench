import { buildDeployPrompt } from './deploy-prompt';
import type { IntegrationJob } from './data-integration';
import lockstep from '../../../../ci/deploy-prompt-lockstep.json' with { type: 'json' };

// Lockstep guard: the Deploy button's prompt MUST match the backend twin the
// live-source tier sends through a real agent turn
// (backend/test/live-source/helpers/deploy-prompt.ts).
// backend/test/unit/deploy-prompt-lockstep.test.ts asserts the same fixture
// (ci/deploy-prompt-lockstep.json), so if either implementation drifts, one of the
// two suites goes red. The CONTRACT is shared, not the code — the two workspaces
// build under separate tsconfigs.
describe('buildDeployPrompt — the Deploy button\'s agent prompt', () => {
  const classNameByObject = lockstep.classNameByObject as Record<string, string>;

  it('has a case per adapter', () => {
    expect(lockstep.cases.length).toBe(4);
  });

  for (const c of lockstep.cases) {
    it(`matches the shared fixture: ${c.name}`, () => {
      const prompt = buildDeployPrompt(c.job as unknown as IntegrationJob, classNameByObject);
      expect(prompt.split('\n')).toEqual(c.promptLines);
    });
  }

  it('resolves the target class to its IRIS FQN, and drops unmapped columns', () => {
    const sftp = lockstep.cases[0]!;
    const prompt = buildDeployPrompt(sftp.job as unknown as IntegrationJob, classNameByObject);
    expect(prompt).toContain('"targetClass": "SC.Data.Sales"');
    // The fixture's `Ignored` column has no Target Property, so it produces nothing.
    expect(prompt).not.toContain('Ignored');
  });
});
