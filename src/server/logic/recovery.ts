/**
 * Getting the queue back to a consistent state after a crash or a long stall.
 *
 * An `extracting` task always returns to `answered`, never to `queued`: its
 * answer has already been bought and requeuing it would pay for the answer
 * twice.
 */
import type { Driver } from "../db/driver";
import type { RecoverySummary } from "./types";
import { STUCK_LOCK_MS } from "./types";
import { failExhaustedTasks } from "./claim-tasks";
import { CANCEL_CODE, CANCEL_ERROR } from "./cancel-run";
import { updateRunProgress } from "./update-run-progress";

const RELEASE_IN_FLIGHT = `
  UPDATE run_tasks SET status = 'queued', locked_at = NULL, locked_by = NULL
   WHERE status = 'in_flight'`;

const RELEASE_EXTRACTING = `
  UPDATE run_tasks SET status = 'answered', locked_at = NULL, locked_by = NULL
   WHERE status = 'extracting'`;

/** A lock is stale when it is older than the window, or when there is none. */
const STALE = " AND (locked_at IS NULL OR locked_at < ?)";

/**
 * Closes tasks left claimable on a run the user stopped.
 *
 * cancelRun fails what is queued or answered when it runs, and leaves a task
 * already talking to a provider alone so the answer is kept. When that answer
 * lands, storeAnswer moves the task to `answered` with attempts back at 0.
 * Nothing else moves it from there: the claimer skips a cancelled run, the
 * exhaustion sweep needs spent attempts, and the lock release only touches
 * in_flight and extracting rows. Left open, the run's pending count never
 * reaches zero and the run is never scored.
 */
const CLOSE_CANCELLED = `
   UPDATE run_tasks
      SET status = 'failed', error = ?, failure_code = ?, locked_at = NULL, locked_by = NULL
    WHERE status IN ('queued','answered')
      AND run_id IN (SELECT id FROM runs WHERE status = 'cancelled')
RETURNING run_id`;

/**
 * Failing a task outside a claim changes its run's counts, and no pass will
 * recount a run it did not claim from, so the sweep recounts every run it
 * failed a task in before it commits.
 */
function sweep(db: Driver, cutoff: string | null): RecoverySummary {
  return db.immediateTransaction(() => {
    const requeued =
      cutoff === null
        ? db.prepare(RELEASE_IN_FLIGHT).run().changes
        : db.prepare(RELEASE_IN_FLIGHT + STALE).run(cutoff).changes;
    const returnedToAnswered =
      cutoff === null
        ? db.prepare(RELEASE_EXTRACTING).run().changes
        : db.prepare(RELEASE_EXTRACTING + STALE).run(cutoff).changes;

    // Order matters: release first, so an abandoned claim is back in a claimable
    // status and is seen by the exhaustion sweep, then close out what is spent.
    const exhaustedRuns = failExhaustedTasks(db);

    // Then close anything claimable that belongs to a run the user stopped. It
    // is not counted in the summary: these tasks are already visible as the
    // run's failed calls, and the boot line reports recovery, not cancellation.
    const closedRuns = db
      .prepare(CLOSE_CANCELLED)
      .all<{ run_id: string }>(CANCEL_ERROR, CANCEL_CODE)
      .map((row) => row.run_id);

    for (const runId of new Set([...exhaustedRuns, ...closedRuns])) updateRunProgress(db, runId);

    return { requeued, returnedToAnswered, exhausted: exhaustedRuns.length };
  });
}

/**
 * Run once at boot. No call from this process can be in flight, so every locked
 * task is released regardless of how recently it was locked. Assumes one
 * Overheard AI process per database file. A crash repeats every call that was
 * in flight, an accepted and documented risk.
 */
export function bootRecovery(db: Driver): RecoverySummary {
  return sweep(db, null);
}

/**
 * Run on every worker pass. Releases tasks locked longer than STUCK_LOCK_MS and
 * then closes out anything past the attempt ceiling. A null lock is released
 * immediately: no live worker holds it, and leaving it would hide the task from
 * the claimer and the reaper alike.
 */
export function reapStuckTasks(db: Driver, now: Date = new Date()): RecoverySummary {
  return sweep(db, new Date(now.getTime() - STUCK_LOCK_MS).toISOString());
}
