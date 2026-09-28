/**
 * The run_tasks lifecycle guarantees. Two failure shapes matter most:
 *
 *   a task whose lock is null must stay visible to the reaper, or it sticks
 *   forever and its run is never finalised;
 *
 *   the claim increments attempts, so the ceiling has to hold on the claim
 *   path as well as the failure path, or attempts pass MAX_TASK_ATTEMPTS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { RunStatus, TaskStatus } from "../db/types";
import { claimTasks, DEFAULT_PROVIDER_CAPS, failExhaustedTasks } from "./claim-tasks";
import { reapStuckTasks } from "./recovery";
import { freshDb, HAIKU, seedProject, SONNET } from "./test-support";

const TASK = "t1";

let db: Driver;

beforeEach(() => {
  db = freshDb();
  seedProject(db, { models: [HAIKU, SONNET] });
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1','running',2,'{}')",
  ).run();
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text, next_attempt_at)
     VALUES (?, 'r1', 'p1', 'q1', ?, 1, 'best analytics tools', ?)`,
  ).run(TASK, HAIKU, new Date(Date.now() - 1000).toISOString());
});

afterEach(() => {
  db.close();
});

function setTask(fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE run_tasks SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((key) => fields[key] ?? null),
    TASK,
  );
}

function readTask(): { status: TaskStatus; attempts: number; locked_at: string | null } {
  const row = db
    .prepare("SELECT status, attempts, locked_at FROM run_tasks WHERE id = ?")
    .get<{ status: TaskStatus; attempts: number; locked_at: string | null }>(TASK);
  if (!row) throw new Error("no task");
  return row;
}

function claimIncludesOurTask(): boolean {
  return claimTasks(db, 50, "test").some((claimed) => claimed.task.id === TASK);
}

function setRunStatus(status: RunStatus): void {
  db.prepare("UPDATE runs SET status = ? WHERE id = 'r1'").run(status);
}

describe("claimTasks, the null lock defect", () => {
  it("reclaims an in_flight task whose lock is null", () => {
    setTask({ status: "in_flight", locked_at: null });

    reapStuckTasks(db);

    expect(readTask().status).toBe("queued");
  });

  it("reclaims an extracting task whose lock is null, back to answered", () => {
    setTask({ status: "extracting", locked_at: null });

    reapStuckTasks(db);

    expect(readTask().status).toBe("answered");
  });

  it("still reclaims a lock older than the stale-lock window", () => {
    setTask({ status: "in_flight", locked_at: new Date(Date.now() - 10 * 60_000).toISOString() });

    reapStuckTasks(db);

    expect(readTask().status).toBe("queued");
  });

  it("leaves a lock younger than the stale-lock window alone", () => {
    setTask({ status: "in_flight", locked_at: new Date().toISOString() });

    reapStuckTasks(db);

    expect(readTask().status).toBe("in_flight");
  });
});

describe("claimTasks, the attempt ceiling", () => {
  it("claims a task below the ceiling", () => {
    // One attempt spent: the single automatic retry is still ahead of it.
    setTask({ status: "queued", attempts: 1 });

    expect(claimIncludesOurTask()).toBe(true);
  });

  it("refuses to claim a task that has spent its attempts", () => {
    setTask({ status: "queued", attempts: 2 });

    expect(claimIncludesOurTask()).toBe(false);
  });

  it("marks a spent task failed rather than leaving it queued forever", () => {
    setTask({ status: "queued", attempts: 2 });

    failExhaustedTasks(db);

    expect(readTask().status).toBe("failed");
    expect(
      db.prepare("SELECT error FROM run_tasks WHERE id = ?").get<{ error: string }>(TASK)?.error,
    ).toBe("MAX_ATTEMPTS_EXCEEDED");
  });

  it("keeps an error the worker already wrote", () => {
    setTask({ status: "queued", attempts: 2, error: "rate limited" });

    failExhaustedTasks(db);

    expect(
      db.prepare("SELECT error FROM run_tasks WHERE id = ?").get<{ error: string }>(TASK)?.error,
    ).toBe("rate limited");
  });

  it("sweeps through the reaper, which is the worker's entry point", () => {
    setTask({ status: "queued", attempts: 2 });

    expect(reapStuckTasks(db).exhausted).toBe(1);
    expect(readTask().status).toBe("failed");
  });

  it("never lets attempts drift past the ceiling however often it is claimed", () => {
    setTask({ status: "queued", attempts: 0 });

    for (let pass = 0; pass < 6; pass += 1) {
      claimTasks(db, 50, "test");
      // A silent death: the lock is dropped without the failure path running.
      setTask({ status: "queued", locked_at: null, locked_by: null });
    }

    // Asserted against the literal. Reading the ceiling from the thing under
    // test would pass even if both were wrong.
    expect(readTask().attempts).toBeLessThanOrEqual(2);
  });

  it("always allows extraction on a freshly answered task", () => {
    setTask({ status: "answered", attempts: 0 });

    expect(claimIncludesOurTask()).toBe(true);
  });

  it("still stops a task that exhausts its extraction attempts", () => {
    setTask({ status: "answered", attempts: 3 });

    expect(claimIncludesOurTask()).toBe(false);
    failExhaustedTasks(db);
    expect(readTask().status).toBe("failed");
  });
});

describe("claimTasks, phase routing and eligibility", () => {
  it("routes a queued task to in_flight and an answered one to extracting", () => {
    setTask({ status: "answered" });
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, next_attempt_at)
       VALUES ('t2', 'r1', 'p1', 'q1', ?, 2, ?)`,
    ).run(HAIKU, new Date(Date.now() - 1000).toISOString());

    const claimed = claimTasks(db, 10, "worker-1");
    const byId = new Map(claimed.map((task) => [task.task.id, task]));

    expect(byId.get(TASK)?.phase).toBe("extracting");
    expect(byId.get("t2")?.phase).toBe("in_flight");
  });

  it("stamps the lock and increments attempts in the same claim", () => {
    const claimed = claimTasks(db, 10, "worker-1");

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.task.attempts).toBe(1);
    expect(claimed[0]?.task.locked_by).toBe("worker-1");
    expect(claimed[0]?.task.locked_at).not.toBeNull();
  });

  it("never returns the same row to two claims", () => {
    const first = claimTasks(db, 10, "worker-1");
    const second = claimTasks(db, 10, "worker-2");

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("honours the backoff gate", () => {
    setTask({ next_attempt_at: new Date(Date.now() + 60_000).toISOString() });

    expect(claimIncludesOurTask()).toBe(false);
  });

  it("orders by next_attempt_at and stops at the limit", () => {
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, next_attempt_at)
       VALUES ('t2', 'r1', 'p1', 'q1', ?, 2, ?)`,
    ).run(HAIKU, new Date(Date.now() - 60_000).toISOString());

    const claimed = claimTasks(db, 1, "worker-1");

    expect(claimed.map((task) => task.task.id)).toEqual(["t2"]);
  });

  it.each(["completed", "partial", "failed", "cancelled"] as const)(
    "never claims a task whose run is %s",
    (status) => {
      setRunStatus(status);

      expect(claimIncludesOurTask()).toBe(false);
    },
  );

  it("claims a task whose run is still queued", () => {
    setRunStatus("queued");

    expect(claimIncludesOurTask()).toBe(true);
  });

  it("hands the worker the provider facts it needs to make the call", () => {
    const claimed = claimTasks(db, 10, "worker-1")[0];

    expect(claimed?.provider).toBe("anthropic");
    expect(claimed?.providerModelId).toBe("claude-haiku-4-5");
    expect(claimed?.supportsWebSearch).toBe(false);
    expect(claimed?.task.question_text).toBe("best analytics tools");
  });

  it("returns nothing for a limit of zero", () => {
    expect(claimTasks(db, 0, "worker-1")).toEqual([]);
  });
});

describe("per-provider in-flight caps", () => {
  // The file-level fixture task t1 (Anthropic) would claim alongside the caps
  // tests' own tasks; these cases count claims exactly, so it goes.
  beforeEach(() => {
    db.prepare("DELETE FROM run_tasks WHERE id = 't1'").run();
  });

  function modelId(provider: string): string {
    const row = db
      .prepare(
        "SELECT id FROM models WHERE provider = ? AND is_active = 1 ORDER BY is_extraction_model, tier LIMIT 1",
      )
      .get<{ id: string }>(provider);
    if (!row) throw new Error(`no model for ${provider}`);
    return row.id;
  }

  let iteration = 100;
  function addTask(id: string, providerModelId: string, status: TaskStatus = "queued"): void {
    // run_tasks is UNIQUE (run, prompt, model, iteration): one iteration each,
    // so the caps tests can queue many tasks against one model.
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text, status, next_attempt_at)
       VALUES (?, 'r1', 'p1', 'q1', ?, ?, 'best analytics tools', ?, ?)`,
    ).run(id, providerModelId, iteration++, status, new Date(Date.now() - 1000).toISOString());
  }

  function stillQueued(id: string): boolean {
    const row = db
      .prepare("SELECT status FROM run_tasks WHERE id = ?")
      .get<{ status: TaskStatus }>(id);
    return row?.status === "queued";
  }

  const caps = { openai: 4, anthropic: 4, google: 2 };

  it("never claims past a provider's cap, leaving the rest queued", () => {
    const openai = modelId("openai");
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) addTask(id, openai);

    const claimed = claimTasks(db, 10, "test", caps);

    expect(claimed).toHaveLength(4);
    expect(claimed.filter((t) => stillQueued(t.task.id))).toHaveLength(0);
    const queuedLeft = db
      .prepare("SELECT COUNT(*) c FROM run_tasks WHERE status = 'queued'")
      .get<{ c: number }>()?.c;
    expect(queuedLeft).toBe(2);
  });

  it("a provider at its cap does not block another provider's tasks", () => {
    const openai = modelId("openai");
    const google = modelId("google");
    for (const id of ["f1", "f2", "f3", "f4"]) addTask(id, openai, "in_flight");
    addTask("g1", google);
    addTask("g2", google);

    const claimed = claimTasks(db, 10, "test", caps);

    expect(claimed.map((t) => t.task.id).sort()).toEqual(["g1", "g2"]);
  });

  it("counts an extracting task against the project's extractor provider, not the answer model's", () => {
    // seedProject gives p1 the HAIKU extractor (anthropic). An extracting task
    // answered by an OpenAI model is an Anthropic call right now.
    const openai = modelId("openai");
    addTask("x1", openai, "extracting");
    addTask("a1", modelId("anthropic"));

    const claimed = claimTasks(db, 10, "test", { ...caps, anthropic: 1 });

    expect(claimed).toHaveLength(0);
    expect(stillQueued("a1")).toBe(true);
  });

  it("fills one batch from several providers up to each of their caps", () => {
    const openai = modelId("openai");
    const anthropic = modelId("anthropic");
    const google = modelId("google");
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) addTask(id, openai);
    for (const id of ["m7", "m8", "m9"]) addTask(id, anthropic);
    for (const id of ["m10", "m11", "m12", "m13"]) addTask(id, google);

    const claimed = claimTasks(db, 10, "test", caps);

    const byProvider = new Map<string, number>();
    for (const t of claimed) {
      byProvider.set(t.provider, (byProvider.get(t.provider) ?? 0) + 1);
    }
    expect(claimed).toHaveLength(9);
    expect(byProvider.get("openai")).toBe(4);
    expect(byProvider.get("anthropic")).toBe(3);
    expect(byProvider.get("google")).toBe(2);
  });

  it("charges a newly claimed extraction to the extractor's provider, not the answer model's", () => {
    // seedProject gives p1 the HAIKU extractor (anthropic). These answered
    // tasks were answered by an OpenAI model, but the call each claim starts
    // is an Anthropic extraction, so the Anthropic cap is what binds.
    const openai = modelId("openai");
    for (const id of ["e1", "e2", "e3"]) addTask(id, openai, "answered");

    const claimed = claimTasks(db, 10, "test", { ...caps, anthropic: 1 });

    expect(claimed.map((t) => t.task.id)).toEqual(["e1"]);
    expect(claimed[0]?.phase).toBe("extracting");
  });

  it("falls back to the answer model's provider when the project has no extractor", () => {
    db.prepare("UPDATE projects SET extraction_model_id = NULL WHERE id = 'p1'").run();
    const openai = modelId("openai");
    for (const id of ["n1", "n2", "n3"]) addTask(id, openai, "answered");

    const claimed = claimTasks(db, 10, "test", { ...caps, openai: 2 });

    expect(claimed.map((t) => t.task.id)).toEqual(["n1", "n2"]);
  });

  it("charges extraction to the extractor the worker will call, not the stored preference", () => {
    // p1 prefers the HAIKU extractor (anthropic), but with no Anthropic key the
    // worker falls back to an OpenAI extractor. Answers and extractions then
    // share OpenAI's cap.
    const openai = modelId("openai");
    for (let n = 0; n < 6; n += 1) addTask(`q${n}`, openai, "queued");
    for (let n = 0; n < 6; n += 1) addTask(`e${n}`, openai, "answered");
    addTask("x1", openai, "extracting");

    const claimed = claimTasks(
      db,
      15,
      "test",
      { openai: 6, anthropic: 6, google: 3 },
      () => "openai",
    );

    expect(claimed).toHaveLength(5);
  });

  it("applies the shipped defaults when no caps are passed", () => {
    const google = modelId("google");
    for (const id of ["d1", "d2", "d3"]) addTask(id, google);

    const claimed = claimTasks(db, 10, "test");

    expect(claimed).toHaveLength(DEFAULT_PROVIDER_CAPS.google);
  });
});
