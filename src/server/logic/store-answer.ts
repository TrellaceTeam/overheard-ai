/**
 * Everything the worker persists about one task. The worker owns the provider
 * call; this module owns the write, so the status machine lives in one place.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import type { AnswerResult, ExtractionResult } from "./types";
import type { FailureCode } from "@/lib/failure-codes";

/** Longer than any provider returns, and short enough to keep a row readable. */
const ANSWER_LIMIT = 100_000;

/**
 * 2^attempts * 15 seconds plus up to 10 seconds of jitter. `attempts` is the
 * value read off the claimed row, which the claim already incremented, so the
 * one automatic retry waits about 30 s. Exported because the worker computes
 * the gate and this module writes it.
 */
export function backoffAt(attempts: number, now: Date = new Date()): string {
  const seconds = 2 ** attempts * 15 + Math.random() * 10;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/**
 * in_flight to answered, in one UPDATE that also clears the lock and the error
 * and resets attempts to 0. The reset gives extraction its own
 * MAX_TASK_ATTEMPTS. Without it a task that retried its answer reaches
 * extraction with no attempts left and throws away an answer already paid for.
 */
export function storeAnswer(db: Driver, taskId: string, result: AnswerResult): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE run_tasks
        SET status = 'answered',
            answer_text = ?,
            answer_tokens = ?,
            latency_ms = ?,
            provider_cost_usd = ?,
            answer_model = ?,
            error = NULL,
            failure_code = NULL,
            locked_at = NULL,
            locked_by = NULL,
            next_attempt_at = ?,
            attempts = 0
      WHERE id = ?`,
  ).run(
    result.answerText.slice(0, ANSWER_LIMIT),
    result.answerTokens,
    result.latencyMs,
    result.providerCostUsd,
    result.answerModel ?? null,
    now,
    taskId,
  );
}

/**
 * extracting to done, writing the `extractions` row and its `brand_observations`
 * in one transaction. Writes no observations for a perception task; the database
 * trigger refuses them.
 */
export function storeExtraction(db: Driver, taskId: string, result: ExtractionResult): void {
  const task = db
    .prepare("SELECT run_id, project_id, is_perception FROM run_tasks WHERE id = ?")
    .get<{ run_id: string; project_id: string; is_perception: number }>(taskId);
  if (!task) throw new Error(`TASK_NOT_FOUND: no run task ${taskId}`);

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO extractions
         (id, run_task_id, project_id, answer_format, total_items, raw_json, model_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_task_id) DO UPDATE SET
         answer_format = excluded.answer_format,
         total_items = excluded.total_items,
         raw_json = excluded.raw_json,
         model_used = excluded.model_used`,
    ).run(
      randomUUID(),
      taskId,
      task.project_id,
      result.answerFormat,
      result.totalItems,
      JSON.stringify(result.rawJson ?? null),
      result.modelUsed,
      now,
    );

    // Re-extraction must not double count, so the previous observations go first.
    db.prepare("DELETE FROM brand_observations WHERE run_task_id = ?").run(taskId);

    if (task.is_perception === 0) {
      const insert = db.prepare(
        `INSERT INTO brand_observations
           (id, run_task_id, run_id, project_id, brand_id, raw_name, position, total_items,
            mention_type, linked_url, is_cited, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const observation of result.observations) {
        insert.run(
          randomUUID(),
          taskId,
          task.run_id,
          task.project_id,
          observation.brandId,
          observation.rawName,
          observation.position,
          observation.totalItems,
          observation.mentionType,
          observation.linkedUrl,
          observation.isCited ? 1 : 0,
          observation.evidence,
          now,
        );
      }
    }

    db.prepare(
      "UPDATE run_tasks SET status = 'done', error = NULL, failure_code = NULL, locked_at = NULL, locked_by = NULL WHERE id = ?",
    ).run(taskId);
  });
}

/** Any non-terminal status to failed, on a non-retryable error. */
export function failTask(db: Driver, taskId: string, code: FailureCode, detail: string): void {
  db.prepare(
    `UPDATE run_tasks
        SET status = 'failed', error = ?, failure_code = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ? AND status NOT IN ('done','failed')`,
  ).run(detail, code, taskId);
}

/**
 * Returns a task to its pre-claim status with a backoff gate: in_flight to
 * queued, extracting to answered. Never in_flight to answered. The worker
 * passes backoffAt() as `nextAttemptAt`.
 */
export function releaseTaskForRetry(
  db: Driver,
  taskId: string,
  code: FailureCode,
  detail: string,
  nextAttemptAt: string,
): void {
  db.prepare(
    `UPDATE run_tasks
        SET status = CASE
              WHEN status = 'in_flight' THEN 'queued'
              WHEN status = 'extracting' THEN 'answered'
              ELSE status END,
            error = ?,
            failure_code = ?,
            locked_at = NULL,
            locked_by = NULL,
            next_attempt_at = ?
      WHERE id = ?`,
  ).run(detail, code, nextAttemptAt, taskId);
}
