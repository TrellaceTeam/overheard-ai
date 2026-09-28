/**
 * Runs: what one would cost before it is started, starting it, watching it,
 * hearing that a scheduled one has finished, and the three things a user can
 * do to one afterwards (retry, cancel, delete).
 *
 * The run machinery lives in src/server/logic. This module adds two product
 * decisions: a project's first run also asks the perception question
 * (ADR 0004), and everything the run page reads comes back in one call.
 */
import type { Driver } from "../../db/driver";
import type { BrandObservationRow, RunMetricRow, RunRow, RunTaskRow } from "../../db/types";
import { cancelRun as cancelRunLogic } from "../../logic/cancel-run";
import { createPerceptionRun } from "../../logic/create-perception-run";
import { createRun as createRunLogic } from "../../logic/create-run";
import { planRun } from "../../logic/plan-run";
import { retryFailedTasks } from "../../logic/retry-failed-tasks";
import { perceptionCallsFor, type RunPlanCounts } from "@/lib/run-plan";
import type { FinishedScheduledRun } from "@/lib/scheduled-run-notices";
import type { RunProgress } from "../../logic/types";
import { readRunProgress } from "../../logic/update-run-progress";
import { runUsageTotal } from "../../logic/usage";
import { appendNotSelfReferenced, selfReferencedPromptIdsFor } from "./metrics";
import { listPromptSummaries, type PromptSummaryView } from "./summaries";
import {
  expectChanged,
  InvalidInputError,
  NotFoundError,
  refuseDemoForRun,
  refuseDemoProject,
} from "./shared";

/** Answers ordered oldest first, capped so one huge run cannot stall a page. */
const TASK_LIMIT = 400;

/** The dashboard's failure strip reads every project failure, bounded. */
const FAILED_ERROR_LIMIT = 2000;

/**
 * Failures are read on their own, not filtered out of the page of answers,
 * because a failed task can sit past the TASK_LIMIT page.
 */
const FAILED_TASK_LIMIT = 400;

/**
 * Observations are one per (answer, brand), so a wide run holds several
 * thousand, and the run screen polls for them while a run is live.
 */
const OBSERVATION_LIMIT = 4000;

/** Every open tab polls for finished scheduled runs, so one response holds at most this many. */
const FINISHED_SCHEDULED_LIMIT = 20;

export interface RunListItem {
  id: string;
  status: string;
  trigger: string;
  plannedCalls: number;
  completedCalls: number;
  failedCalls: number;
  createdAt: string;
  finishedAt: string | null;
  /**
   * True for the hidden run that only asks each assistant what it knows about
   * the brand. It has no prompts, no metrics and no results page, so a screen
   * counting completed runs leaves it out, or one click of Run now would count
   * as two runs.
   */
  perceptionOnly: boolean;
  /** True when the answers came from the mock provider mode. */
  mock: boolean;
}

export interface RunTaskView {
  id: string;
  status: string;
  iteration: number;
  answerText: string | null;
  error: string | null;
  /** The typed failure code for `error` (lib/failure-codes), or null when there is none. */
  failureCode: string | null;
  questionText: string | null;
  isPerception: boolean;
  promptId: string | null;
  promptText: string | null;
  modelId: string;
  modelDisplayName: string | null;
  /** The model version the provider said answered, or null when none was reported. */
  answerModel: string | null;
  createdAt: string;
  /** How many times this answer has been asked. >0 with status queued means a retry is pending. */
  attempts: number;
  /** When the queue may next claim this task. Only meaningful for queued rows. */
  nextAttemptAt: string;
}

export interface RunObservationView {
  id: string;
  runTaskId: string;
  position: number | null;
  mentionType: string;
  isCited: boolean;
  linkedUrl: string | null;
  brandId: string | null;
  brandName: string | null;
  rawName: string;
}

/**
 * What a run will cost, including the perception question a project's first
 * run also asks of each assistant. That spend is on the user's own key, so the
 * preview counts it.
 */
export interface RunPlanPreview extends RunPlanCounts {
  /** Extra calls the perception question adds. Zero after the first run. */
  perceptionCalls: number;
}

export function planRunPreview(db: Driver, projectId: string): RunPlanPreview {
  const plan = planRun(db, projectId);
  const firstRun = countRuns(db, projectId) === 0;
  const project = db
    .prepare("SELECT perception_prompt FROM projects WHERE id = ?")
    .get<{ perception_prompt: string | null }>(projectId);
  // A blank perception prompt is the off switch, so there is nothing to add.
  const perceptionOn = (project?.perception_prompt ?? "").trim() !== "";
  return {
    ...plan,
    perceptionCalls: firstRun && perceptionOn ? perceptionCallsFor(plan.assistants) : 0,
  };
}

export interface CreateRunOptions {
  /** Providers with a key, so the perception run can check the extractor too. */
  providersWithKeys?: ReadonlySet<string> | undefined;
}

export interface CreateRunResult {
  runId: string;
  plannedCalls: number;
  /** Provider calls the perception run adds on top. Zero when there is none. */
  perceptionCalls: number;
  /** The perception run created alongside the first measured run, if any. */
  perceptionRunId: string | null;
  /** Why no perception run was created, when one was expected. */
  perceptionSkipped: string | null;
}

/**
 * Start a measured run, and on a project's very first run, a perception run too.
 *
 * The first run pairs them because the dashboard's opening screen is the
 * perception band, and a first run that leaves it empty reads as a broken page.
 * Later runs are measured only. The band has its own Refresh button.
 *
 * A perception failure never fails the measured run. A missing key or a blank
 * question comes back as a sentence in perceptionSkipped, and the measured run
 * starts anyway, because that is the run the user asked for.
 */
export function createRun(
  db: Driver,
  projectId: string,
  options: CreateRunOptions = {},
): CreateRunResult {
  refuseDemoProject(db, projectId);
  const plan = planRun(db, projectId);
  const isFirstRun = countRuns(db, projectId) === 0;
  const runId = createRunLogic(db, projectId, { trigger: "manual" });

  let perceptionRunId: string | null = null;
  let perceptionSkipped: string | null = null;

  if (isFirstRun) {
    try {
      perceptionRunId = createPerceptionRun(
        db,
        projectId,
        options.providersWithKeys === undefined
          ? {}
          : { providersWithKeys: options.providersWithKeys },
      );
    } catch (error) {
      perceptionSkipped = error instanceof Error ? error.message : String(error);
    }
  }

  let perceptionCalls = 0;
  if (perceptionRunId !== null) {
    const row = db
      .prepare("SELECT planned_calls AS calls FROM runs WHERE id = ?")
      .get<{ calls: number }>(perceptionRunId);
    perceptionCalls = row?.calls ?? 0;
  }

  return { runId, plannedCalls: plan.calls, perceptionCalls, perceptionRunId, perceptionSkipped };
}

/** Ask the perception question again, on its own, without re-running prompts. */
export function createPerceptionRunOnly(
  db: Driver,
  projectId: string,
  options: CreateRunOptions = {},
): { runId: string; answers: number } {
  refuseDemoProject(db, projectId);
  const runId = createPerceptionRun(
    db,
    projectId,
    options.providersWithKeys === undefined ? {} : { providersWithKeys: options.providersWithKeys },
  );
  const answers = db
    .prepare("SELECT count(*) AS n FROM run_tasks WHERE run_id = ?")
    .get<{ n: number }>(runId);
  return { runId, answers: answers?.n ?? 0 };
}

/**
 * Newest first, with rowid as the final tiebreak. created_at holds whole
 * milliseconds, so two runs started by one press of Run now routinely share a
 * timestamp. id is a random uuid, so ordering on it would make an arbitrary
 * one of them the latest run. rowid follows insertion order. listProjects uses
 * the same tiebreak.
 */
export function listRuns(db: Driver, projectId: string, limit = 20): RunListItem[] {
  return db
    .prepare(
      `SELECT id, status, trigger, planned_calls AS plannedCalls,
              completed_calls AS completedCalls, failed_calls AS failedCalls,
              created_at AS createdAt, finished_at AS finishedAt,
              config_snapshot AS configSnapshot, mock AS mock
         FROM runs WHERE project_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all<
      Omit<RunListItem, "perceptionOnly" | "mock"> & {
        configSnapshot: string | null;
        mock: number;
      }
    >(projectId, Math.max(1, Math.min(200, limit)))
    .map(({ configSnapshot, ...row }) => ({
      ...row,
      mock: row.mock === 1,
      perceptionOnly: isPerceptionSnapshot(configSnapshot),
    }));
}

/**
 * Scheduled runs that reached completed, partial or failed after `since`,
 * across every project, newest first and capped. This is what the in-app
 * notice polls for.
 *
 * A cancelled run is left out, because the user stopped it and already knows.
 * The demo project is left out: its history is generated, and restoring it
 * writes scheduled runs that would read as news. finished_at is always
 * written by Date#toISOString, so comparing it to a normalized `since` as text
 * compares instants.
 */
export function listFinishedScheduledRuns(db: Driver, since: string): FinishedScheduledRun[] {
  const after = new Date(since);
  if (Number.isNaN(after.getTime())) {
    throw new InvalidInputError("INVALID_SINCE", "that is not a date and time");
  }
  return db
    .prepare(
      `SELECT r.id AS runId, r.project_id AS projectId, p.name AS projectName,
              r.status AS status, r.planned_calls AS plannedCalls,
              r.completed_calls AS completedCalls, r.failed_calls AS failedCalls,
              r.finished_at AS finishedAt
         FROM runs r
         JOIN projects p ON p.id = r.project_id
        WHERE r.trigger = 'scheduled'
          AND r.status IN ('completed','partial','failed')
          AND r.finished_at > ?
          AND p.is_demo = 0
        ORDER BY r.finished_at DESC, r.rowid DESC
        LIMIT ?`,
    )
    .all<FinishedScheduledRun>(after.toISOString(), FINISHED_SCHEDULED_LIMIT);
}

/** Perception runs, from createPerceptionRun and the demo generator, carry `{"perception_only": true}`. */
export function isPerceptionSnapshot(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>)["perception_only"] === true
    );
  } catch {
    return false;
  }
}

export function getRun(db: Driver, runId: string): RunRow {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get<RunRow>(runId);
  if (!row) throw new NotFoundError("RUN_NOT_FOUND", "that run does not exist");
  return row;
}

/**
 * Every task from the moment the run starts, not only the ones with an answer,
 * so a run in progress shows the questions still outstanding.
 */
export function listRunTasks(db: Driver, runId: string): RunTaskView[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.status AS status, t.iteration AS iteration,
              t.answer_text AS answerText, t.error AS error,
              t.failure_code AS failureCode,
              t.question_text AS questionText, t.is_perception AS isPerception,
              t.prompt_id AS promptId, p.text AS promptText,
              t.model_id AS modelId, m.display_name AS modelDisplayName,
              t.answer_model AS answerModel,
              t.created_at AS createdAt,
              t.attempts AS attempts, t.next_attempt_at AS nextAttemptAt
         FROM run_tasks t
         LEFT JOIN prompts p ON p.id = t.prompt_id
         LEFT JOIN models m ON m.id = t.model_id
        WHERE t.run_id = ?
        ORDER BY t.created_at, t.id
        LIMIT ?`,
    )
    .all<Omit<RunTaskView, "isPerception"> & { isPerception: number }>(runId, TASK_LIMIT)
    .map((row) => ({ ...row, isPerception: row.isPerception === 1 }));
}

export function listRunObservations(db: Driver, runId: string): RunObservationView[] {
  return db
    .prepare(
      `SELECT o.id AS id, o.run_task_id AS runTaskId, o.position AS position,
              o.mention_type AS mentionType, o.is_cited AS isCited,
              o.linked_url AS linkedUrl, o.brand_id AS brandId, o.raw_name AS rawName,
              b.name AS brandName
         FROM brand_observations o
         LEFT JOIN brands b ON b.id = o.brand_id
        WHERE o.run_id = ?
        ORDER BY o.created_at, o.id
        LIMIT ?`,
    )
    .all<Omit<RunObservationView, "isCited"> & { isCited: number }>(runId, OBSERVATION_LIMIT)
    .map((row) => ({ ...row, isCited: row.isCited === 1 }));
}

/** Every failure across the project, for the dashboard's failure strip. */
export function listFailedTaskErrors(
  db: Driver,
  projectId: string,
): { runId: string; code: string | null; error: string | null }[] {
  return db
    .prepare(
      `SELECT run_id AS runId, failure_code AS code, error FROM run_tasks
        WHERE project_id = ? AND status = 'failed'
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all<{ runId: string; code: string | null; error: string | null }>(
      projectId,
      FAILED_ERROR_LIMIT,
    );
}

/**
 * The run's own level 0 metric rows, never the run-wide aggregate.
 *
 * The scope test is model_id alone, the same test projectMetricWindow uses, so
 * the run page and the dashboard read the same rows for a run. Self-referenced
 * prompts are left out by the same rule.
 */
export function listRunMetrics(db: Driver, runId: string): RunMetricRow[] {
  const run = db
    .prepare("SELECT project_id AS projectId FROM runs WHERE id = ?")
    .get<{ projectId: string }>(runId);
  const where = ["run_id = ?", "model_id IS NOT NULL"];
  const params: (string | number)[] = [runId];
  if (run) {
    appendNotSelfReferenced(
      where,
      params,
      selfReferencedPromptIdsFor(db, run.projectId),
      "prompt_id",
    );
  }
  return db
    .prepare(
      `SELECT * FROM run_metrics
        WHERE ${where.join(" AND ")}
        ORDER BY created_at, id`,
    )
    .all<RunMetricRow>(...params);
}

/** A run's failed tasks, read directly rather than filtered out of a page. */
export function listRunFailures(db: Driver, runId: string): RunTaskView[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.status AS status, t.iteration AS iteration,
              t.answer_text AS answerText, t.error AS error,
              t.failure_code AS failureCode,
              t.question_text AS questionText, t.is_perception AS isPerception,
              t.prompt_id AS promptId, p.text AS promptText,
              t.model_id AS modelId, m.display_name AS modelDisplayName,
              t.answer_model AS answerModel,
              t.created_at AS createdAt,
              t.attempts AS attempts, t.next_attempt_at AS nextAttemptAt
         FROM run_tasks t
         LEFT JOIN prompts p ON p.id = t.prompt_id
         LEFT JOIN models m ON m.id = t.model_id
        WHERE t.run_id = ? AND t.status = 'failed'
        ORDER BY t.created_at, t.id
        LIMIT ?`,
    )
    .all<Omit<RunTaskView, "isPerception"> & { isPerception: number }>(runId, FAILED_TASK_LIMIT)
    .map((row) => ({ ...row, isPerception: row.isPerception === 1 }));
}

/** Counts over every task in the run, not over the page of them a screen holds. */
function countRunTasks(db: Driver, runId: string): { total: number; perception: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              sum(CASE WHEN is_perception = 1 THEN 1 ELSE 0 END) AS perception
         FROM run_tasks WHERE run_id = ?`,
    )
    .get<{ total: number; perception: number | null }>(runId);
  return { total: row?.total ?? 0, perception: row?.perception ?? 0 };
}

export interface RunDetail {
  run: RunRow;
  progress: RunProgress;
  tasks: RunTaskView[];
  failures: RunTaskView[];
  observations: RunObservationView[];
  metrics: RunMetricRow[];
  /** Estimated spend on the user's own keys. Prices are list rates. */
  estimatedCostUsd: number;
  /** A perception-only run has no Results tab. */
  perceptionOnly: boolean;
  /** Every task in the run. `tasks` carries at most `taskLimit` of them. */
  taskTotal: number;
  taskLimit: number;
  /** One row per prompt with answers: the stored summary if any, and what asking now would roughly cost. */
  promptSummaries: PromptSummaryView[];
}

/**
 * Everything the run screen renders, in one call.
 *
 * The progress counters are recomputed from the tasks, not read off the row,
 * so a page opened between worker passes shows current numbers.
 */
export function getRunDetail(db: Driver, runId: string): RunDetail {
  const run = getRun(db, runId);
  // Recomputed, not written: this is a read, and the worker persists progress.
  const progress = readRunProgress(db, runId);
  const tasks = listRunTasks(db, runId);
  const counts = countRunTasks(db, runId);
  return {
    run: { ...run, status: progress.status },
    progress,
    tasks,
    failures: listRunFailures(db, runId),
    observations: listRunObservations(db, runId),
    metrics: listRunMetrics(db, runId),
    estimatedCostUsd: runUsageTotal(db, runId),
    perceptionOnly: counts.total > 0 && counts.perception === counts.total,
    taskTotal: counts.total,
    taskLimit: TASK_LIMIT,
    promptSummaries: listPromptSummaries(db, runId),
  };
}

/** Send a run's failed tasks back to the queue. Returns how many moved. */
export function retryFailed(db: Driver, runId: string): { requeued: number } {
  refuseDemoForRun(db, runId);
  return { requeued: retryFailedTasks(db, runId) };
}

/**
 * Stop a run. Queued and answered tasks are failed. A task already talking to
 * a provider finishes that call, so the answer is not paid for twice, then
 * stops because the worker will not claim it again.
 */
export function cancelRun(db: Driver, runId: string): { cancelled: number } {
  refuseDemoForRun(db, runId);
  return { cancelled: cancelRunLogic(db, runId) };
}

/**
 * Delete a run, and with it its tasks, observations and metrics. Refused while
 * any of its calls is with a provider: the call is billed either way, and its
 * answer and usage row would land on a deleted run.
 */
export function deleteRun(db: Driver, runId: string): { ok: true } {
  refuseDemoForRun(db, runId);
  return db.transaction(() => {
    const inFlight = db
      .prepare(
        "SELECT count(*) AS n FROM run_tasks WHERE run_id = ? AND status IN ('in_flight','extracting')",
      )
      .get<{ n: number }>(runId);
    if ((inFlight?.n ?? 0) > 0) {
      throw new InvalidInputError(
        "RUN_IN_FLIGHT",
        "this run still has calls in progress. Cancel it, wait for them to finish, then delete it",
      );
    }
    const changes = db.prepare("DELETE FROM runs WHERE id = ?").run(runId).changes;
    expectChanged(changes, "RUN_NOT_FOUND", "that run does not exist");
    return { ok: true as const };
  });
}

function countRuns(db: Driver, projectId: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM runs WHERE project_id = ?")
    .get<{ n: number }>(projectId);
  return row?.n ?? 0;
}

/** Re-exported so a caller does not need two imports to read a row type. */
export type { BrandObservationRow, RunMetricRow, RunRow, RunTaskRow };
