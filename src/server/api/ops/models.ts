/**
 * The model catalog and a project's monitored assistants.
 *
 * The catalog is seeded and never edited by a user, so everything here is a
 * read except setProjectModel. Extractors are ordered by `extraction_rank`,
 * cheapest first by published price.
 */
import type { Driver } from "../../db/driver";
import type { ModelRow } from "../../db/types";
import { NotFoundError, refuseDemoProject } from "./shared";

export interface ProjectModelView {
  modelId: string;
  provider: string;
  displayName: string;
}

/**
 * The assistants a project can monitor: active, and not extraction-only.
 * Current models first, so anything that takes the first match per provider
 * lands on a current one.
 */
export function listModels(db: Driver): ModelRow[] {
  return db
    .prepare(
      `SELECT * FROM models
        WHERE is_active = 1 AND is_extraction_model = 0
        ORDER BY superseded, tier, provider, display_name`,
    )
    .all<ModelRow>();
}

/**
 * The models that can read an answer, cheapest first.
 *
 * SQLite sorts NULL first, so `extraction_rank IS NULL` puts an unranked
 * extractor last. It has no known price, and the auto-pick should not land on
 * it.
 */
export function listExtractionModels(db: Driver): ModelRow[] {
  return db
    .prepare(
      `SELECT * FROM models
        WHERE is_active = 1 AND is_extraction_model = 1
        ORDER BY extraction_rank IS NULL, extraction_rank, display_name`,
    )
    .all<ModelRow>();
}

/** Which assistants this project asks. */
export function listProjectModels(db: Driver, projectId: string): ProjectModelView[] {
  return db
    .prepare(
      `SELECT m.id AS modelId, m.provider AS provider, m.display_name AS displayName
         FROM project_models pm
         JOIN models m ON m.id = pm.model_id
        WHERE pm.project_id = ?
        ORDER BY m.tier, m.provider, m.display_name`,
    )
    .all<ProjectModelView>(projectId);
}

export interface SetProjectModelInput {
  projectId: string;
  modelId: string;
  on: boolean;
}

/**
 * Turn one assistant on or off for a project.
 *
 * Switching off the last assistant is allowed. The run planner refuses a run
 * with no assistants, so that rule lives in one place.
 */
export function setProjectModel(db: Driver, input: SetProjectModelInput): { ok: true } {
  refuseDemoProject(db, input.projectId);
  const model = db
    .prepare("SELECT id FROM models WHERE id = ? AND is_active = 1")
    .get<{ id: string }>(input.modelId);
  if (!model) throw new NotFoundError("MODEL_NOT_FOUND", "that assistant is not in the catalog");

  if (input.on) {
    db.prepare(
      "INSERT INTO project_models (project_id, model_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    ).run(input.projectId, input.modelId);
  } else {
    db.prepare("DELETE FROM project_models WHERE project_id = ? AND model_id = ?").run(
      input.projectId,
      input.modelId,
    );
  }
  return { ok: true };
}
