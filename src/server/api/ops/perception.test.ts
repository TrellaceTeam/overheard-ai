import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, seedProject } from "../../logic/test-support";
import { getPerceptionState, listPerceptionSummaries } from "./perception";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(prompt = "What do you know about {brand}?"): Driver {
  db = freshDb();
  seedProject(db, { perceptionPrompt: prompt });
  return db;
}

function insertSummary(
  db: Driver,
  options: { id: string; modelId: string | null; question: string | null; knows?: 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO perception_summaries
       (id, project_id, model_id, question_text, knows_brand, what_it_does, source_answers,
        created_at, updated_at)
     VALUES (?, 'p1', ?, ?, ?, 'Analytics for product teams.', 2,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(options.id, options.modelId, options.question, options.knows ?? 1);
}

describe("listPerceptionSummaries", () => {
  it("puts the merged row first and names the assistant on the others", () => {
    const db = open();
    insertSummary(db, {
      id: "s1",
      modelId: HAIKU,
      question: "What do you know about Acme Analytics?",
    });
    insertSummary(db, {
      id: "s0",
      modelId: null,
      question: "What do you know about Acme Analytics?",
    });

    const summaries = listPerceptionSummaries(db, "p1");
    expect(summaries[0]?.modelId).toBeNull();
    expect(summaries[0]?.modelName).toBeNull();
    expect(summaries[1]?.modelName).toBe("Claude Haiku 4.5");
    expect(summaries[1]?.knowsBrand).toBe(true);
  });
});

describe("getPerceptionState", () => {
  it("resolves the brand token and reports the prompt as enabled", () => {
    const db = open();
    const state = getPerceptionState(db, "p1");
    expect(state.resolvedQuestion).toBe("What do you know about Acme Analytics?");
    expect(state.enabled).toBe(true);
    expect(state.stale).toBe(false);
  });

  it("leaves the token in place when there is no target brand", () => {
    db = freshDb();
    seedProject(db, { brand: null, perceptionPrompt: "What do you know about {brand}?" });
    expect(getPerceptionState(db, "p1").resolvedQuestion).toBe("What do you know about {brand}?");
  });

  it("reads a blank prompt as the off switch", () => {
    const db = open("   ");
    expect(getPerceptionState(db, "p1").enabled).toBe(false);
  });

  it("is stale when every stored summary answers a question the project no longer asks", () => {
    const db = open();
    insertSummary(db, { id: "s0", modelId: null, question: "What is Acme Analytics?" });
    expect(getPerceptionState(db, "p1").stale).toBe(true);
  });

  it("is not stale when a summary answers the current question", () => {
    const db = open();
    insertSummary(db, {
      id: "s0",
      modelId: null,
      question: "What do you know about Acme Analytics?",
    });
    expect(getPerceptionState(db, "p1").stale).toBe(false);
  });

  it("is not stale when nothing has been asked yet", () => {
    const db = open();
    expect(getPerceptionState(db, "p1")).toMatchObject({ stale: false, summaries: [] });
  });

  it("raises for a project that does not exist", () => {
    const db = open();
    expect(() => getPerceptionState(db, "nope")).toThrow(/PROJECT_NOT_FOUND/);
  });
});

describe("the newest perception run in the state", () => {
  function insertRun(
    db: Driver,
    options: {
      id: string;
      perception?: boolean;
      status?: string;
      createdAt?: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, created_at)
       VALUES (?, 'p1', ?, 0, ?, ?)`,
    ).run(
      options.id,
      options.status ?? "completed",
      options.perception === false ? "{}" : '{"perception_only": true}',
      options.createdAt ?? "2026-01-01T00:00:00.000Z",
    );
  }

  function insertTask(
    db: Driver,
    options: { id: string; runId: string; status?: string; error?: string | null },
  ): void {
    db.prepare(
      `INSERT INTO run_tasks
         (id, run_id, project_id, model_id, iteration, is_perception, status, error,
          question_text, next_attempt_at, created_at)
       VALUES (?, ?, 'p1', ?, 1, 1, ?, ?, 'What do you know about Acme Analytics?',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(options.id, options.runId, HAIKU, options.status ?? "done", options.error ?? null);
  }

  it("is null when the project has never asked", () => {
    const db = open();
    expect(getPerceptionState(db, "p1").lastRun).toBeNull();
  });

  it("looks past measured runs to the perception-only one", () => {
    const db = open();
    insertRun(db, { id: "measured", perception: false, createdAt: "2026-02-01T00:00:00.000Z" });
    insertRun(db, { id: "perc", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(getPerceptionState(db, "p1").lastRun?.runId).toBe("perc");
  });

  it("is the newest perception run, not the oldest", () => {
    const db = open();
    insertRun(db, { id: "first", createdAt: "2026-01-01T00:00:00.000Z" });
    insertRun(db, { id: "second", createdAt: "2026-03-01T00:00:00.000Z" });
    expect(getPerceptionState(db, "p1").lastRun?.runId).toBe("second");
  });

  it("counts its tasks and carries the failures' own words", () => {
    const db = open();
    insertRun(db, { id: "perc", status: "partial" });
    insertTask(db, { id: "t1", runId: "perc", status: "done" });
    insertTask(db, { id: "t2", runId: "perc", status: "failed", error: "HTTP 429: rate limited" });
    insertTask(db, { id: "t3", runId: "perc", status: "queued" });

    const lastRun = getPerceptionState(db, "p1").lastRun;
    expect(lastRun).toMatchObject({
      runId: "perc",
      status: "partial",
      totalTasks: 3,
      doneTasks: 1,
      failedTasks: 1,
      pendingTasks: 1,
      failedReasons: [{ code: null, error: "HTTP 429: rate limited" }],
    });
  });
});
