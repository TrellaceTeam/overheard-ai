import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, seedProject, SONNET } from "../../logic/test-support";
import { CANCEL_ERROR } from "../../logic/cancel-run";
import { createRun as createRunLogic } from "../../logic/create-run";
import { updateRunProgress } from "../../logic/update-run-progress";
import {
  cancelRun,
  createPerceptionRunOnly,
  createRun,
  deleteRun,
  getRun,
  getRunDetail,
  listFailedTaskErrors,
  listFinishedScheduledRuns,
  listRunObservations,
  listRuns,
  listRunTasks,
  listRunMetrics,
  planRunPreview,
  retryFailed,
} from "./runs";
import { newProjectPlan } from "@/lib/run-plan";
import { demoPrefill } from "./demo";
import { listProjectMetrics } from "./metrics";
import { createProject } from "./projects";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  seedProject(db, {
    models: [HAIKU, SONNET],
    prompts: [
      { id: "q1", text: "best analytics tools", iterations: 2 },
      { id: "q2", text: "which analytics tool for a startup", iterations: 1 },
    ],
  });
  return db;
}

describe("planRunPreview", () => {
  it("counts answers and calls before anything is spent", () => {
    const db = open();
    expect(planRunPreview(db, "p1")).toEqual({
      prompts: 2,
      assistants: 2,
      answers: 6,
      calls: 12,
      perceptionCalls: 4,
    });
  });

  it("stops counting the perception question once the project has run", () => {
    // It is asked on the first run only, so a preview that kept adding it
    // would over-report every run after the first.
    const db = open();
    createRun(db, "p1");
    expect(planRunPreview(db, "p1").perceptionCalls).toBe(0);
  });

  it("counts nothing for it when the perception question is switched off", () => {
    const db = open();
    db.prepare("UPDATE projects SET perception_prompt = '' WHERE id = 'p1'").run();
    expect(planRunPreview(db, "p1").perceptionCalls).toBe(0);
  });

  it("agrees with what the wizard promised for the project it creates", () => {
    // The tutorial's prefill, created the way the wizard creates it, is the
    // case a first-time user sees the plan panel for.
    db = freshDb();
    const prefill = demoPrefill();
    const monitoredModelIds = [HAIKU, SONNET];
    const { projectId } = createProject(
      db,
      {
        brandName: prefill.brandName,
        category: prefill.category,
        domains: prefill.domains,
        prompts: prefill.prompts,
        perceptionPrompt: prefill.perceptionPrompt,
        monitoredModelIds,
      },
      { providersWithKeys: ["anthropic"] },
    );

    expect(planRunPreview(db, projectId)).toEqual(
      newProjectPlan(prefill.prompts, monitoredModelIds.length),
    );
  });
});

describe("createRun", () => {
  it("creates the measured run and, on the first run only, a perception run", () => {
    const db = open();
    const first = createRun(db, "p1");
    expect(first.plannedCalls).toBe(12);
    // Reported separately so the toast can say what was bought: 12 measured
    // calls plus 4 for perception.
    expect(first.perceptionCalls).toBe(4);
    expect(first.perceptionRunId).not.toBeNull();
    expect(first.perceptionSkipped).toBeNull();

    const perceptionTasks = db
      .prepare("SELECT count(*) AS n FROM run_tasks WHERE run_id = ? AND is_perception = 1")
      .get<{ n: number }>(first.perceptionRunId!);
    expect(perceptionTasks?.n).toBe(2);

    const second = createRun(db, "p1");
    expect(second.perceptionCalls).toBe(0);
    expect(second.perceptionRunId).toBeNull();
    expect(second.perceptionSkipped).toBeNull();
  });

  it("asks the perception prompt the project was created with, brand resolved", () => {
    db = freshDb();
    const { projectId } = createProject(
      db,
      {
        brandName: "Northwind Metrics",
        category: "analytics tools",
        domains: ["northwind.example.com"],
        perceptionPrompt: "What do assistants say about {brand}?",
        monitoredModelIds: [HAIKU, SONNET],
      },
      { providersWithKeys: ["anthropic"] },
    );

    const { perceptionRunId, perceptionSkipped } = createRun(db, projectId, {
      providersWithKeys: new Set(["anthropic"]),
    });
    expect(perceptionSkipped).toBeNull();

    const questions = listRunTasks(db, perceptionRunId!).map((task) => task.questionText);
    expect(questions).toEqual([
      "What do assistants say about Northwind Metrics?",
      "What do assistants say about Northwind Metrics?",
    ]);
  });

  it("starts the measured run anyway when perception cannot run", () => {
    const db = open();
    db.prepare("UPDATE projects SET perception_prompt = '' WHERE id = 'p1'").run();

    const result = createRun(db, "p1");
    expect(getRun(db, result.runId).status).toBe("queued");
    expect(result.perceptionRunId).toBeNull();
    expect(result.perceptionSkipped).toMatch(/NO_PERCEPTION_PROMPT/);
  });

  it("checks the extractor key as well as the answering providers", () => {
    const db = open();
    const result = createRun(db, "p1", { providersWithKeys: new Set(["openai"]) });
    expect(result.perceptionSkipped).toMatch(/MISSING_CREDENTIAL/);
  });

  it("refuses a project with no active prompt, before a run row exists", () => {
    const db = open();
    db.prepare("UPDATE prompts SET is_active = 0 WHERE project_id = 'p1'").run();
    expect(() => createRun(db, "p1")).toThrow(/NO_PROMPTS/);
    expect(listRuns(db, "p1")).toHaveLength(0);
  });
});

describe("the mock seam", () => {
  afterEach(() => {
    delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  });

  it("marks a run whose answers will be canned, so the mark outlives the variable", () => {
    // Once the variable is unset, canned rows look like measured ones while
    // averaging into the same headline numbers, so the run itself records it.
    const db = open();
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    const { runId, perceptionRunId } = createRun(db, "p1");
    delete process.env["OVERHEARD_MOCK_PROVIDERS"];

    const runs = listRuns(db, "p1");
    expect(runs.find((run) => run.id === runId)?.mock).toBe(true);
    expect(runs.find((run) => run.id === perceptionRunId)?.mock).toBe(true);

    const { runId: real } = createRun(db, "p1");
    expect(listRuns(db, "p1").find((run) => run.id === real)?.mock).toBe(false);
  });

  it("hands the run page the run's own mark, whatever the mode is at the visit", () => {
    const db = open();
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    const { runId: canned } = createRun(db, "p1");
    delete process.env["OVERHEARD_MOCK_PROVIDERS"];
    const { runId: real } = createRun(db, "p1");

    expect(getRunDetail(db, canned).run.mock).toBe(1);
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    expect(getRunDetail(db, real).run.mock).toBe(0);
  });
});

describe("createPerceptionRunOnly", () => {
  it("asks one question per assistant and nothing else", () => {
    const db = open();
    const { runId, answers } = createPerceptionRunOnly(db, "p1");
    expect(answers).toBe(2);
    expect(listRunTasks(db, runId).every((task) => task.isPerception)).toBe(true);
  });
});

describe("reads", () => {
  it("lists runs newest first, and does not shuffle rows that share a timestamp", () => {
    // created_at holds whole milliseconds, so both presses land on the same
    // value often enough to matter. The tiebreak is rowid, which is insertion
    // order, so this assertion holds on every read rather than most of them.
    const db = open();
    const first = createRun(db, "p1").runId;
    const second = createRun(db, "p1").runId;
    const ids = listRuns(db, "p1").map((run) => run.id);

    expect(ids[0]).toBe(second);
    expect(ids.at(-1)).toBe(first);
    expect(listRuns(db, "p1").map((run) => run.id)).toEqual(ids);
  });

  it("marks the perception run so a dashboard can leave it out of its run count", () => {
    // One press of Run now creates two rows. Counted naively, the dashboard
    // treats one finished run as two.
    const db = open();
    createRun(db, "p1");
    const runs = listRuns(db, "p1");
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.perceptionOnly)).toHaveLength(1);
    expect(runs.filter((run) => !run.perceptionOnly)).toHaveLength(1);
  });

  it("lists every task from the moment the run starts, with its prompt and assistant", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    const tasks = listRunTasks(db, runId);

    expect(tasks).toHaveLength(6);
    expect(tasks.every((task) => task.status === "queued")).toBe(true);
    expect(tasks[0]?.promptText).toBeTruthy();
    expect(tasks[0]?.modelDisplayName).toBeTruthy();
    expect(tasks[0]?.questionText).toBeTruthy();
  });

  it("assembles the run screen in one call", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    const taskId = listRunTasks(db, runId)[0]!.id;

    db.prepare("UPDATE run_tasks SET status = 'failed', error = 'PROVIDER_5XX' WHERE id = ?").run(
      taskId,
    );

    const detail = getRunDetail(db, runId);
    expect(detail.run.id).toBe(runId);
    expect(detail.progress.pending).toBe(5);
    expect(detail.failures.map((task) => task.id)).toEqual([taskId]);
    expect(detail.perceptionOnly).toBe(false);
    expect(detail.estimatedCostUsd).toBe(0);
    expect(detail.metrics).toEqual([]);
  });

  it("knows a perception-only run has no results tab", () => {
    const db = open();
    const { runId } = createPerceptionRunOnly(db, "p1");
    expect(getRunDetail(db, runId).perceptionOnly).toBe(true);
  });

  it("reads observations with the brand name joined", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    const taskId = listRunTasks(db, runId)[0]!.id;
    db.prepare(
      `INSERT INTO brand_observations
         (id, run_task_id, run_id, project_id, brand_id, raw_name, position, total_items,
          mention_type, linked_url, is_cited)
       VALUES ('o1', ?, ?, 'p1', 'p1-brand', 'Acme', 1, 3, 'ranked', 'https://acme.example.com', 1)`,
    ).run(taskId, runId);

    expect(listRunObservations(db, runId)[0]).toMatchObject({
      brandName: "Acme Analytics",
      isCited: true,
      position: 1,
    });
  });

  it("collects every failure in the project for the dashboard strip", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    db.prepare(
      "UPDATE run_tasks SET status = 'failed', error = 'NO_CREDENTIAL' WHERE run_id = ?",
    ).run(runId);

    const failures = listFailedTaskErrors(db, "p1");
    expect(failures).toHaveLength(6);
    expect(failures[0]).toMatchObject({ runId, error: "NO_CREDENTIAL" });
  });

  it("reads failures from the whole run, not from the page of answers it shows", () => {
    // The page is capped at 400 answers. Filtered out of the page, failures that
    // fall later would leave the Failures tab empty.
    const db = open();
    const { runId } = createRun(db, "p1");
    const tasks = listRunTasks(db, runId);
    const last = tasks[tasks.length - 1]!.id;
    db.prepare("UPDATE run_tasks SET status = 'failed', error = 'PROVIDER_5XX' WHERE id = ?").run(
      last,
    );

    const detail = getRunDetail(db, runId);
    expect(detail.failures.map((task) => task.id)).toEqual([last]);
    expect(detail.taskTotal).toBe(tasks.length);
    expect(detail.taskLimit).toBeGreaterThan(0);
  });

  it("does not write to the run it is asked to read", () => {
    // getRunDetail is a GET. Persisting progress here would rewrite a finished
    // run's finished_at on every open, and a tab watching a live run would
    // write on every poll.
    const db = open();
    const { runId } = createRun(db, "p1");
    db.prepare("UPDATE run_tasks SET status = 'done' WHERE run_id = ? AND is_perception = 0").run(
      runId,
    );
    db.prepare(
      "UPDATE runs SET status = 'completed', finished_at = '2026-01-02T03:04:05.000Z' WHERE id = ?",
    ).run(runId);

    const detail = getRunDetail(db, runId);

    expect(detail.progress.finishedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(getRun(db, runId).finished_at).toBe("2026-01-02T03:04:05.000Z");
    expect(getRun(db, runId).status).toBe("completed");
  });

  it("agrees with the dashboard about a run whose prompt has been deleted", () => {
    // Both readers scope level 0 rows by model_id alone, so the run page and the
    // dashboard keep or drop the same rows for a run.
    const db = open();
    const { runId } = createRun(db, "p1");
    const insert = db.prepare(
      `INSERT INTO run_metrics
         (id, run_id, project_id, model_id, prompt_id, brand_id,
          answers, mentions, ranked, citations, mention_rate, rank_rate, citation_rate)
       VALUES (?, ?, 'p1', ?, ?, 'p1-brand', 2, 1, 1, 0, 0.5, 0.5, 0)`,
    );
    insert.run("m-with-prompt", runId, HAIKU, "q2");
    // A level 0 row with a null prompt_id. Deleting a prompt removes its metric
    // rows, so only a hand-edited database holds one, but both readers must
    // still treat it alike.
    insert.run("m-orphan", runId, HAIKU, null);
    insert.run("m-run-wide", runId, null, null);

    const runRows = listRunMetrics(db, runId)
      .map((row) => row.id)
      .sort();
    const projectRows = listProjectMetrics(db, "p1")
      .map((row) => row.id)
      .sort();

    expect(runRows).toEqual(["m-orphan", "m-with-prompt"]);
    expect(projectRows).toEqual(runRows);
  });

  it("leaves self-referenced prompts out of the run's metrics, as the dashboard does", () => {
    const db = open();
    db.prepare(
      `INSERT INTO prompts (id, project_id, text, iterations, is_active)
       VALUES ('q-self', 'p1', 'is Acme Analytics good for a startup', 1, 1)`,
    ).run();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('rival', 'p1', 'Northwind Metrics', 'competitor')",
    ).run();
    const { runId } = createRun(db, "p1");
    const insert = db.prepare(
      `INSERT INTO run_metrics
         (id, run_id, project_id, model_id, prompt_id, brand_id,
          answers, mentions, ranked, citations, mention_rate, rank_rate, citation_rate)
       VALUES (?, ?, 'p1', ?, ?, ?, 2, 2, 2, 0, 1, 1, 0)`,
    );
    insert.run("m-plain", runId, HAIKU, "q1", "p1-brand");
    insert.run("m-self-own", runId, HAIKU, "q-self", "p1-brand");
    insert.run("m-self-rival", runId, HAIKU, "q-self", "rival");

    expect(listRunMetrics(db, runId).map((row) => row.id)).toEqual(["m-plain"]);
    expect(getRunDetail(db, runId).metrics.map((row) => row.id)).toEqual(["m-plain"]);
    expect(listProjectMetrics(db, "p1").map((row) => row.id)).toEqual(["m-plain"]);
  });

  it("raises a named error for a run that does not exist", () => {
    const db = open();
    expect(() => getRun(db, "gone")).toThrow(/RUN_NOT_FOUND/);
    expect(() => deleteRun(db, "gone")).toThrow(/RUN_NOT_FOUND/);
  });
});

describe("listFinishedScheduledRuns", () => {
  const SINCE = "2026-09-27T08:00:00.000Z";

  /** A run row as the worker leaves it: 10 answers planned, 7 collected, 3 failed. */
  function insertRun(
    id: string,
    status: string,
    finishedAt: string | null,
    options: { projectId?: string; trigger?: string } = {},
  ): void {
    db.prepare(
      `INSERT INTO runs (id, project_id, trigger, status, planned_calls, completed_calls,
                         failed_calls, config_snapshot, finished_at, created_at)
       VALUES (?, ?, ?, ?, 20, 14, 6, '{"scheduled":true}', ?, '2026-09-27T07:00:00.000Z')`,
    ).run(id, options.projectId ?? "p1", options.trigger ?? "scheduled", status, finishedAt);
  }

  const ids = (since: string) => listFinishedScheduledRuns(db, since).map((run) => run.runId);

  it("lists a scheduled run the worker finished, with what its notice needs", () => {
    const db = open();
    const runId = createRunLogic(db, "p1", {
      trigger: "scheduled",
      configSnapshot: { scheduled: true },
    });
    const [first] = listRunTasks(db, runId);
    db.prepare("UPDATE run_tasks SET status = 'done' WHERE run_id = ?").run(runId);
    db.prepare("UPDATE run_tasks SET status = 'failed' WHERE id = ?").run(first!.id);
    updateRunProgress(db, runId);

    expect(listFinishedScheduledRuns(db, "2026-01-01T00:00:00.000Z")).toEqual([
      {
        runId,
        projectId: "p1",
        projectName: "Acme Analytics",
        status: "partial",
        plannedCalls: 12,
        completedCalls: 10,
        failedCalls: 2,
        finishedAt: getRun(db, runId).finished_at,
      },
    ]);
  });

  it("lists only runs that finished after the timestamp", () => {
    open();
    insertRun("before", "completed", "2026-09-27T07:30:00.000Z");
    insertRun("at", "completed", SINCE);
    insertRun("after", "completed", "2026-09-27T08:00:00.001Z");
    expect(ids(SINCE)).toEqual(["after"]);
  });

  it("lists completed, partial and failed runs", () => {
    open();
    insertRun("completed", "completed", "2026-09-27T09:00:00.000Z");
    insertRun("partial", "partial", "2026-09-27T09:01:00.000Z");
    insertRun("failed", "failed", "2026-09-27T09:02:00.000Z");
    expect(ids(SINCE).sort()).toEqual(["completed", "failed", "partial"]);
  });

  it("leaves out a cancelled run, because the user stopped it and already knows", () => {
    open();
    insertRun("cancelled", "cancelled", "2026-09-27T09:00:00.000Z");
    expect(ids(SINCE)).toEqual([]);
  });

  it("leaves out runs started by hand and runs still going", () => {
    open();
    insertRun("manual", "completed", "2026-09-27T09:00:00.000Z", { trigger: "manual" });
    insertRun("running", "running", null);
    insertRun("queued", "queued", null);
    expect(ids(SINCE)).toEqual([]);
  });

  it("leaves out the demo project, whose history is generated", () => {
    open();
    db.prepare(
      "INSERT INTO projects (id, name, is_demo) VALUES ('demo', 'Globex Search', 1)",
    ).run();
    insertRun("demo-run", "completed", "2026-09-27T09:00:00.000Z", { projectId: "demo" });
    expect(ids(SINCE)).toEqual([]);
  });

  it("lists runs from every project, each with its own name", () => {
    open();
    seedProject(db, {
      id: "p2",
      name: "Northwind Metrics",
      brand: "Northwind Metrics",
      prompts: [],
    });
    insertRun("r-p2", "completed", "2026-09-27T09:00:00.000Z", { projectId: "p2" });
    expect(listFinishedScheduledRuns(db, SINCE)[0]?.projectName).toBe("Northwind Metrics");
  });

  it("returns the 20 newest, newest first", () => {
    open();
    for (let minute = 10; minute < 35; minute++) {
      insertRun(`r${minute}`, "completed", `2026-09-27T09:${minute}:00.000Z`);
    }
    const listed = ids(SINCE);
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe("r34");
    expect(listed.at(-1)).toBe("r15");
  });

  it("compares instants, whatever offset the timestamp is written in", () => {
    // 10:00 at +02:00 is 08:00 UTC. Compared as text, "09:00Z" sorts before
    // "10:00+02:00" and the run would be missed.
    open();
    insertRun("r1", "completed", "2026-09-27T09:00:00.000Z");
    expect(ids("2026-09-27T10:00:00.000+02:00")).toEqual(["r1"]);
  });

  it("refuses a timestamp that is not one", () => {
    open();
    expect(() => listFinishedScheduledRuns(db, "yesterday")).toThrow(/INVALID_SINCE/);
  });
});

describe("retry, cancel and delete", () => {
  it("sends failed tasks back to the queue", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    db.prepare(
      "UPDATE run_tasks SET status = 'failed', error = 'PROVIDER_5XX', attempts = 3 WHERE run_id = ?",
    ).run(runId);

    expect(retryFailed(db, runId)).toEqual({ requeued: 6 });
    expect(listRunTasks(db, runId).every((task) => task.status === "queued")).toBe(true);
  });

  it("cancels a run and fails what had not started", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    expect(cancelRun(db, runId)).toEqual({ cancelled: 6 });
    expect(getRun(db, runId).status).toBe("cancelled");
    expect(listRunTasks(db, runId).every((task) => task.error === CANCEL_ERROR)).toBe(true);
  });

  it("refuses to retry a cancelled run rather than requeuing work nothing can claim", () => {
    // The claimer only takes work from a run that is queued or running, and
    // `cancelled` is sticky, so requeued tasks would never run while the
    // failure list emptied and the progress bar went backwards.
    const db = open();
    const { runId } = createRun(db, "p1");
    cancelRun(db, runId);

    expect(() => retryFailed(db, runId)).toThrow(/RUN_CANCELLED/);
    expect(listRunTasks(db, runId).every((task) => task.status === "failed")).toBe(true);
  });

  it("deletes a run and everything hanging off it", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    deleteRun(db, runId);
    expect(listRunTasks(db, runId)).toEqual([]);
  });

  it("refuses to delete a run while one of its calls is with a provider", () => {
    const db = open();
    const { runId } = createRun(db, "p1");
    for (const status of ["in_flight", "extracting"]) {
      db.prepare(
        "UPDATE run_tasks SET status = ? WHERE id = (SELECT id FROM run_tasks WHERE run_id = ? LIMIT 1)",
      ).run(status, runId);
      expect(() => deleteRun(db, runId)).toThrow(/RUN_IN_FLIGHT/);
      expect(listRunTasks(db, runId)).toHaveLength(6);
    }
  });
});
