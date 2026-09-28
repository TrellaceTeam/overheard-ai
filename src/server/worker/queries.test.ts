/**
 * The recovery net that decides which runs a pass should score.
 *
 * Every phase calls updateRunProgress after every task, so a run is already
 * `completed` the moment its last task lands. A pass interrupted before
 * scoring, and a cancelled run, must still be picked up, so candidates are
 * keyed on the missing `finalised_at`, not on run status.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import { finalizeRun } from "../logic/finalize-run";
import { freshDb, HAIKU, seedProject } from "../logic/test-support";
import { listFinalisationCandidates } from "./queries";

let db: Driver;

beforeEach(() => {
  db = freshDb();
  iteration = 0;
  seedProject(db);
});

afterEach(() => {
  db.close();
});

function seedRun(id: string, status: string): void {
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES (?, 'p1', ?, 4, '{}')",
  ).run(id, status);
}

let iteration = 0;

function seedTask(id: string, runId: string, status: string): void {
  iteration += 1;
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status)
     VALUES (?, ?, 'p1', 'q1', ?, ?, ?)`,
  ).run(id, runId, HAIKU, iteration, status);
}

function candidateIds(touched: string[] = []): string[] {
  return listFinalisationCandidates(db, touched)
    .map((run) => run.id)
    .sort();
}

describe("listFinalisationCandidates", () => {
  it("finds a run that drained in a pass which never scored it", () => {
    seedRun("r1", "completed");
    seedTask("t1", "r1", "done");

    expect(candidateIds()).toEqual(["r1"]);
  });

  it("finds a cancelled run whose tasks have all stopped", () => {
    seedRun("r1", "cancelled");
    seedTask("t1", "r1", "done");
    seedTask("t2", "r1", "failed");

    expect(candidateIds()).toEqual(["r1"]);
  });

  it("stops offering a run once it has been scored", () => {
    seedRun("r1", "completed");
    seedTask("t1", "r1", "done");

    finalizeRun(db, "r1");

    expect(candidateIds()).toEqual([]);
    expect(
      db.prepare("SELECT finalised_at FROM runs WHERE id = 'r1'").get<{ finalised_at: string }>()
        ?.finalised_at,
    ).toBeTruthy();
  });

  it("leaves a run alone while anything is still pending", () => {
    seedRun("r1", "running");
    seedTask("t1", "r1", "done");
    seedTask("t2", "r1", "queued");

    expect(candidateIds()).toEqual([]);
  });

  it("offers a drained run with nothing done, so it is stamped as scored", () => {
    seedRun("r1", "failed");
    seedTask("t1", "r1", "failed");

    expect(candidateIds()).toEqual(["r1"]);
  });

  it("still offers every run the pass touched, whatever their state", () => {
    seedRun("r1", "running");
    seedTask("t1", "r1", "queued");

    expect(candidateIds(["r1"])).toEqual(["r1"]);
  });
});
