/**
 * createRun: the fan-out, the composed question, and the ceiling.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { RunRow, RunTaskRow } from "../db/types";
import { composeQuestion, createRun } from "./create-run";
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
    .prepare("SELECT * FROM run_tasks WHERE run_id = ? ORDER BY prompt_id, model_id, iteration")
    .all<RunTaskRow>(runId);
}

function runOf(runId: string): RunRow {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get<RunRow>(runId);
  if (!row) throw new Error("no run");
  return row;
}

describe("composeQuestion", () => {
  it("prefixes the trimmed context and a blank line", () => {
    expect(composeQuestion("best tools", "  You are a buyer.  ", null)).toBe(
      "You are a buyer.\n\nbest tools",
    );
  });

  it("drops the prefix entirely when the context is blank", () => {
    expect(composeQuestion("best tools", "   ", null)).toBe("best tools");
    expect(composeQuestion("best tools", null, null)).toBe("best tools");
  });

  it("replaces every brand token", () => {
    expect(composeQuestion("is {brand} better than {brand}", null, "Acme Analytics")).toBe(
      "is Acme Analytics better than Acme Analytics",
    );
  });

  it("leaves the token visible when there is no target brand", () => {
    expect(composeQuestion("what about {brand}", null, null)).toBe("what about {brand}");
  });
});

describe("createRun", () => {
  it("writes one task per prompt per iteration per assistant", () => {
    seedProject(db, {
      prompts: [
        { id: "q1", text: "best analytics tools", iterations: 3 },
        { id: "q2", text: "top search platforms", iterations: 2 },
      ],
      models: [HAIKU, SONNET],
    });

    const runId = createRun(db, "p1");
    const tasks = tasksOf(runId);

    expect(tasks).toHaveLength(10);
    expect(runOf(runId).planned_calls).toBe(20);
    expect(new Set(tasks.map((task) => task.iteration))).toEqual(new Set([1, 2, 3]));
    expect(tasks.filter((task) => task.prompt_id === "q1")).toHaveLength(6);
  });

  it("asks only prompts that are on and not archived", () => {
    seedProject(db, {
      prompts: [
        { id: "q1", text: "best analytics tools", iterations: 2 },
        { id: "q2", text: "top search platforms", iterations: 2 },
        { id: "q3", text: "cheapest analytics tools", iterations: 2 },
      ],
    });
    db.prepare("UPDATE prompts SET archived = 1 WHERE id = 'q2'").run();
    db.prepare("UPDATE prompts SET is_active = 0 WHERE id = 'q3'").run();

    const tasks = tasksOf(createRun(db, "p1"));

    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.prompt_id === "q1")).toBe(true);
  });

  it("numbers iterations from 1, not 0", () => {
    seedProject(db, { prompts: [{ id: "q1", text: "best analytics tools", iterations: 2 }] });

    expect(tasksOf(createRun(db, "p1")).map((task) => task.iteration)).toEqual([1, 2]);
  });

  it("stores the composed question on every task", () => {
    seedProject(db, {
      brand: "Acme Analytics",
      prompts: [
        { id: "q1", text: "is {brand} any good", context: "You are a buyer.", iterations: 1 },
      ],
    });

    const task = tasksOf(createRun(db, "p1"))[0];

    expect(task?.question_text).toBe("You are a buyer.\n\nis Acme Analytics any good");
  });

  it("uses the oldest active target brand and ignores an inactive one", () => {
    seedProject(db, { brand: "Acme Analytics", prompts: [{ id: "q1", text: "about {brand}" }] });
    db.prepare(
      `INSERT INTO brands (id, project_id, name, role, is_active, created_at)
       VALUES ('newer', 'p1', 'Northwind Metrics', 'target', 0, '2025-01-01T00:00:00.000Z')`,
    ).run();

    expect(tasksOf(createRun(db, "p1"))[0]?.question_text).toBe("about Acme Analytics");
  });

  it("creates no perception task", () => {
    seedProject(db);

    const tasks = tasksOf(createRun(db, "p1"));

    expect(tasks.every((task) => task.is_perception === 0)).toBe(true);
  });

  it("starts the run queued with every task queued and no lock", () => {
    seedProject(db);

    const runId = createRun(db, "p1");
    const run = runOf(runId);

    expect(run.status).toBe("queued");
    expect(run.completed_calls).toBe(0);
    expect(run.failed_calls).toBe(0);
    expect(run.started_at).toBeNull();
    expect(run.finished_at).toBeNull();
    for (const task of tasksOf(runId)) {
      expect(task.status).toBe("queued");
      expect(task.attempts).toBe(0);
      expect(task.locked_at).toBeNull();
    }
  });

  it("records the trigger and the config snapshot it was given", () => {
    seedProject(db);

    const run = runOf(
      createRun(db, "p1", { trigger: "scheduled", configSnapshot: { scheduled: true } }),
    );

    expect(run.trigger).toBe("scheduled");
    expect(JSON.parse(run.config_snapshot)).toEqual({ scheduled: true });
  });

  it("defaults to a manual trigger and an empty snapshot", () => {
    seedProject(db);

    const run = runOf(createRun(db, "p1"));

    expect(run.trigger).toBe("manual");
    expect(run.config_snapshot).toBe("{}");
  });

  it("refuses a project that does not exist", () => {
    expect(() => createRun(db, "nope")).toThrow(/PROJECT_NOT_FOUND/);
  });

  it("writes nothing at all when the plan is refused", () => {
    seedProject(db, { prompts: [{ id: "q1", text: "best analytics tools", isActive: false }] });

    expect(() => createRun(db, "p1")).toThrow(/NO_PROMPTS/);
    expect(db.prepare("SELECT count(*) AS n FROM runs").get<{ n: number }>()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM run_tasks").get<{ n: number }>()?.n).toBe(0);
  });

  it("survives its prompt being deleted, because the question is stored", () => {
    seedProject(db, { brand: "Acme Analytics", prompts: [{ id: "q1", text: "about {brand}" }] });
    const runId = createRun(db, "p1");

    db.prepare("DELETE FROM prompts WHERE id = 'q1'").run();
    const task = tasksOf(runId)[0];

    expect(task?.prompt_id).toBeNull();
    expect(task?.question_text).toBe("about Acme Analytics");
  });
});
