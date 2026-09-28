/**
 * updateRunProgress: the counter arithmetic and the status machine.
 *
 * The fixture cases check the measured arm against the numbers the reference
 * PL/pgSQL produced. The hand-built cases cover what the fixtures cannot reach:
 * a perception-only run, the sticky cancelled arm, and finished_at being
 * cleared again by a retry.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Driver } from "../db/driver";
import { migrate } from "../db/migrate";
import { seedModels } from "../db/seed-models";
import type { RunStatus, TaskStatus } from "../db/types";
import { fixtureRunId, loadFixture, type Fixture } from "./load-fixture";
import { readRunProgress, updateRunProgress } from "./update-run-progress";

const MODEL = "09fbf457-be35-4428-b72b-48bc04fcc01e";

let db: Driver;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedModels(db);
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Acme Analytics')").run();
  db.prepare(
    "INSERT INTO prompts (id, project_id, text, iterations) VALUES ('q1', 'p1', 'best analytics tools', 1)",
  ).run();
});

afterEach(() => {
  db.close();
});

function makeRun(plannedCalls: number, status: RunStatus = "queued"): string {
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1',?,?,'{}')",
  ).run(status, plannedCalls);
  return "r1";
}

let taskSeq = 0;

function makeTask(status: TaskStatus, isPerception: 0 | 1 = 0): string {
  taskSeq += 1;
  const id = `t${taskSeq}`;
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, is_perception, status)
     VALUES (?, 'r1', 'p1', ?, ?, ?, ?, ?)`,
  ).run(id, isPerception === 1 ? null : "q1", MODEL, taskSeq, isPerception, status);
  return id;
}

beforeEach(() => {
  taskSeq = 0;
});

function readFixture(name: string): Fixture {
  const url = new URL(`./__fixtures__/finalize-run/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

describe("updateRunProgress, against the fixture counters", () => {
  const cases = [
    "absent-brand",
    "counting-rule",
    "mixed-failure",
    "perception-excluded",
    "repeat-finalize-idempotent",
    "top3-rate",
    "two-models-with-merged-scope",
  ];

  it.each(cases)("reproduces the run counters recorded for %s", (name) => {
    const fixture = readFixture(name);
    loadFixture(db, fixture);
    const runId = fixtureRunId(fixture);

    const progress = updateRunProgress(db, runId);
    const expected = fixture.expected.run;

    expect(progress.status).toBe(expected.status);
    expect(progress.plannedCalls).toBe(expected.planned_calls);
    expect(progress.completedCalls).toBe(expected.completed_calls);
    expect(progress.failedCalls).toBe(expected.failed_calls);
    expect(progress.startedAt !== null).toBe(expected.started_at_set);
    expect(progress.finishedAt !== null).toBe(expected.finished_at_set);
  });
});

describe("readRunProgress, the pending breakdown", () => {
  it("splits the outstanding tasks into fresh, retrying and working", () => {
    makeRun(14); // 7 answers
    makeTask("done");
    makeTask("done");
    makeTask("failed");
    const fresh = makeTask("queued");
    expect(fresh).toBeTruthy();
    const retry = makeTask("queued");
    db.prepare("UPDATE run_tasks SET attempts = 1 WHERE id = ?").run(retry);
    makeTask("in_flight");
    makeTask("extracting");
    const answeredRetry = makeTask("answered");
    db.prepare("UPDATE run_tasks SET attempts = 1 WHERE id = ?").run(answeredRetry);

    const progress = readRunProgress(db, "r1");

    expect(progress.fresh).toBe(1);
    expect(progress.retrying).toBe(2); // one answer call, one extraction call
    expect(progress.working).toBe(2); // in_flight + extracting
    // The three parts sum to the pending tasks, with no double counting.
    expect(progress.fresh + progress.retrying + progress.working).toBe(progress.pending);
  });

  it("counts an answered task awaiting its first extraction as working, not retrying", () => {
    makeRun(2);
    makeTask("answered");
    const progress = readRunProgress(db, "r1");
    expect(progress.working).toBe(1);
    expect(progress.retrying).toBe(0);
  });
});

describe("updateRunProgress, the measured arm", () => {
  it("credits an answered task with one of its two calls", () => {
    makeRun(4);
    makeTask("done");
    makeTask("answered");

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls).toBe(3);
    expect(progress.status).toBe("running");
    expect(progress.finishedAt).toBeNull();
  });

  it("credits an extracting task the same as an answered one", () => {
    makeRun(4);
    makeTask("done");
    makeTask("extracting");

    expect(updateRunProgress(db, "r1").completedCalls).toBe(3);
  });

  it("lands exactly on planned_calls when everything is done", () => {
    makeRun(6);
    makeTask("done");
    makeTask("done");
    makeTask("done");

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls).toBe(6);
    expect(progress.failedCalls).toBe(0);
    expect(progress.status).toBe("completed");
    expect(progress.finishedAt).not.toBeNull();
  });

  it("counts a failed task as two failed calls and calls the run partial", () => {
    makeRun(4);
    makeTask("done");
    makeTask("failed");

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls).toBe(2);
    expect(progress.failedCalls).toBe(2);
    expect(progress.status).toBe("partial");
  });

  it("calls a run failed when nothing is done", () => {
    makeRun(4);
    makeTask("failed");
    makeTask("failed");

    expect(updateRunProgress(db, "r1").status).toBe("failed");
  });

  it("never lets completed plus failed pass planned_calls", () => {
    makeRun(8);
    makeTask("done");
    makeTask("answered");
    makeTask("extracting");
    makeTask("failed");

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls + progress.failedCalls).toBeLessThanOrEqual(
      progress.plannedCalls,
    );
  });
});

describe("updateRunProgress, perception", () => {
  it("keeps a run running until its perception task is terminal", () => {
    makeRun(4);
    makeTask("done");
    makeTask("done");
    makeTask("extracting", 1);

    const progress = updateRunProgress(db, "r1");

    // Every measured answer is in, and the run is still running.
    expect(progress.completedCalls).toBe(4);
    expect(progress.status).toBe("running");
    expect(progress.pending).toBe(1);
    expect(progress.finishedAt).toBeNull();
  });

  it("does not let a failed perception answer make a measured run partial", () => {
    makeRun(4);
    makeTask("done");
    makeTask("done");
    makeTask("failed", 1);

    const progress = updateRunProgress(db, "r1");

    expect(progress.status).toBe("completed");
    expect(progress.failedCalls).toBe(0);
  });

  it("uses the p_mid term on a perception-only run", () => {
    makeRun(4);
    makeTask("done", 1);
    makeTask("extracting", 1);

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls).toBe(3);
    expect(progress.status).toBe("running");
  });

  it("completes a perception-only run rather than failing it", () => {
    makeRun(4);
    makeTask("done", 1);
    makeTask("done", 1);

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls).toBe(4);
    expect(progress.failedCalls).toBe(0);
    expect(progress.status).toBe("completed");
  });

  it("calls a perception-only run partial when one answer failed", () => {
    makeRun(4);
    makeTask("done", 1);
    makeTask("failed", 1);

    const progress = updateRunProgress(db, "r1");

    expect(progress.completedCalls).toBe(2);
    expect(progress.failedCalls).toBe(2);
    expect(progress.status).toBe("partial");
  });

  it("calls a perception-only run failed when nothing landed", () => {
    makeRun(4);
    makeTask("failed", 1);
    makeTask("failed", 1);

    expect(updateRunProgress(db, "r1").status).toBe("failed");
  });
});

describe("updateRunProgress, cancelled", () => {
  it("leaves a cancelled run cancelled but still refreshes its counters", () => {
    makeRun(4, "cancelled");
    makeTask("done");
    makeTask("failed");

    const progress = updateRunProgress(db, "r1");

    expect(progress.status).toBe("cancelled");
    expect(progress.completedCalls).toBe(2);
    expect(progress.failedCalls).toBe(2);
    expect(progress.finishedAt).not.toBeNull();
  });
});

describe("updateRunProgress, timestamps", () => {
  it("keeps the finish time a run already has", () => {
    // A recount of an old run must not move the day it finished to today.
    const runId = makeRun(2);
    makeTask("done");
    updateRunProgress(db, runId);
    db.prepare("UPDATE runs SET finished_at = '2026-01-02T03:04:05.000Z' WHERE id = ?").run(runId);

    const progress = updateRunProgress(db, runId);

    expect(progress.finishedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("reads without writing when asked to read", () => {
    const runId = makeRun(2);
    makeTask("done");

    const progress = readRunProgress(db, runId);

    expect(progress.status).toBe("completed");
    const row = db
      .prepare("SELECT status, finished_at FROM runs WHERE id = ?")
      .get<{ status: string; finished_at: string | null }>(runId);
    expect(row?.status).toBe("queued");
    expect(row?.finished_at).toBeNull();
  });

  it("stamps started_at once and never moves it", () => {
    makeRun(2);
    makeTask("answered");

    const first = updateRunProgress(db, "r1").startedAt;
    const second = updateRunProgress(db, "r1").startedAt;

    expect(second).toBe(first);
  });

  it("clears finished_at again when a task goes back to pending", () => {
    makeRun(2);
    const taskId = makeTask("failed");

    expect(updateRunProgress(db, "r1").finishedAt).not.toBeNull();

    db.prepare("UPDATE run_tasks SET status = 'queued' WHERE id = ?").run(taskId);

    expect(updateRunProgress(db, "r1").finishedAt).toBeNull();
  });

  it("raises on a run that does not exist", () => {
    expect(() => updateRunProgress(db, "nope")).toThrow(/RUN_NOT_FOUND/);
  });
});
