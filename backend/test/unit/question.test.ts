import { describe, it, expect } from 'vitest';
import { QuestionBroker, type AskRequest } from '../../src/server/question.js';

const sampleQuestions = [
  {
    question: 'Which source class?',
    header: 'Source',
    options: [{ label: 'SC.Data.Customer' }, { label: 'SC.Data.SalesOrder' }],
  },
];

describe('QuestionBroker', () => {
  it('emits a request and resolves with the user answers', async () => {
    let emitted: AskRequest | undefined;
    const broker = new QuestionBroker((r) => (emitted = r));
    const p = broker.ask(sampleQuestions);
    expect(emitted).toBeDefined();
    expect(emitted!.questions).toHaveLength(1);
    expect(broker.outstanding).toBe(1);

    const answers = { Source: { selected: ['SC.Data.Customer'] } };
    broker.resolveAnswers(emitted!.askId, answers);
    await expect(p).resolves.toEqual(answers);
    expect(broker.outstanding).toBe(0);
  });

  it('resolveAnswers returns false for an unknown id', () => {
    const broker = new QuestionBroker(() => {});
    expect(broker.resolveAnswers('missing', {})).toBe(false);
  });

  it('cancelAll resolves outstanding asks with null (turn aborted)', async () => {
    const broker = new QuestionBroker(() => {});
    const p = broker.ask(sampleQuestions);
    broker.cancelAll();
    await expect(p).resolves.toBeNull();
    expect(broker.outstanding).toBe(0);
  });

  it('cancel(askId) resolves that ask with null (user dismissed the popup)', async () => {
    let emitted: AskRequest | undefined;
    const broker = new QuestionBroker((r) => (emitted = r));
    const p = broker.ask(sampleQuestions);
    expect(broker.cancel(emitted!.askId)).toBe(true);
    await expect(p).resolves.toBeNull();
    expect(broker.outstanding).toBe(0);
  });

  it('cancel returns false for an unknown id', () => {
    const broker = new QuestionBroker(() => {});
    expect(broker.cancel('missing')).toBe(false);
  });
});
