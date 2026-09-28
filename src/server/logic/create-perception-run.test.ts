/**
 * createPerceptionRun: one task per assistant, the off switch, and the key
 * check, which covers the extractor too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { RunRow, RunTaskRow } from "../db/types";
import { createPerceptionRun } from "./create-perception-run";
import { freshDb, HAIKU, seedProject, SONNET } from "./test-support";

let db: Driver;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

function tasksOf(runId: string): RunTaskRow[] {
  return db
    .prepare("SELECT * FROM run_tasks WHERE run_id = ? ORDER BY model_id")
    .all<RunTaskRow>(runId);
}

describe("createPerceptionRun", () => {
  it("asks each monitored assistant once, with no prompt row behind it", () => {
    seedProject(db, { models: [HAIKU, SONNET] });

    const tasks = tasksOf(createPerceptionRun(db, "p1"));

    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task.is_perception).toBe(1);
      expect(task.prompt_id).toBeNull();
      expect(task.iteration).toBe(1);
    }
  });

  it("plans two calls per assistant, so progress cannot pass 100 percent", () => {
    seedProject(db, { models: [HAIKU, SONNET] });

    const run = db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get<RunRow>(createPerceptionRun(db, "p1"));

    expect(run?.planned_calls).toBe(4);
    expect(JSON.parse(run?.config_snapshot ?? "{}")).toEqual({ perception_only: true });
    expect(run?.trigger).toBe("manual");
  });

  it("resolves the brand token in the perception question", () => {
    seedProject(db, {
      brand: "Acme Analytics",
      perceptionPrompt: "What do you know about {brand}?",
    });

    expect(tasksOf(createPerceptionRun(db, "p1"))[0]?.question_text).toBe(
      "What do you know about Acme Analytics?",
    );
  });

  it("leaves the token visible when the project has no target brand", () => {
    seedProject(db, { brand: null, perceptionPrompt: "What do you know about {brand}?" });

    expect(tasksOf(createPerceptionRun(db, "p1"))[0]?.question_text).toBe(
      "What do you know about {brand}?",
    );
  });

  it("treats a blank perception prompt as the off switch", () => {
    seedProject(db, { perceptionPrompt: "   \n  " });

    expect(() => createPerceptionRun(db, "p1")).toThrow(/NO_PERCEPTION_PROMPT/);
  });

  it("refuses a project with no assistant selected", () => {
    seedProject(db, { models: [] });

    expect(() => createPerceptionRun(db, "p1")).toThrow(/NO_MODELS/);
  });

  it("checks the extractor's provider as well as the answering ones", () => {
    // Haiku is anthropic and is the extractor; the answering assistant is google.
    const gemini = db
      .prepare("SELECT id FROM models WHERE provider = 'google' LIMIT 1")
      .get<{ id: string }>();
    seedProject(db, { models: [gemini!.id], extractionModelId: HAIKU });

    expect(() => createPerceptionRun(db, "p1", { providersWithKeys: new Set(["google"]) })).toThrow(
      /MISSING_CREDENTIAL: no API key configured for anthropic/,
    );

    expect(() =>
      createPerceptionRun(db, "p1", { providersWithKeys: new Set(["google", "anthropic"]) }),
    ).not.toThrow();
  });

  it("names every missing provider, not just the first", () => {
    const gemini = db
      .prepare("SELECT id FROM models WHERE provider = 'google' LIMIT 1")
      .get<{ id: string }>();
    seedProject(db, { models: [HAIKU, gemini!.id], extractionModelId: HAIKU });

    expect(() => createPerceptionRun(db, "p1", { providersWithKeys: new Set<string>() })).toThrow(
      /anthropic, google/,
    );
  });

  it("skips the key check entirely when no key set is supplied", () => {
    seedProject(db);

    expect(() => createPerceptionRun(db, "p1")).not.toThrow();
  });

  it("refuses to write an observation against a perception task", () => {
    seedProject(db);
    const taskId = tasksOf(createPerceptionRun(db, "p1"))[0]?.id ?? "";

    expect(() =>
      db
        .prepare(
          `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, raw_name, mention_type)
           SELECT 'bad', id, run_id, project_id, 'Northwind Metrics', 'mentioned'
             FROM run_tasks WHERE id = ?`,
        )
        .run(taskId),
    ).toThrow(/PERCEPTION_HAS_NO_OBSERVATIONS/);
  });
});
