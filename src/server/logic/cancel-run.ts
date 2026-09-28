/**
 * Stopping a run.
 *
 * Only claimable tasks are touched, so nothing already with a provider is
 * disturbed: a task that is in_flight or extracting finishes its current call
 * and its answer is persisted. The worker then claims nothing more, because it
 * never claims a task whose run is not queued or running. The recovery sweep
 * closes any answer that lands after the cancel.
 */
import type { Driver } from "../db/driver";
import { updateRunProgress } from "./update-run-progress";
import { failureCode, type FailureCode } from "@/lib/failure-codes";

/**
 * Written into every stopped task's `error` column. classifyFailure in
 * @/lib/failure-reasons reads the prefix on a row with no failure_code; text
 * it cannot classify falls through to "We could not classify this failure".
 */
export const CANCEL_ERROR = "CANCELLED_BY_USER: stopped from the run page.";

/** The typed code stored beside CANCEL_ERROR. */
export const CANCEL_CODE: FailureCode = failureCode("CANCELLED_BY_USER");

/**
 * Sets the run to `cancelled` and fails every queued and answered task with
 * CANCEL_ERROR. Returns the number of tasks stopped. The cancelled status
 * is sticky: updateRunProgress will not move the run out of it.
 */
export function cancelRun(db: Driver, runId: string): number {
  const run = db.prepare("SELECT id FROM runs WHERE id = ?").get<{ id: string }>(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: no run ${runId}`);

  return db.transaction(() => {
    // The run is marked first so the progress refresh below sees the sticky arm
    // and cannot reclassify the run as partial or failed on the way out.
    db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(runId);

    const stopped = db
      .prepare(
        `UPDATE run_tasks
          SET status = 'failed', error = ?, failure_code = ?, locked_at = NULL, locked_by = NULL
        WHERE run_id = ? AND status IN ('queued','answered')`,
      )
      .run(CANCEL_ERROR, CANCEL_CODE, runId).changes;

    updateRunProgress(db, runId);
    return stopped;
  });
}
