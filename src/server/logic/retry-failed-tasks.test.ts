/**
 * retryFailedTasks: a failed task with an answer already in hand goes back to
 * the extraction phase, so the expensive call is not bought twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { RunRow, RunTaskRow, TaskStatus } from "../db/types";
import { retryFailedTasks } from "./retry-failed-tasks";
import { freshDb, HAIKU, seedProject } from "./test-support";

let db: Driver;
let seq = 0;

beforeEach(() => {
  db = freshDb();
  seq = 0;
  seedProject(db);
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1','partial',6,'{}')",
  ).run();
});

afterEach(() => {
  db.close();
});

function makeTask(status: TaskStatus, answerText: string | null): string {
  seq += 1;
  const id = `t${seq}`;
  db.prepare(
    `INSERT INTO run_tasks
       (id, run_id, project_id, prompt_id, model_id, iteration, status, attempts, error,
        failure_code, locked_at, locked_by, answer_text, next_attempt_at)
     VALUES (?, 'r1', 'p1', 'q1', ?, ?, ?, 3, 'MAX_ATTEMPTS_EXCEEDED', 'MAX_ATTEMPTS_EXCEEDED', ?, 'worker-1', ?, ?)`,
  ).run(id, HAIKU, seq, status, new Date().toISOString(), answerText, "2099-01-01T00:00:00.000Z");
  return id;
}

function taskOf(id: string): RunTaskRow {
  const row = db.prepare("SELECT * FROM run_tasks WHERE id = ?").get<RunTaskRow>(id);
  if (!row) throw new Error("no task");
  return row;
}

describe("retryFailedTasks", () => {
  it("sends a failed task holding an answer back to answered", () => {
    const id = makeTask("failed", "Northwind Metrics, then Acme Analytics.");

    expect(retryFailedTasks(db, "r1")).toBe(1);
    expect(taskOf(id).status).toBe("answered");
  });

  it("sends a failed task with no answer back to queued", () => {
    const id = makeTask("failed", null);

    retryFailedTasks(db, "r1");

    expect(taskOf(id).status).toBe("queued");
  });

  it("treats a blank answer as no answer", () => {
    const id = makeTask("failed", "   \n ");

    retryFailedTasks(db, "r1");

    expect(taskOf(id).status).toBe("queued");
  });

  it("resets attempts and the lock, keeps the failure reason, and opens the backoff gate", () => {
    const id = makeTask("failed", null);

    retryFailedTasks(db, "r1");
    const after = taskOf(id);

    expect(after.attempts).toBe(0);
    // The reason stays, as it does on an automatic retry: Gemini's no-search
    // retry pressure reads the last failure reason, and without it the retry
    // asks the plain question that just failed.
    expect(after.error).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(after.failure_code).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(after.locked_at).toBeNull();
    expect(after.locked_by).toBeNull();
    expect(after.next_attempt_at < "2099-01-01T00:00:00.000Z").toBe(true);
  });

  it("touches only failed tasks in the named run", () => {
    const done = makeTask("done", "kept");
    const otherRun = makeTask("failed", null);
    db.prepare(
      "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r2','p1','failed',2,'{}')",
    ).run();
    db.prepare("UPDATE run_tasks SET run_id = 'r2' WHERE id = ?").run(otherRun);
    const target = makeTask("failed", null);

    expect(retryFailedTasks(db, "r1")).toBe(1);
    expect(taskOf(done).status).toBe("done");
    expect(taskOf(otherRun).status).toBe("failed");
    expect(taskOf(target).status).toBe("queued");
  });

  it("covers failed perception tasks within their own run", () => {
    const id = makeTask("failed", null);
    db.prepare("UPDATE run_tasks SET is_perception = 1, prompt_id = NULL WHERE id = ?").run(id);

    expect(retryFailedTasks(db, "r1")).toBe(1);
    const task = taskOf(id);
    expect(task.status).toBe("queued");
    expect(task.is_perception).toBe(1);
  });

  it("puts the run back to running and clears finished_at", () => {
    makeTask("done", "kept");
    makeTask("failed", null);
    db.prepare("UPDATE runs SET finished_at = ? WHERE id = 'r1'").run(new Date().toISOString());

    retryFailedTasks(db, "r1");
    const run = db.prepare("SELECT * FROM runs WHERE id = 'r1'").get<RunRow>();

    expect(run?.status).toBe("running");
    expect(run?.finished_at).toBeNull();
    expect(run?.failed_calls).toBe(0);
  });

  it("returns zero and leaves the run alone when nothing failed", () => {
    makeTask("done", "kept");

    expect(retryFailedTasks(db, "r1")).toBe(0);
    expect(db.prepare("SELECT status FROM runs WHERE id = 'r1'").get<RunRow>()?.status).toBe(
      "completed",
    );
  });

  it("raises on a run that does not exist", () => {
    expect(() => retryFailedTasks(db, "nope")).toThrow(/RUN_NOT_FOUND/);
  });
});
