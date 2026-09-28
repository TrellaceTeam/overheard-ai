/**
 * Storing and reading one answer summary: the on-demand paragraph that says
 * what the assistants answered to one prompt in one run.
 *
 * The product rule is one summary per (run, prompt), so asking again replaces
 * the row rather than adding a history nobody can see. Writing goes through
 * here, not through the API layer, like every other write.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";

export interface AnswerSummaryInput {
  runId: string;
  projectId: string;
  promptId: string;
  summary: string;
  answerCount: number;
  /** The catalogue row of the model that wrote it, for the price columns. */
  modelId: string | null;
  costUsd: number;
}

export interface AnswerSummaryRow extends AnswerSummaryInput {
  createdAt: string;
}

/** Insert, or replace the summary this (run, prompt) already had. */
export function saveAnswerSummary(db: Driver, input: AnswerSummaryInput): void {
  db.prepare(
    `INSERT INTO answer_summaries
       (id, run_id, project_id, prompt_id, summary, answer_count, model_id, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, prompt_id) DO UPDATE SET
       summary = excluded.summary,
       answer_count = excluded.answer_count,
       model_id = excluded.model_id,
       cost_usd = excluded.cost_usd,
       created_at = excluded.created_at`,
  ).run(
    randomUUID(),
    input.runId,
    input.projectId,
    input.promptId,
    input.summary,
    input.answerCount,
    input.modelId,
    input.costUsd,
    new Date().toISOString(),
  );
}

/** Every summary a run holds, one row per prompt that has been summarized. */
export function listAnswerSummaries(db: Driver, runId: string): AnswerSummaryRow[] {
  return db
    .prepare(
      `SELECT run_id AS runId, project_id AS projectId, prompt_id AS promptId,
              summary, answer_count AS answerCount, model_id AS modelId,
              cost_usd AS costUsd, created_at AS createdAt
         FROM answer_summaries
        WHERE run_id = ?
        ORDER BY created_at, id`,
    )
    .all<AnswerSummaryRow>(runId);
}
