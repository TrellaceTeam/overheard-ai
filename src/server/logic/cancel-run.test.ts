/**
 * cancelRun: stop the queue, leave the calls already with a provider alone, and
 * make the cancelled status stick.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { RunRow, RunTaskRow, TaskStatus } from "../db/types";
import { CANCEL_CODE, CANCEL_ERROR, cancelRun } from "./cancel-run";
import { CANCELLED_KEY, classifyFailure } from "@/lib/failure-reasons";
import { claimTasks } from "./claim-tasks";
import { reapStuckTasks } from "./recovery";
import { updateRunProgress } from "./update-run-progress";
import { freshDb, HAIKU, seedProject } from "./test-support";

let db: Driver;
let seq = 0;

beforeEach(() => {
  db = freshDb();
  seq = 0;
  seedProject(db);
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1','running',12,'{}')",
  ).run();
});

afterEach(() => {
  db.close();
});

function makeTask(status: TaskStatus): string {
  seq += 1;
  const id = `t${seq}`;
  db.prepare(
    `INSERT INTO run_tasks
       (id, run_id, project_id, prompt_id, model_id, iteration, status, locked_at, locked_by, next_attempt_at)
     VALUES (?, 'r1', 'p1', 'q1', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    HAIKU,
    seq,
    status,
    status === "in_flight" || status === "extracting" ? new Date().toISOString() : null,
    status === "in_flight" || status === "extracting" ? "worker-1" : null,
    new Date(Date.now() - 1000).toISOString(),
  );
  return id;
}

function taskOf(id: string): RunTaskRow {
  const row = db.prepare("SELECT * FROM run_tasks WHERE id = ?").get<RunTaskRow>(id);
  if (!row) throw new Error("no task");
  return row;
}

function runOf(): RunRow {
  const row = db.prepare("SELECT * FROM runs WHERE id = 'r1'").get<RunRow>();
  if (!row) throw new Error("no run");
  return row;
}

describe("cancelRun", () => {
  it("fails every queued and answered task and counts them", () => {
    const queued = makeTask("queued");
    const answered = makeTask("answered");

    expect(cancelRun(db, "r1")).toBe(2);
    expect(taskOf(queued).status).toBe("failed");
    expect(taskOf(queued).error).toBe(CANCEL_ERROR);
    expect(taskOf(answered).status).toBe("failed");
  });

  it("leaves a call already with a provider to finish", () => {
    const inFlight = makeTask("in_flight");
    const extracting = makeTask("extracting");

    cancelRun(db, "r1");

    expect(taskOf(inFlight).status).toBe("in_flight");
    expect(taskOf(extracting).status).toBe("extracting");
    expect(taskOf(inFlight).locked_by).toBe("worker-1");
  });

  it("keeps the answers that already landed", () => {
    const done = makeTask("done");

    cancelRun(db, "r1");

    expect(taskOf(done).status).toBe("done");
  });

  it("sets the run to cancelled", () => {
    makeTask("queued");

    cancelRun(db, "r1");

    expect(runOf().status).toBe("cancelled");
  });

  it("stops the worker claiming anything else from the run", () => {
    makeTask("queued");
    makeTask("queued");

    cancelRun(db, "r1");

    expect(claimTasks(db, 10, "worker-1")).toEqual([]);
  });

  it("makes the cancelled status stick through later progress updates", () => {
    const inFlight = makeTask("in_flight");
    cancelRun(db, "r1");

    // The in-flight call lands after the cancel, as it is allowed to.
    db.prepare("UPDATE run_tasks SET status = 'done' WHERE id = ?").run(inFlight);
    const progress = updateRunProgress(db, "r1");

    expect(progress.status).toBe("cancelled");
    expect(runOf().status).toBe("cancelled");
  });

  it("still refreshes the counters of the run it cancels", () => {
    makeTask("done");
    makeTask("queued");

    cancelRun(db, "r1");
    const run = runOf();

    expect(run.completed_calls).toBe(2);
    expect(run.failed_calls).toBe(2);
    expect(run.completed_calls + run.failed_calls).toBeLessThanOrEqual(run.planned_calls);
  });

  it("closes an answer that lands after the cancel, so the run can drain", () => {
    // The call finishes after the cancel and storeAnswer leaves the task
    // `answered` with attempts at 0. The claimer skips a cancelled run, the
    // exhaustion sweep needs spent attempts, and the lock release only touches
    // in_flight and extracting rows, so without the cancelled-run close the
    // run never drains.
    const inFlight = makeTask("in_flight");
    cancelRun(db, "r1");

    db.prepare(
      "UPDATE run_tasks SET status = 'answered', attempts = 0, locked_at = NULL, locked_by = NULL WHERE id = ?",
    ).run(inFlight);

    reapStuckTasks(db);

    expect(taskOf(inFlight).status).toBe("failed");
    expect(taskOf(inFlight).error).toBe(CANCEL_ERROR);
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = 'r1' AND status NOT IN ('done','failed')",
      )
      .get<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it("raises on a run that does not exist", () => {
    expect(() => cancelRun(db, "nope")).toThrow(/RUN_NOT_FOUND/);
  });
});

describe("CANCEL_ERROR", () => {
  it("carries a code the run screen's classifier recognises", () => {
    // Unclassified text falls through to the classifier's default, "Something
    // on our side went wrong", which blames the product for the user's own
    // Cancel.
    const coded = classifyFailure({ code: CANCEL_CODE, error: CANCEL_ERROR });
    expect(coded.key).toBe(CANCELLED_KEY);
    expect(coded.owner).toBe("stopped");
    // The prose alone must still classify: rows written before migration 0009
    // have no failure_code.
    const legacy = classifyFailure({ code: null, error: CANCEL_ERROR });
    expect(legacy.key).toBe(CANCELLED_KEY);
    expect(legacy.owner).toBe("stopped");
  });

  it("stores the code beside the detail on every stopped task", () => {
    const queued = makeTask("queued");
    cancelRun(db, "r1");
    expect(taskOf(queued).error).toBe(CANCEL_ERROR);
    expect(taskOf(queued).failure_code).toBe(CANCEL_CODE);
  });
});
