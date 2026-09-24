// backend/test/unit/data-model-description-charset.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SC-2647: SCO's `scmodel` API validates an object/attribute **description** against
 * an allow-list and rejects anything else with a bare `400 "Invalid description"` —
 * no indication of which character is at fault. A dash, a colon and a percent sign
 * are all rejected, and AI-generated descriptions reach for them constantly
 * ("out-of-stock", "1-5 rating", "90% target"), so the create fails on the user.
 *
 * Until SCO widens the allow-list, the data-model skill is what keeps the assistant
 * inside it. These pins hold that guidance in place: the skill must state the rule,
 * and — the part that silently rots — every description the skill DEMONSTRATES must
 * itself be one SCO would accept. A worked example is what the model copies.
 */

/** The server-side allow-list, verbatim from `ValidateDescription()` (SC-2647). */
const SCO_DESCRIPTION_ALLOWED = /^[\d\p{L},."?!()/;#' &]*$/u;

const skillDir = fileURLToPath(new URL('../../.claude/skills/data-model/', import.meta.url));
const read = (rel: string): string => readFileSync(skillDir + rel, 'utf8');

const objectDefinition = read('references/object-definition.md');
const guidedWorkflow = read('references/guided-workflow.md');
const agentWorkflow = read('references/agent-workflow.md');
const skill = read('SKILL.md');

/**
 * The quoted/backticked description literals inside the doc's "Worked example"
 * sections — the strings the assistant will pattern-match on. Only those sections:
 * the rewrite table deliberately shows rejected forms in its "Don't write" column.
 */
function workedExampleDescriptions(): string[] {
  const sections = objectDefinition
    .split(/^## /m)
    .filter((s) => s.startsWith('Worked example'));
  expect(sections).toHaveLength(2); // one per example; a rename must not silently skip them
  const found: string[] = [];
  for (const section of sections) {
    // `description: \`…\`` (the object's own) and `"…"` (an attribute's).
    for (const m of section.matchAll(/description: `([^`]+)`/g)) found.push(m[1]!);
    for (const m of section.matchAll(/"([^"]+)"/g)) found.push(m[1]!);
  }
  return found;
}

describe('data-model skill — descriptions SCO will accept (SC-2647)', () => {
  it('states the allow-list, and names the three characters that actually bite', () => {
    const charset = objectDefinition.split('## Descriptions')[1]?.split('\n## ')[0] ?? '';
    expect(charset, 'object-definition.md must carry a description-characters section').not.toBe('');
    // The rule itself, plus the rejected characters that show up in ordinary prose.
    expect(charset).toMatch(/letters, digits, spaces/);
    for (const ch of ['-', ':', '%']) {
      expect(charset, `the guidance must call out "${ch}"`).toContain(ch);
    }
    // And the ticket, so the next reader can check whether it's still true.
    expect(charset).toContain('SC-2647');
  });

  it('tells the assistant to write within the set up front, not to fix it after a 400', () => {
    expect(objectDefinition).toMatch(/write every description you generate inside that set/i);
    // Both mode workflows must carry the rule where descriptions are actually written,
    // and the router must point at it — a reference file nobody is sent to is dead text.
    expect(guidedWorkflow).toMatch(/description/i);
    expect(guidedWorkflow).toMatch(/Invalid description/);
    expect(agentWorkflow).toMatch(/Invalid description/);
    expect(skill).toMatch(/characters SCO accepts in a description/);
  });

  it('never demonstrates a description SCO would reject', () => {
    const descriptions = workedExampleDescriptions();
    expect(descriptions.length).toBeGreaterThan(3);
    for (const d of descriptions) {
      expect(SCO_DESCRIPTION_ALLOWED.test(d), `worked example description would 400: "${d}"`).toBe(true);
    }
  });

  it('pins the regex these pins are written against', () => {
    // Guards the test itself: if this drifts from SCO's validator the pins above are
    // measuring the wrong thing. Accepted / rejected samples straight from SC-2647.
    expect(SCO_DESCRIPTION_ALLOWED.test('Tracks items (per SKU); rating? yes! & more #1 / done.')).toBe(true);
    expect(SCO_DESCRIPTION_ALLOWED.test('Foreign key to Supplier')).toBe(true);
    for (const rejected of ['out-of-stock', '90% target', 'note: hi', 'a_b', 'a\nb']) {
      expect(SCO_DESCRIPTION_ALLOWED.test(rejected), `${rejected} must be rejected`).toBe(false);
    }
  });
});
