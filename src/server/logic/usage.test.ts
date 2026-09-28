/**
 * recordUsageEvent: one row per provider call, and the run total the run screen
 * shows as an estimate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { UsageEventRow } from "../db/types";
import { recordUsageEvent, runUsageTotal } from "./usage";
import type { UsageEventInput } from "./types";
import { freshDb, HAIKU, seedProject } from "./test-support";

let db: Driver;

beforeEach(() => {
  db = freshDb();
  seedProject(db);
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1','running',2,'{}')",
  ).run();
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration)
     VALUES ('t1', 'r1', 'p1', 'q1', ?, 1)`,
  ).run(HAIKU);
});

afterEach(() => {
  db.close();
});

function event(partial: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    runId: "r1",
    runTaskId: "t1",
    kind: "answer",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    inputTokens: 1200,
    outputTokens: 340,
    searchCalls: 0,
    costUsd: 0.0029,
    costEstimated: true,
    outcome: "ok",
    ...partial,
  };
}

describe("recordUsageEvent", () => {
  it("writes the call exactly as it was handed over", () => {
    recordUsageEvent(db, event());

    const row = db.prepare("SELECT * FROM usage_events").get<UsageEventRow>();
    expect(row?.run_id).toBe("r1");
    expect(row?.run_task_id).toBe("t1");
    expect(row?.kind).toBe("answer");
    expect(row?.provider).toBe("anthropic");
    expect(row?.model_id).toBe("claude-haiku-4-5");
    expect(row?.input_tokens).toBe(1200);
    expect(row?.output_tokens).toBe(340);
    expect(row?.cost_usd).toBeCloseTo(0.0029, 6);
    expect(row?.cost_estimated).toBe(1);
    expect(row?.outcome).toBe("ok");
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records a failed call too, so the log is not only the happy path", () => {
    recordUsageEvent(db, event({ outcome: "RATE_LIMITED", costUsd: 0 }));

    expect(db.prepare("SELECT outcome FROM usage_events").get<UsageEventRow>()?.outcome).toBe(
      "RATE_LIMITED",
    );
  });

  it("accepts a call that belongs to no run, such as a setup-check probe", () => {
    recordUsageEvent(db, event({ runId: null, runTaskId: null }));

    const row = db.prepare("SELECT * FROM usage_events").get<UsageEventRow>();
    expect(row?.run_id).toBeNull();
    expect(row?.run_task_id).toBeNull();
  });

  it("keeps the model as a provider string, so the log outlives a catalog row", () => {
    recordUsageEvent(db, event({ modelId: "some-retired-model" }));

    expect(db.prepare("SELECT model_id FROM usage_events").get<UsageEventRow>()?.model_id).toBe(
      "some-retired-model",
    );
  });

  it("adds up a run's estimated spend", () => {
    recordUsageEvent(db, event({ costUsd: 0.01 }));
    recordUsageEvent(db, event({ kind: "extraction", costUsd: 0.002 }));

    expect(runUsageTotal(db, "r1")).toBeCloseTo(0.012, 6);
    expect(runUsageTotal(db, "nope")).toBe(0);
  });

  it("goes with the run when the run is deleted", () => {
    recordUsageEvent(db, event());

    db.prepare("DELETE FROM runs WHERE id = 'r1'").run();

    expect(db.prepare("SELECT count(*) AS n FROM usage_events").get<{ n: number }>()?.n).toBe(0);
  });
});
