/**
 * Putting a run's failed tasks back in the queue, in the same run, so recovered
 * answers join the numbers they belong to instead of arriving as a separate run
 * with its own denominators.
 */
import type { Driver } from "../db/driver";
import { updateRunProgress } from "./update-run-progress";

/**
 * SQLite trim() strips spaces only by default, which would treat a
 * newline-only answer as worth re-scoring. The extractor raises on one, and
 * the task would spend both attempts finding that out, so the characters are
 * named.
 */
const BLANK = "' ' || char(9) || char(10) || char(13)";

/**
 * A failed task that already holds a non-blank answer goes back to `answered`,
 * so only the extraction call is bought again. One without goes back to
 * `queued`. Resets attempts to 0, clears the lock and the backoff gate, then
 * refreshes the run progress. Returns tasks requeued.
 *
 * The last failure reason stays, as it does on an automatic retry, because the
 * worker keys off it: Gemini's no-search retry pressure and the raised timeout
 * both read the reason from the claimed row.
 */
export function retryFailedTasks(db: Driver, runId: string): number {
  const run = db
    .prepare("SELECT id, status FROM runs WHERE id = ?")
    .get<{ id: string; status: string }>(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: no run ${runId}`);

  // `cancelled` is sticky, so updateRunProgress leaves the run where it is, and
  // the claimer only takes tasks from a run that is queued or running. A
  // requeue here would report success, empty the failure list and move
  // nothing. A cancel leaves failed tasks, so the run page still offers Retry
  // on a cancelled run, and this refusal is what that button gets.
  if (run.status === "cancelled") {
    throw new Error(
      "RUN_CANCELLED: this run was stopped, so its calls cannot be retried. Start a new run.",
    );
  }

  const now = new Date().toISOString();

  return db.transaction(() => {
    const requeued = db
      .prepare(
        `UPDATE run_tasks
          SET status = CASE
                WHEN answer_text IS NOT NULL AND trim(answer_text, ${BLANK}) <> '' THEN 'answered'
                ELSE 'queued' END,
              attempts = 0,
              locked_at = NULL,
              locked_by = NULL,
              next_attempt_at = ?
        WHERE run_id = ? AND status = 'failed'`,
      )
      .run(now, runId).changes;

    // Puts the run back to running and re-counts, so the screen stops saying the
    // run finished with failures the moment the retry is queued.
    updateRunProgress(db, runId);
    return requeued;
  });
}
