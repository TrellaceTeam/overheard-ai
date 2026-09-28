/**
 * The whole product, once, through the operations the screens call.
 *
 * OVERHEARD_MOCK_PROVIDERS=1 makes callProvider return canned answers and canned
 * extractor JSON, so this exercises create project, plan, run, drain, finalise,
 * perception, recovery and cancel without a key, a network or a penny of spend.
 * Everything here is the real code path: the same operations, the same logic
 * layer, the same worker pass. Only the provider is fiction.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import { freshDb, HAIKU, SONNET } from "../logic/test-support";
import { CANCEL_ERROR } from "../logic/cancel-run";
import { claimTasks } from "../logic/claim-tasks";
import { finalizeRun } from "../logic/finalize-run";
import { enqueueScheduledRuns } from "../logic/scheduler";
import { bootRecovery } from "../logic/recovery";
import { readRunProgress, updateRunProgress } from "../logic/update-run-progress";
import { configuredProviders } from "../worker/keys";
import { runWorkerPass } from "../worker/pass";
import { createCompetitor, listBrandsFull } from "./ops/brands";
import { aggregateBrand } from "@/lib/metrics";
import { listProjectMetrics } from "./ops/metrics";
import { getPerceptionState } from "./ops/perception";
import { createProject } from "./ops/projects";
import { listPrompts } from "./ops/prompts";
import {
  cancelRun,
  createRun,
  getRunDetail,
  listRunMetrics,
  listRuns,
  listRunTasks,
  planRunPreview,
  retryFailed,
} from "./ops/runs";
import { saveSchedule } from "./ops/schedules";

let db: Driver;
let mockBefore: string | undefined;

beforeEach(() => {
  mockBefore = process.env["OVERHEARD_MOCK_PROVIDERS"];
  process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
  db = freshDb();
});

afterEach(() => {
  if (mockBefore === undefined) delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  else process.env["OVERHEARD_MOCK_PROVIDERS"] = mockBefore;
  db.close();
});

/** A project with two brands, two questions and one assistant. */
function seedWizard(db: Driver): string {
  const { projectId } = createProject(
    db,
    {
      brandName: "Acme Analytics",
      category: "analytics tools",
      domains: ["acme.example.com"],
      competitors: ["Northwind Metrics"],
      prompts: [
        { text: "What are the best analytics tools?", tag: "visibility" },
        { text: "Which analytics tool would you recommend?", tag: "comparison" },
      ],
      extractionModelId: HAIKU,
      monitoredModelIds: [SONNET],
    },
    { providersWithKeys: configuredProviders() },
  );

  // One iteration each keeps the drain short. The wizard's default is three.
  db.prepare("UPDATE prompts SET iterations = 1 WHERE project_id = ?").run(projectId);
  return projectId;
}

/**
 * Run passes until nothing is left to claim, or give up loudly. Reads progress
 * without writing it, so every stored status a test asserts on was written by
 * the worker.
 */
async function drain(db: Driver, runIds: readonly string[]): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    await runWorkerPass(db, { budgetMs: 5_000, lockedBy: `test-${pass}` });
    if (runIds.every((runId) => readRunProgress(db, runId).pending === 0)) return;
  }
  throw new Error("the run never drained");
}

function storedRun(db: Driver, runId: string) {
  return db
    .prepare("SELECT status, failed_calls, finished_at, finalised_at FROM runs WHERE id = ?")
    .get<{
      status: string;
      failed_calls: number;
      finished_at: string | null;
      finalised_at: string | null;
    }>(runId)!;
}

describe("a project from the wizard to a finished run", () => {
  it("creates, plans, runs, finalises and summarises", async () => {
    const projectId = seedWizard(db);

    expect(listBrandsFull(db, projectId).map((brand) => brand.role)).toEqual([
      "target",
      "competitor",
    ]);
    expect(listPrompts(db, projectId)).toHaveLength(2);

    // The plan is what the Run button shows before anything is spent, and on a
    // first run that includes the perception question the run also asks.
    expect(planRunPreview(db, projectId)).toEqual({
      prompts: 2,
      assistants: 1,
      answers: 2,
      calls: 4,
      perceptionCalls: 2,
    });

    const run = createRun(db, projectId, { providersWithKeys: new Set(configuredProviders()) });
    expect(run.plannedCalls).toBe(4);
    expect(run.perceptionRunId).not.toBeNull();
    expect(run.perceptionSkipped).toBeNull();

    await drain(db, [run.runId, run.perceptionRunId!]);

    const detail = getRunDetail(db, run.runId);
    expect(detail.run.status).toBe("completed");
    expect(detail.progress).toMatchObject({ pending: 0, completedCalls: 4, failedCalls: 0 });
    expect(detail.tasks).toHaveLength(2);
    expect(detail.tasks.every((task) => task.answerText !== null)).toBe(true);
    expect(detail.observations.length).toBeGreaterThan(0);
    expect(detail.metrics.length).toBeGreaterThan(0);

    // Level 0 rows reached the dashboard read, and aggregate the way its cards do.
    const metrics = listProjectMetrics(db, projectId);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.every((row) => row.model_id !== null)).toBe(true);

    const target = listBrandsFull(db, projectId).find((brand) => brand.role === "target")!;
    const targetAgg = aggregateBrand(metrics, target.id);
    expect(targetAgg.answers).toBe(2);
    expect(targetAgg.mentions).toBeGreaterThan(0);

    // The canned answer links the project's own domain, so the citation rate is
    // above zero...
    expect(targetAgg.citation_rate).toBeGreaterThan(0);

    // ...and it names brands the project does not track, so "Discovered in
    // answers" has something in it and the promote button can be reached.
    const discovered = listBrandsFull(db, projectId).filter((brand) => brand.role === "discovered");
    expect(discovered.length).toBeGreaterThan(0);

    // The perception run wrote its own summaries, including the merged row.
    const perception = getPerceptionState(db, projectId);
    expect(perception.summaries.length).toBeGreaterThan(0);
    expect(perception.summaries.some((summary) => summary.modelId === null)).toBe(true);
    expect(perception.stale).toBe(false);

    // A perception task never produces an observation.
    const perceptionTasks = listRunTasks(db, run.perceptionRunId!);
    expect(perceptionTasks.every((task) => task.isPerception)).toBe(true);
    const observations = db
      .prepare(
        `SELECT count(*) AS n FROM brand_observations o
           JOIN run_tasks t ON t.id = o.run_task_id WHERE t.is_perception = 1`,
      )
      .get<{ n: number }>();
    expect(observations?.n).toBe(0);
  });

  it("recovers a run that was interrupted mid-flight", async () => {
    const projectId = seedWizard(db);
    const run = createRun(db, projectId);

    // Claim without processing: what a process that died holding the lock leaves.
    const claimed = claimTasks(db, 10, "pid1-dead");
    expect(claimed.length).toBeGreaterThan(0);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM run_tasks WHERE status = 'in_flight'")
        .get<{ n: number }>()?.n,
    ).toBe(claimed.length);

    const recovered = bootRecovery(db);
    expect(recovered.requeued).toBe(claimed.length);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM run_tasks WHERE status = 'in_flight' OR locked_by IS NOT NULL",
        )
        .get<{ n: number }>()?.n,
    ).toBe(0);

    // And the run still finishes: recovery hands the work back, it does not lose it.
    await drain(db, [run.runId, run.perceptionRunId!]);
    expect(getRunDetail(db, run.runId).run.status).toBe("completed");
  });

  it("returns a bought answer to extraction rather than re-buying it", () => {
    const projectId = seedWizard(db);
    createRun(db, projectId);

    const first = claimTasks(db, 1, "pid1-dead")[0]!;
    db.prepare(
      "UPDATE run_tasks SET status = 'extracting', answer_text = 'a paid for answer' WHERE id = ?",
    ).run(first.task.id);

    expect(bootRecovery(db).returnedToAnswered).toBe(1);
    const after = db
      .prepare("SELECT status, answer_text FROM run_tasks WHERE id = ?")
      .get<{ status: string; answer_text: string | null }>(first.task.id);
    expect(after).toEqual({ status: "answered", answer_text: "a paid for answer" });
  });

  it("cancels a fresh run and the worker leaves it alone", async () => {
    const projectId = seedWizard(db);
    const first = createRun(db, projectId);
    await drain(db, [first.runId, first.perceptionRunId!]);

    const second = createRun(db, projectId);
    expect(second.perceptionRunId).toBeNull();

    const cancelled = cancelRun(db, second.runId);
    expect(cancelled.cancelled).toBe(2);

    const detail = getRunDetail(db, second.runId);
    expect(detail.run.status).toBe("cancelled");
    expect(detail.tasks.every((task) => task.status === "failed")).toBe(true);
    expect(detail.tasks.every((task) => task.error === CANCEL_ERROR)).toBe(true);

    // A pass over a cancelled run claims nothing.
    const result = await runWorkerPass(db, { budgetMs: 1_000, lockedBy: "after-cancel" });
    expect(result.processed).toBe(0);
    expect(updateRunProgress(db, second.runId).status).toBe("cancelled");
  });

  it("scores a run cancelled while it held only answered tasks", async () => {
    const projectId = seedWizard(db);
    const first = createRun(db, projectId);
    await drain(db, [first.runId, first.perceptionRunId!]);

    const second = createRun(db, projectId);
    db.prepare(
      "UPDATE run_tasks SET status = 'answered', answer_text = 'bought, not yet read' WHERE run_id = ?",
    ).run(second.runId);
    cancelRun(db, second.runId);

    await runWorkerPass(db, { budgetMs: 1_000, lockedBy: "after-cancel" });

    const run = storedRun(db, second.runId);
    expect(run.status).toBe("cancelled");
    expect(run.finalised_at).not.toBeNull();
  });

  it("adds a competitor afterwards without inventing numbers for it", async () => {
    const projectId = seedWizard(db);
    const run = createRun(db, projectId);
    await drain(db, [run.runId, run.perceptionRunId!]);

    const { id } = createCompetitor(db, {
      projectId,
      name: "Contoso Insights",
      domain: "contoso.example.com",
    });

    // No metric row yet, so the screens leave it out rather than show a zero.
    const metrics = listProjectMetrics(db, projectId);
    expect(metrics.some((row) => row.brand_id === id)).toBe(false);
    expect(aggregateBrand(metrics, id).mentions).toBe(0);
  });

  it("finalises the same run twice and writes the same numbers", async () => {
    const projectId = seedWizard(db);
    const run = createRun(db, projectId);
    await drain(db, [run.runId, run.perceptionRunId!]);

    // Ordered by the scope, not by id: a re-finalise writes fresh ids, and the
    // claim is that the numbers repeat, not that the surrogate key does.
    const allRows = () =>
      db
        .prepare(
          `SELECT run_id, project_id, model_id, prompt_id, brand_id, answers, mentions,
                  ranked, citations, mention_rate, rank_rate, citation_rate,
                  link_when_mentioned, avg_rank, best_rank, worst_rank, rank_stddev,
                  share_of_voice, top_pick_share, top3_rate
             FROM run_metrics WHERE run_id = ?
            ORDER BY coalesce(model_id,''), coalesce(prompt_id,''), coalesce(brand_id,'')`,
        )
        .all<Record<string, unknown>>(run.runId);

    const first = allRows();
    expect(first.length).toBeGreaterThan(0);
    expect(listRunMetrics(db, run.runId).length).toBeGreaterThan(0);

    // The worker already finalised this run. Doing it again is what a crash
    // between the delete and the insert, or a duplicate pass, would cause.
    const second = finalizeRun(db, run.runId);
    expect(second.metricRows).toBe(first.length);
    expect(allRows()).toEqual(first);

    // And the unique index still holds: no scope gained a second row.
    const scopes = db
      .prepare(
        `SELECT count(*) AS n FROM (
           SELECT 1 FROM run_metrics WHERE run_id = ?
            GROUP BY coalesce(model_id,''), coalesce(prompt_id,''), coalesce(brand_id,'')
           HAVING count(*) > 1)`,
      )
      .get<{ n: number }>();
    expect(scopes?.n).toBe(0);
  });

  it("retries a failed task into the same run and the numbers close up", async () => {
    const projectId = seedWizard(db);
    const run = createRun(db, projectId);

    // One measured task dies the way an exhausted task does: failed, no answer.
    const doomed = db
      .prepare("SELECT id FROM run_tasks WHERE run_id = ? LIMIT 1")
      .get<{ id: string }>(run.runId)!;
    db.prepare(
      "UPDATE run_tasks SET status = 'failed', attempts = 3, error = 'PROVIDER_ERROR: mock' WHERE id = ?",
    ).run(doomed.id);

    await drain(db, [run.perceptionRunId!]);
    await runWorkerPass(db, { budgetMs: 5_000, lockedBy: "before-retry" });

    const failed = getRunDetail(db, run.runId);
    expect(failed.run.status).toBe("partial");
    expect(failed.progress.pending).toBe(0);
    expect(failed.failures).toHaveLength(1);

    expect(retryFailed(db, run.runId)).toEqual({ requeued: 1 });
    expect(updateRunProgress(db, run.runId).status).toBe("running");

    await drain(db, [run.runId]);

    // Same run, not a second one, so the denominators did not split.
    const healed = getRunDetail(db, run.runId);
    expect(healed.run.status).toBe("completed");
    expect(healed.progress).toMatchObject({ pending: 0, completedCalls: 4, failedCalls: 0 });
    // Two runs, the measured one and its perception pair. The retry did not
    // open a third with its own denominators.
    expect(listRuns(db, projectId).map((row) => row.id)).toContain(run.runId);
    expect(listRuns(db, projectId)).toHaveLength(2);
    expect(listRunMetrics(db, run.runId).length).toBeGreaterThan(0);
  });

  it("fires a schedule that came due while the process was down, once", () => {
    const projectId = seedWizard(db);
    saveSchedule(db, { projectId, cadence: "daily", hourUtc: 3, timezone: "UTC" });

    // The occurrence passed while nothing was running.
    const due = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE project_id = ?").run(due, projectId);

    expect(bootRecovery(db).requeued).toBe(0);

    expect(enqueueScheduledRuns(db)).toEqual({ created: 1, skipped: 0 });

    // next_run_at moved forward, so a second sweep in the same minute is a no-op
    // rather than a backlog of every occurrence missed while the process was down.
    const second = enqueueScheduledRuns(db);
    expect(second.created).toBe(0);
    expect(listRuns(db, projectId).filter((row) => row.trigger === "scheduled")).toHaveLength(1);

    const next = db
      .prepare("SELECT next_run_at FROM schedules WHERE project_id = ?")
      .get<{ next_run_at: string }>(projectId)!;
    expect(next.next_run_at > new Date().toISOString()).toBe(true);
  });
});

describe("a run whose every call fails on the network", () => {
  const realFetch = globalThis.fetch;
  let keyBefore: string | undefined;

  beforeEach(() => {
    delete process.env["OVERHEARD_MOCK_PROVIDERS"];
    keyBefore = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-offline-0000";
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (keyBefore === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = keyBefore;
  });

  it("ends failed, is scored, and leaves the project's schedule free", async () => {
    const projectId = seedWizard(db);
    const run = createRun(db, projectId, { providersWithKeys: new Set(configuredProviders()) });

    for (let pass = 0; pass < 4; pass += 1) {
      await runWorkerPass(db, { budgetMs: 5_000, lockedBy: `offline-${pass}` });
      db.prepare("UPDATE run_tasks SET next_attempt_at = ?").run("2000-01-01T00:00:00.000Z");
    }

    for (const runId of [run.runId, run.perceptionRunId!]) {
      const stored = storedRun(db, runId);
      expect(stored.status).toBe("failed");
      expect(stored.finished_at).not.toBeNull();
      expect(stored.finalised_at).not.toBeNull();
    }
    expect(storedRun(db, run.runId).failed_calls).toBe(4);

    saveSchedule(db, { projectId, cadence: "daily", hourUtc: 3, timezone: "UTC" });
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE project_id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      projectId,
    );
    expect(enqueueScheduledRuns(db)).toEqual({ created: 1, skipped: 0 });
  });
});
