/**
 * The facts a prompt results summary shares between the server, which plans
 * what it reads, and the fold that tells the reader: the budget and how the
 * runs it read are named. One place, so the info button cannot quote a budget
 * the planner does not use.
 */

/**
 * What one summary may read, in characters of answer text: about 100,000
 * tokens, which fits the smallest context window in the catalogue with room to
 * answer. No other cap applies: short answers let more runs in, long ones fewer.
 */
export const FEED_BUDGET_CHARS = 400_000;

/** How many runs and answers a summary reads, of how many the prompt has. */
export interface FeedCounts {
  runCount: number;
  answerCount: number;
  totalAnswers: number;
}

/** "the last run" or "the last 3 runs", the way the disclosure and the writer's prompt both say it. */
export function lastRuns(runCount: number): string {
  return runCount === 1 ? "the last run" : `the last ${runCount} runs`;
}
