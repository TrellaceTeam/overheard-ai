/**
 * Perception: what the assistants say about the brand in prose, as opposed to
 * where they rank it.
 *
 * The summaries are written by the worker. Everything here is a read, plus the
 * staleness test the dashboard band shows: a summary is stale when the question
 * it was answered from is not the question the project asks today. That is
 * decided by comparing the stored question_text against the resolved current
 * prompt, not by a version number, so editing the prompt and editing it back
 * leaves the band alone.
 */
import type { Driver } from "../../db/driver";
import type { PerceptionSummaryRow } from "../../db/types";
import { resolvePerceptionPrompt, perceptionEnabled } from "@/lib/perception";
import { NotFoundError } from "./shared";
import { isPerceptionSnapshot } from "./runs";
import type { StoredFailure } from "@/lib/failure-codes";

export interface PerceptionSummaryView {
  modelId: string | null;
  /** The assistant's display name, or null on the merged across-assistants row. */
  modelName: string | null;
  questionText: string | null;
  knowsBrand: boolean;
  whatItDoes: string | null;
  typicalCustomers: string | null;
  wellRegardedFor: string | null;
  downsides: string | null;
  sourceAnswers: number;
  updatedAt: string;
}

function toView(row: PerceptionSummaryRow, modelName: string | null): PerceptionSummaryView {
  return {
    modelId: row.model_id,
    modelName,
    questionText: row.question_text,
    knowsBrand: row.knows_brand === 1,
    whatItDoes: row.what_it_does,
    typicalCustomers: row.typical_customers,
    wellRegardedFor: row.well_regarded_for,
    downsides: row.downsides,
    sourceAnswers: row.source_answers,
    updatedAt: row.updated_at,
  };
}

/**
 * Every stored summary, the merged row first.
 *
 * The merged row carries a null model_id, and the band shows it by default.
 * The assistant filter switches to the per-assistant rows.
 */
export function listPerceptionSummaries(db: Driver, projectId: string): PerceptionSummaryView[] {
  const rows = db
    .prepare(
      `SELECT * FROM perception_summaries
        WHERE project_id = ?
        ORDER BY model_id IS NOT NULL, updated_at DESC`,
    )
    .all<PerceptionSummaryRow>(projectId);

  const names = new Map(
    db
      .prepare("SELECT id, display_name AS displayName FROM models")
      .all<{ id: string; displayName: string }>()
      .map((model) => [model.id, model.displayName] as const),
  );

  return rows.map((row) =>
    toView(row, row.model_id === null ? null : (names.get(row.model_id) ?? null)),
  );
}

export interface PerceptionState {
  /** The prompt as stored, with the {brand} token still in it. */
  prompt: string;
  /** The same prompt with the target brand substituted, which is what is asked. */
  resolvedQuestion: string;
  /** A blank prompt is the off switch. There is no separate enabled flag. */
  enabled: boolean;
  summaries: PerceptionSummaryView[];
  /** True when a summary exists but answers a different question from the one the project asks now. */
  stale: boolean;
  /**
   * The newest perception-only run, whether the first run's pair or a later
   * Ask again. Null when the project has never asked. The band reads this to
   * say a check is still running or has failed, because nobody is taken to the
   * run's own page.
   */
  lastRun: PerceptionRunView | null;
}

/**
 * One perception-only run, counted from its tasks, not its stored counters,
 * which can lag behind the rows.
 */
export interface PerceptionRunView {
  runId: string;
  /** The stored run status. `cancelled` is sticky, and the band stays quiet about those. */
  status: string;
  totalTasks: number;
  doneTasks: number;
  failedTasks: number;
  /** Tasks neither done nor failed, so the run is still being worked. */
  pendingTasks: number;
  /** The failed tasks' stored failures, typed code (or null) plus detail, bounded. The band names the dominant one. */
  failedReasons: StoredFailure[];
  createdAt: string;
}

/**
 * How many LIKE-prefiltered candidates to verify. Only the two perception-run
 * writers (createPerceptionRun and the demo generator) put "perception_only"
 * in a snapshot, so the newest candidates are the project's newest perception
 * runs. The cap only bounds the read.
 */
const PERCEPTION_RUN_CANDIDATES = 20;

/** How many failed errors travel with it. The band only names the dominant one. */
const PERCEPTION_ERROR_LIMIT = 50;

function lastPerceptionRun(db: Driver, projectId: string): PerceptionRunView | null {
  // The LIKE clause is a coarse prefilter. isPerceptionSnapshot decides,
  // applied to the candidates newest first. Together they find the newest
  // perception run however many measured runs came after it, which a fixed
  // lookback over all runs would miss.
  const runs = db
    .prepare(
      `SELECT id, status, created_at, config_snapshot FROM runs
        WHERE project_id = ? AND config_snapshot LIKE '%perception_only%'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all<{
      id: string;
      status: string;
      created_at: string;
      config_snapshot: string | null;
    }>(projectId, PERCEPTION_RUN_CANDIDATES);
  const run = runs.find((row) => isPerceptionSnapshot(row.config_snapshot));
  if (!run) return null;

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM run_tasks WHERE run_id = ?`,
    )
    .get<{ total: number; done: number | null; failed: number | null }>(run.id);
  const total = counts?.total ?? 0;
  const done = counts?.done ?? 0;
  const failed = counts?.failed ?? 0;

  const failedReasons = db
    .prepare(
      `SELECT failure_code AS code, error FROM run_tasks
        WHERE run_id = ? AND status = 'failed'
        ORDER BY created_at, id LIMIT ?`,
    )
    .all<{ code: string | null; error: string | null }>(run.id, PERCEPTION_ERROR_LIMIT);

  return {
    runId: run.id,
    status: run.status,
    totalTasks: total,
    doneTasks: done,
    failedTasks: failed,
    pendingTasks: total - done - failed,
    failedReasons,
    createdAt: run.created_at,
  };
}

/** Everything the dashboard band and the settings section need, in one call. */
export function getPerceptionState(db: Driver, projectId: string): PerceptionState {
  const project = db
    .prepare("SELECT perception_prompt AS prompt FROM projects WHERE id = ?")
    .get<{ prompt: string }>(projectId);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "that project does not exist");

  const brand = db
    .prepare(
      `SELECT name FROM brands
        WHERE project_id = ? AND role = 'target' AND is_active = 1
        ORDER BY created_at LIMIT 1`,
    )
    .get<{ name: string }>(projectId);

  const resolvedQuestion = resolvePerceptionPrompt(project.prompt, brand?.name ?? null);
  const summaries = listPerceptionSummaries(db, projectId);
  const answered = summaries.filter((summary) => summary.questionText !== null);

  return {
    prompt: project.prompt,
    resolvedQuestion,
    enabled: perceptionEnabled(project.prompt),
    summaries,
    // Stale only when something has been answered. An empty band is unasked,
    // not stale, and the screen says different things for the two.
    stale:
      answered.length > 0 &&
      answered.every((summary) => summary.questionText?.trim() !== resolvedQuestion.trim()),
    lastRun: lastPerceptionRun(db, projectId),
  };
}
