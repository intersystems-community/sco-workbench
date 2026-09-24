/**
 * The "Learn the concepts" starter questions on the Analytics Cube intro page.
 *
 * A cube is the vocabulary-heaviest feature in the Workbench (dimension, hierarchy,
 * level, member, measure, source class, MDX), and a user who doesn't hold those
 * terms can read the Overview and still not know what to build. These five
 * questions are the shortest path through that vocabulary: clicking one hands it to
 * the AI Assistant (see `askConceptQuestion` in bi-cubes.ts), which teaches it
 * against the cubes actually on the instance rather than in the abstract.
 *
 * Kept as data, in its own file, so the wording can be edited without touching the
 * component, and so the set stays reviewable as a curriculum: the five together
 * should cover every term the create form asks the user for.
 */

/** One clickable starter question. */
export interface CubeIntroQuestion {
  /** Stable id: the ngFor track key, and what a test refers to. */
  id: string;
  /**
   * What the user reads and clicks; also the chat bubble text. Each stands on its
   * own, since nothing else is rendered beside it. Plain punctuation only, no em
   * dashes, matching the rest of the page's copy.
   */
  question: string;
  /**
   * The concepts the answer should unpack. PROMPT INPUT ONLY, never rendered: it
   * steers the assistant toward the terms the create form will ask the user for,
   * which the question alone doesn't always name. Keeping it here also lets a test
   * check the five questions cover the whole vocabulary.
   */
  concepts: string;
}

/**
 * Deliberately ordered as a path, not a glossary: what a cube IS and why it matters
 * for supply chain analytics, then how it's structured (dimensions to members), then
 * the numbers in it, then where its data comes from, and finally how it's queried
 * downstream. Read top to bottom they answer "what would I build, and why".
 */
export const CUBE_INTRO_QUESTIONS: readonly CubeIntroQuestion[] = [
  {
    id: 'what-is-a-cube',
    question: 'What is an analytics cube in SCO, and why is it the building block for supply chain analytics?',
    concepts: 'cube, fact table, why aggregate instead of query records',
  },
  {
    id: 'dimensions-and-levels',
    question: 'What are dimensions, hierarchies, levels and members, and how do they fit together?',
    concepts: 'dimension, hierarchy, level, member, drill-down',
  },
  {
    id: 'measures',
    question: 'What is a measure, and how do I pick the right aggregate for a supply chain metric?',
    concepts: 'measure, aggregate (SUM/COUNT/AVG), %COUNT',
  },
  {
    id: 'source-class',
    question: 'What does the source class do, and how does a cube stay in step with my SCO data?',
    concepts: 'source class, source property vs expression, compile and build',
  },
  {
    id: 'mdx-and-downstream',
    question: 'What is MDX, and how do dashboards and KPIs use the cubes I define here?',
    concepts: 'MDX, dashboard tiles, Business KPIs',
  },
];

/**
 * The prompt actually SENT for a question. The visible bubble stays the question
 * itself; this adds the framing that keeps the answer grounded: SCO's own terms and
 * the cubes on this instance, one worked example, and no side effects, since the
 * user clicked to LEARN and not to have a cube built for them.
 */
export function cubeQuestionPrompt(q: CubeIntroQuestion): string {
  return [
    q.question,
    '',
    'Context: I clicked this question on the Analytics Cube page to learn the concept.',
    `Please explain it in the context of Supply Chain Orchestrator specifically (covering: ${q.concepts}),`,
    'using one of the cubes on this instance as a worked example where that helps.',
    'Keep it short enough to read in one go. Do not change anything in the UI or in SCO,',
    'since I am asking to understand, not to build yet.',
  ].join('\n');
}
