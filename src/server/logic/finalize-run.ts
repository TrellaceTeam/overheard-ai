/**
 * Computing `run_metrics` for a finished run, at both scope levels: one row per
 * (model, prompt, brand) and one aggregate row with model and prompt null.
 *
 * Checked against the fixtures in __fixtures__/finalize-run/, which the reference
 * PL/pgSQL generated under PGlite, an embedded PostgreSQL. Read
 * scripts/finalize-run-oracle/README.md before changing anything here: several of
 * the rules are easy to get subtly wrong and hard to spot by eye.
 *
 * Delete-then-insert inside one transaction, so running it twice writes the same
 * rows. It does not decide the run status; updateRunProgress does.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import type { FinalizeSummary, RunProgress } from "./types";
import { updateRunProgress } from "./update-run-progress";

/** Rates take 4 decimals and ranks 2, matching the Postgres numeric scales. */
const RATE_DP = 4;
const RANK_DP = 2;

/** One observation of a resolved brand in one done, non-perception answer. */
interface ObservationRow {
  task_id: string;
  model_id: string;
  prompt_id: string | null;
  brand_id: string;
  position: number | null;
  is_cited: number;
}

/** One row per (answer, brand), however often the brand was named. */
interface PerTask {
  modelId: string;
  promptId: string | null;
  brandId: string;
  /** min(position) over the group. Null when the brand was never ranked. */
  pos: number | null;
  isRanked: number;
  isCited: number;
  isTop: number;
  isTop3: number;
}

/** One brand's totals within one scope, at one scope level. */
interface Aggregate {
  modelId: string | null;
  promptId: string | null;
  brandId: string;
  mentions: number;
  ranked: number;
  citations: number;
  tops: number;
  top3: number;
  positions: number[];
}

const OBSERVATION_SQL = `
  SELECT t.id AS task_id, t.model_id, t.prompt_id, o.brand_id, o.position, o.is_cited
    FROM run_tasks t
    JOIN brand_observations o ON o.run_task_id = t.id
   WHERE t.run_id = ? AND t.status = 'done' AND t.is_perception = 0
     AND o.brand_id IS NOT NULL`;

const TASK_SQL = `
  SELECT id, model_id, prompt_id FROM run_tasks
   WHERE run_id = ? AND status = 'done' AND is_perception = 0`;

const INSERT_SQL = `
  INSERT INTO run_metrics (
    id, run_id, project_id, model_id, prompt_id, brand_id,
    answers, mentions, ranked, citations,
    mention_rate, rank_rate, citation_rate, link_when_mentioned,
    avg_rank, best_rank, worst_rank, rank_stddev, share_of_voice, top_pick_share,
    top3_rate, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Postgres round() on numeric rounds half away from zero, and Math.round rounds
 * half towards positive infinity. They agree because no value rounded here is
 * negative.
 */
function roundTo(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** A zero denominator gives null, the way dividing by nullif(x, 0) does in SQL. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : roundTo(numerator / denominator, RATE_DP);
}

/**
 * Population standard deviation, not sample. A single observation gives 0, not
 * null; no observations at all gives null, which finalisation then coalesces to
 * 0.00. SQLite has no built-in for this, so it is computed here.
 */
export function stddevPop(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Groups observations into one row per (answer, brand). */
function buildPerTask(rows: readonly ObservationRow[]): PerTask[] {
  const groups = new Map<string, PerTask>();
  for (const row of rows) {
    const key = `${row.task_id}\u0000${row.brand_id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        modelId: row.model_id,
        promptId: row.prompt_id,
        brandId: row.brand_id,
        pos: null,
        isRanked: 0,
        isCited: 0,
        isTop: 0,
        isTop3: 0,
      };
      groups.set(key, group);
    }
    if (row.position !== null) {
      group.pos = group.pos === null ? row.position : Math.min(group.pos, row.position);
      group.isRanked = 1;
      if (row.position === 1) group.isTop = 1;
      if (row.position <= 3) group.isTop3 = 1;
    }
    if (row.is_cited === 1) group.isCited = 1;
  }
  return [...groups.values()];
}

function scopeKey(modelId: string | null, promptId: string | null): string {
  return `${modelId ?? ""}\u0000${promptId ?? ""}`;
}

/** Folds per_task rows into one aggregate per (scope, brand). */
function aggregate(rows: readonly PerTask[], level: 0 | 1): Aggregate[] {
  const groups = new Map<string, Aggregate>();
  for (const row of rows) {
    const modelId = level === 0 ? row.modelId : null;
    const promptId = level === 0 ? row.promptId : null;
    const key = `${scopeKey(modelId, promptId)}\u0000${row.brandId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        modelId,
        promptId,
        brandId: row.brandId,
        mentions: 0,
        ranked: 0,
        citations: 0,
        tops: 0,
        top3: 0,
        positions: [],
      };
      groups.set(key, group);
    }
    group.mentions += 1;
    group.ranked += row.isRanked;
    group.citations += row.isCited;
    group.tops += row.isTop;
    group.top3 += row.isTop3;
    if (row.pos !== null) group.positions.push(row.pos);
  }
  return [...groups.values()];
}

/** Sum of mentions across every brand in the same scope. The share_of_voice base. */
function totalsByScope(rows: readonly Aggregate[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = scopeKey(row.modelId, row.promptId);
    totals.set(key, (totals.get(key) ?? 0) + row.mentions);
  }
  return totals;
}

function writeMetrics(
  db: Driver,
  runId: string,
  projectId: string,
  perTask: readonly PerTask[],
  answersByScope: Map<string, number>,
  createdAt: string,
): number {
  const insert = db.prepare(INSERT_SQL);
  let written = 0;

  for (const level of [0, 1] as const) {
    const rows = aggregate(perTask, level);
    const totals = totalsByScope(rows);
    for (const row of rows) {
      const key = scopeKey(row.modelId, row.promptId);
      const answers = answersByScope.get(key) ?? 0;
      const allMentions = totals.get(key) ?? 0;
      const ranked = row.positions.length > 0;
      const mean = ranked
        ? row.positions.reduce((total, value) => total + value, 0) / row.positions.length
        : 0;
      insert.run(
        randomUUID(),
        runId,
        projectId,
        row.modelId,
        row.promptId,
        row.brandId,
        answers,
        row.mentions,
        row.ranked,
        row.citations,
        rate(row.mentions, answers),
        rate(row.ranked, answers),
        rate(row.citations, answers),
        // Never null in practice: a brand with no mentions has no row at all.
        rate(row.citations, row.mentions),
        ranked ? roundTo(mean, RANK_DP) : null,
        ranked ? Math.min(...row.positions) : null,
        ranked ? Math.max(...row.positions) : null,
        // Only the standard deviation is coalesced, which is why a never-ranked
        // brand reads avg_rank null and rank_stddev 0.00.
        roundTo(stddevPop(row.positions) ?? 0, RANK_DP),
        rate(row.mentions, allMentions),
        rate(row.tops, answers),
        rate(row.top3, answers),
        createdAt,
      );
      written += 1;
    }
  }
  return written;
}

/**
 * Refreshes the run counters, then replaces every run_metrics row for the run.
 * Does not gate on run status: a run still running its perception tasks gets the
 * full set of metric rows, because every measured answer is already in.
 */
export function finalizeRun(db: Driver, runId: string): FinalizeSummary {
  const run = db
    .prepare("SELECT project_id, created_at FROM runs WHERE id = ?")
    .get<{ project_id: string; created_at: string }>(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: no run ${runId}`);

  let progress: RunProgress | undefined;
  let metricRows = 0;

  db.transaction(() => {
    progress = updateRunProgress(db, runId);

    const tasks = db
      .prepare(TASK_SQL)
      .all<{ id: string; model_id: string; prompt_id: string | null }>(runId);

    // Answers per (model, prompt) at level 0, and for the whole run at level 1.
    const answersByScope = new Map<string, number>();
    for (const task of tasks) {
      const key = scopeKey(task.model_id, task.prompt_id);
      answersByScope.set(key, (answersByScope.get(key) ?? 0) + 1);
    }
    answersByScope.set(scopeKey(null, null), tasks.length);

    const perTask = buildPerTask(db.prepare(OBSERVATION_SQL).all<ObservationRow>(runId));

    db.prepare("DELETE FROM run_metrics WHERE run_id = ?").run(runId);
    // Metric rows carry the run's own date, not the scoring time: the trend, the
    // period filter and the metric window all order on it, and a re-score of an
    // old run must not move it to today.
    metricRows = writeMetrics(db, runId, run.project_id, perTask, answersByScope, run.created_at);

    // The stamp that says this run has been scored, written with the rows it
    // refers to. The worker's recovery net looks for its absence, because run
    // status cannot tell a scored run from one that drained in a pass which
    // never reached this line.
    db.prepare("UPDATE runs SET finalised_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      runId,
    );
  });

  if (!progress) throw new Error(`FINALIZE_FAILED: no progress for run ${runId}`);
  return { runId, metricRows, progress };
}
