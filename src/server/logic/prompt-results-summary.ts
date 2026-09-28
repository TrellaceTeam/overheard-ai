/**
 * Storing and reading prompt results summaries: the on-demand paragraph that
 * says what the assistants have answered to one prompt across every run.
 *
 * The product rule is one summary per prompt, so asking again replaces the row
 * rather than adding a history nobody can see. Writing goes through here, not
 * through the API layer, like every other write.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";

export interface PromptResultsSummaryInput {
  projectId: string;
  promptId: string;
  summary: string;
  /** Answers the summary read: the newest runs that fit the budget. */
  answerCount: number;
  /** The runs those answers came from. */
  runCount: number;
  /** Answers the prompt had when the summary was written, read or not. */
  totalAnswers: number;
  /** The catalogue row of the model that wrote it, for the price columns. */
  modelId: string | null;
  costUsd: number;
  /**
   * When the answers were read, not when the reply came back: the moment the
   * summary describes. A run that finishes during the call finishes after this,
   * so it marks the summary outdated instead of passing for read.
   */
  createdAt: string;
}

export type PromptResultsSummaryRow = PromptResultsSummaryInput;

/** Insert, or replace the summary this prompt already had. */
export function savePromptResultsSummary(db: Driver, input: PromptResultsSummaryInput): void {
  db.prepare(
    `INSERT INTO prompt_summaries
       (id, project_id, prompt_id, summary, answer_count, run_count, total_answers,
        model_id, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (prompt_id) DO UPDATE SET
       summary = excluded.summary,
       answer_count = excluded.answer_count,
       run_count = excluded.run_count,
       total_answers = excluded.total_answers,
       model_id = excluded.model_id,
       cost_usd = excluded.cost_usd,
       created_at = excluded.created_at`,
  ).run(
    randomUUID(),
    input.projectId,
    input.promptId,
    input.summary,
    input.answerCount,
    input.runCount,
    input.totalAnswers,
    input.modelId,
    input.costUsd,
    input.createdAt,
  );
}

/**
 * Forget a prompt's summary. For a rewording: a prompt's text can change only
 * once it has no answers left, and a paragraph about the old words must not
 * come back under the new ones when answers arrive again.
 */
export function deletePromptResultsSummary(db: Driver, promptId: string): void {
  db.prepare("DELETE FROM prompt_summaries WHERE prompt_id = ?").run(promptId);
}

/** Every summary a project holds, one row per prompt that has been summarized. */
export function readPromptResultsSummaries(
  db: Driver,
  projectId: string,
): PromptResultsSummaryRow[] {
  return db
    .prepare(
      `SELECT project_id AS projectId, prompt_id AS promptId, summary,
              answer_count AS answerCount, run_count AS runCount,
              total_answers AS totalAnswers, model_id AS modelId,
              cost_usd AS costUsd, created_at AS createdAt
         FROM prompt_summaries
        WHERE project_id = ?
        ORDER BY created_at, id`,
    )
    .all<PromptResultsSummaryRow>(projectId);
}
