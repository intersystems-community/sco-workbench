import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { QuestionBroker, AskQuestion } from '../server/question.js';
import { ok, fail, guard } from './result.js';

/**
 * The `ask_user_question` tool. When the agent needs the user to make a choice
 * or supply a required input, it calls this instead of writing the question as
 * plain chat text. The call blocks on the QuestionBroker, which drives a tabbed
 * popup in the UI (one tab per question) and returns the user's selections.
 *
 * Structured questions beat free-text prompts here for the same reason the
 * confirmation gate does: the UI can render real choices, the answer comes back
 * in a predictable shape, and there's no dead "waiting for a yes" turn.
 */
export function askTools(broker: QuestionBroker) {
  const ask = tool(
    'ask_user_question',
    [
      'Ask the user one or more multiple-choice questions and wait for their answer.',
      'Use this whenever you need the user to choose between options or supply a required input you cannot safely infer —',
      'e.g. which source/target class to use, which inbound adapter, which of several ambiguous matches they meant,',
      'or a yes/no decision that changes what you do next. Prefer this over asking in plain text: the UI renders a',
      'popup (a tab per question) and the user can pick an option or type their own. The user can always type a custom',
      'answer, so you do not need an "Other" option. Keep questions to at most 4, each with 2-4 concrete options.',
      'Do NOT use this for state-changing SCO actions (compile, build, add config item) — those are confirmed automatically.',
    ].join(' '),
    {
      questions: z
        .array(
          z.object({
            question: z.string().describe('The full question to ask.'),
            header: z
              .string()
              .describe('A very short tab label (≤12 chars), e.g. "Adapter", "Source class".'),
            options: z
              .array(
                z.object({
                  label: z.string().describe('Short option label the user will click.'),
                  description: z
                    .string()
                    .optional()
                    .describe('Optional one-line explanation of what this choice means.'),
                }),
              )
              .min(2)
              .max(4)
              .describe('2-4 distinct choices. The UI always also lets the user type their own.'),
            multiSelect: z
              .boolean()
              .optional()
              .describe('Set true to let the user pick multiple options instead of one.'),
          }),
        )
        .min(1)
        .max(4)
        .describe('1-4 questions; each becomes a tab in the popup.'),
    },
    async ({ questions }) =>
      guard(async () => {
        const answers = await broker.ask(questions as AskQuestion[]);
        if (answers === null) {
          return fail('The user did not answer (the turn was cancelled).');
        }
        // Return the answers keyed by each question's header so the agent can
        // read exactly what was chosen.
        return ok({ answers });
      }),
    { annotations: { title: 'Ask the user', readOnlyHint: true } },
  );

  return [ask];
}
