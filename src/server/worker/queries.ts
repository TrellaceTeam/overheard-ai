/**
 * The database statements the worker needs that src/server/logic does not own:
 * catalogue reads, the brand lists behind name resolution, the post-run passes
 * (enrichNewBrands, autoTrackTopCompetitor), and the saved calls in flight.
 * Everywhere else the worker reaches the database only through
 * src/server/logic.
 *
 * Nothing here decides anything. Reads return rows, writes take decided values.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import type { ModelRow, PerceptionSummaryRow, RunTaskRow } from "../db/types";
import type { PresenceRow } from "@/lib/top-competitor";
import type { StoredCaps } from "./concurrency";
import type { MatchableBrand } from "./extraction";

/** A JSON array in TEXT, read back as a string list. Bad JSON reads as empty. */
function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** `?, ?, ?` for an IN list. Callers must not pass an empty array. */
function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

// --- catalogue ---------------------------------------------------------------

/** The whole catalogue row, for its price columns. */
export function getModel(db: Driver, modelId: string): ModelRow | undefined {
  return db.prepare("SELECT * FROM models WHERE id = ?").get<ModelRow>(modelId);
}

/**
 * Extraction-capable, active models, cheapest first. lib/extraction-choice
 * picks from this list, and worker/extractor.ts is its database-backed form.
 * A null extraction_rank sorts last, as in the catalogue list the screens
 * read: an unranked extractor is unpriced and should not be auto-picked.
 */
export function listExtractionCandidates(db: Driver): ModelRow[] {
  return db
    .prepare(
      `SELECT * FROM models
        WHERE is_extraction_model = 1 AND is_active = 1
       ORDER BY extraction_rank IS NULL, extraction_rank ASC, input_price_per_mtok ASC`,
    )
    .all<ModelRow>();
}

/**
 * Every model the user has left switched on, whatever its role. The extraction
 * ladder's "next tier up in the same provider" climbs into models nobody would
 * pick as an extractor, so it needs the active set, not the extraction set.
 */
export function listActiveModels(db: Driver): ModelRow[] {
  return db.prepare("SELECT * FROM models WHERE is_active = 1").all<ModelRow>();
}

/** Display names for the assistants a perception merge is about. */
export function listModelDisplayNames(db: Driver, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, display_name FROM models WHERE id IN (${placeholders(ids.length)})`)
    .all<{ id: string; display_name: string }>(...ids);
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

// --- project -----------------------------------------------------------------

/**
 * The project's extraction prompt, or null when there is no such project. The
 * column is NOT NULL and defaults to the canonical EXTRACTION_SYSTEM.
 */
export function getExtractionPrompt(db: Driver, projectId: string): string | null {
  const row = db
    .prepare("SELECT extraction_prompt FROM projects WHERE id = ?")
    .get<{ extraction_prompt: string } | undefined>(projectId);
  return row?.extraction_prompt ?? null;
}

/** The project's preferred extractor, or null. */
export function getPreferredExtractionModelId(db: Driver, projectId: string): string | null {
  const row = db
    .prepare("SELECT extraction_model_id FROM projects WHERE id = ?")
    .get<{ extraction_model_id: string | null }>(projectId);
  return row?.extraction_model_id ?? null;
}

// --- brands ------------------------------------------------------------------

/** Every brand in the project, decoded for name and domain matching. */
export function listMatchableBrands(db: Driver, projectId: string): MatchableBrand[] {
  return db
    .prepare("SELECT id, name, variants, domains FROM brands WHERE project_id = ?")
    .all<{ id: string; name: string; variants: string; domains: string }>(projectId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      variants: parseStringArray(row.variants),
      domains: parseStringArray(row.domains),
    }));
}

/**
 * Insert a brand first seen in an answer. Returns null when the unique index on
 * (project_id, lower(name)) refuses it, which means a concurrent insert won and
 * the caller must re-read and re-resolve.
 */
export function insertDiscoveredBrand(db: Driver, projectId: string, name: string): string | null {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO brands (id, project_id, name, role, variants, domains, suggested_domains,
                           is_active, created_at)
       VALUES (?, ?, ?, 'discovered', '[]', '[]', '[]', 1, ?)`,
    ).run(id, projectId, name, new Date().toISOString());
    return id;
  } catch {
    return null;
  }
}

/** The brand a perception answer is about. Always the target, never a rival. */
export function targetBrandName(db: Driver, projectId: string): string {
  const row = db
    .prepare(
      `SELECT name FROM brands
        WHERE project_id = ? AND role = 'target' AND is_active = 1
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get<{ name: string }>(projectId);
  return row?.name ?? "the brand";
}

export interface BrandEnrichmentRow {
  id: string;
  name: string;
  role: string;
  variants: string[];
  domains: string[];
  suggested_domains: string[];
}

export function listBrandsForEnrichment(
  db: Driver,
  projectId: string,
  ids: readonly string[],
): BrandEnrichmentRow[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, name, role, variants, domains, suggested_domains
         FROM brands WHERE project_id = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all<{
      id: string;
      name: string;
      role: string;
      variants: string;
      domains: string;
      suggested_domains: string;
    }>(projectId, ...ids)
    .map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      variants: parseStringArray(row.variants),
      domains: parseStringArray(row.domains),
      suggested_domains: parseStringArray(row.suggested_domains),
    }));
}

export interface BrandPatch {
  variants?: string[];
  domains?: string[];
  suggested_domains?: string[];
}

/** Writes only the keys present, so a manual edit to the others survives. */
export function updateBrandLists(db: Driver, brandId: string, patch: BrandPatch): void {
  const sets: string[] = [];
  const values: string[] = [];
  if (patch.variants) {
    sets.push("variants = ?");
    values.push(JSON.stringify(patch.variants));
  }
  if (patch.domains) {
    sets.push("domains = ?");
    values.push(JSON.stringify(patch.domains));
  }
  if (patch.suggested_domains) {
    sets.push("suggested_domains = ?");
    values.push(JSON.stringify(patch.suggested_domains));
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE brands SET ${sets.join(", ")} WHERE id = ?`).run(...values, brandId);
}

export function countTrackedCompetitors(db: Driver, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM brands WHERE project_id = ? AND role = 'competitor'")
    .get<{ n: number }>(projectId);
  return row?.n ?? 0;
}

export function listDiscoveredBrands(
  db: Driver,
  projectId: string,
): Array<{ id: string; name: string }> {
  return db
    .prepare(
      `SELECT id, name FROM brands
        WHERE project_id = ? AND role = 'discovered' AND is_active = 1`,
    )
    .all<{ id: string; name: string }>(projectId);
}

export function promoteBrandToCompetitor(db: Driver, brandId: string): void {
  db.prepare("UPDATE brands SET role = 'competitor' WHERE id = ?").run(brandId);
}

// --- tasks and runs ----------------------------------------------------------

/**
 * The stored answer, re-read instead of taken off the claimed row. The answer
 * is persisted before extraction, so an extraction retry re-buys only the
 * cheap call.
 */
export function getStoredAnswerText(db: Driver, taskId: string): string {
  const row = db
    .prepare("SELECT answer_text FROM run_tasks WHERE id = ?")
    .get<{ answer_text: string | null }>(taskId);
  return row?.answer_text ?? "";
}

/**
 * storeExtraction marks a measured task done. A perception task reaches `done`
 * with no extractions row and no observations, so it needs this on its own.
 */
export function markTaskDone(db: Driver, taskId: string): void {
  db.prepare(
    `UPDATE run_tasks
        SET status = 'done', error = NULL, locked_at = NULL, locked_by = NULL
      WHERE id = ?`,
  ).run(taskId);
}

/** Tasks nothing is waiting on. Zero means the run has drained. */
export function countPendingTasks(db: Driver, runId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ? AND status NOT IN ('done','failed')",
    )
    .get<{ n: number }>(runId);
  return row?.n ?? 0;
}

export function countPerceptionTasks(db: Driver, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ? AND is_perception = 1")
    .get<{ n: number }>(runId);
  return row?.n ?? 0;
}

export function listDonePerceptionTasks(db: Driver, runId: string, limit: number): RunTaskRow[] {
  return db
    .prepare(
      `SELECT * FROM run_tasks
        WHERE run_id = ? AND is_perception = 1 AND status = 'done'
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all<RunTaskRow>(runId, limit);
}

export interface RunCandidate {
  id: string;
  project_id: string;
}

/**
 * The runs a pass should consider finalising: every run it touched, plus up to
 * 50 that have drained without ever being scored. A drained run with nothing
 * done is still scored, to zero rows, because `finalised_at` is what tells the
 * run page to stop waiting for statistics.
 *
 * Neither half filters on status. updateRunProgress marks a run `completed`
 * as soon as its last task lands, so a pass interrupted before scoring leaves
 * a terminal run with no metrics, and a cancelled run is terminal too. The
 * stale half is keyed on the missing `finalised_at`, which catches both.
 */
export function listFinalisationCandidates(
  db: Driver,
  touchedRunIds: readonly string[],
): RunCandidate[] {
  const pool = new Map<string, string>();

  if (touchedRunIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT id, project_id FROM runs WHERE id IN (${placeholders(touchedRunIds.length)}) LIMIT 100`,
      )
      .all<RunCandidate>(...touchedRunIds);
    for (const row of rows) pool.set(row.id, row.project_id);
  }

  const stale = db
    .prepare(
      `SELECT id, project_id FROM runs r
        WHERE r.finalised_at IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM run_tasks t
                 WHERE t.run_id = r.id AND t.status NOT IN ('done','failed'))
        ORDER BY r.created_at LIMIT 50`,
    )
    .all<RunCandidate>();
  for (const row of stale) pool.set(row.id, row.project_id);

  return [...pool].map(([id, project_id]) => ({ id, project_id }));
}

/** A run with at least one non-perception task. Perception-only runs measure nothing. */
export function isMeasuredRun(db: Driver, runId: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ? AND is_perception = 0")
    .get<{ n: number }>(runId);
  return (row?.n ?? 0) > 0;
}

/**
 * Whether any other measured run in this project has already finished.
 * Auto-tracking fires only on a project's first completed measured run.
 */
export function hasEarlierCompletedMeasuredRun(
  db: Driver,
  projectId: string,
  runId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs r
        WHERE r.project_id = ? AND r.id <> ?
          AND r.status IN ('completed','partial')
          AND EXISTS (SELECT 1 FROM run_tasks t WHERE t.run_id = r.id AND t.is_perception = 0)`,
    )
    .get<{ n: number }>(projectId, runId);
  return (row?.n ?? 0) > 0;
}

// --- observations and metrics ------------------------------------------------

export interface EnrichmentObservation {
  brand_id: string;
  raw_name: string;
  linked_url: string | null;
}

export function listRunObservations(db: Driver, runId: string): EnrichmentObservation[] {
  return db
    .prepare(
      `SELECT brand_id, raw_name, linked_url FROM brand_observations
        WHERE run_id = ? AND brand_id IS NOT NULL`,
    )
    .all<EnrichmentObservation>(runId);
}

/** Brand ids with an observation in some other run. The "seen before" test. */
export function listBrandIdsSeenInOtherRuns(
  db: Driver,
  brandIds: readonly string[],
  runId: string,
): Set<string> {
  if (brandIds.length === 0) return new Set();
  const rows = db
    .prepare(
      `SELECT DISTINCT brand_id FROM brand_observations
        WHERE brand_id IN (${placeholders(brandIds.length)}) AND run_id <> ?`,
    )
    .all<{ brand_id: string }>(...brandIds, runId);
  return new Set(rows.map((row) => row.brand_id));
}

/**
 * The run-wide scope rows: one per brand, model_id and prompt_id both null.
 * IS NULL on both, because `= NULL` is never true in SQL.
 */
export function listRunWideMetrics(db: Driver, runId: string): PresenceRow[] {
  return db
    .prepare(
      `SELECT brand_id, mentions, answers, top3_rate FROM run_metrics
        WHERE run_id = ? AND model_id IS NULL AND prompt_id IS NULL`,
    )
    .all<PresenceRow>(runId);
}

// --- perception summaries ----------------------------------------------------

/** The per-assistant rows, project-scoped. The merged row is excluded. */
export function listPerAssistantSummaries(db: Driver, projectId: string): PerceptionSummaryRow[] {
  return db
    .prepare(
      `SELECT * FROM perception_summaries
        WHERE project_id = ? AND model_id IS NOT NULL
        ORDER BY updated_at ASC`,
    )
    .all<PerceptionSummaryRow>(projectId);
}

// --- install settings --------------------------------------------------------

/**
 * The calls in flight saved in Account settings, all null when the app_state
 * row is missing. worker/concurrency.ts decides what applies.
 */
export function getStoredCaps(db: Driver): StoredCaps {
  const row = db
    .prepare(
      `SELECT max_inflight_openai, max_inflight_anthropic, max_inflight_google
         FROM app_state WHERE id = 1`,
    )
    .get<{
      max_inflight_openai: number | null;
      max_inflight_anthropic: number | null;
      max_inflight_google: number | null;
    }>();
  return {
    openai: row?.max_inflight_openai ?? null,
    anthropic: row?.max_inflight_anthropic ?? null,
    google: row?.max_inflight_google ?? null,
  };
}
