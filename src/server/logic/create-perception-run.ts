/**
 * Creating a perception run: one task per monitored assistant asking the
 * project perception question, with is_perception = 1 and prompt_id null.
 *
 * A blank perception prompt is the off switch and raises NO_PERCEPTION_PROMPT.
 * The key check covers the extractor as well as the answering providers: a
 * perception answer still goes through extraction to be read into sections.
 *
 * Which providers have a key is a worker-layer fact, so the caller supplies it
 * rather than this module reading the environment. Omitting it skips the check,
 * which is what a test or a preview wants.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import { CALLS_PER_ANSWER } from "@/lib/run-progress";
import { interpolateBrand, requireProject, targetBrandName } from "./create-run";
import { mockProvidersEnabled } from "../worker/mock-provider";

export interface PerceptionRunOptions {
  /** Providers with a key on this process's environment, for example "openai". */
  providersWithKeys?: ReadonlySet<string>;
}

/**
 * Every provider this run would call: the answering assistants plus the
 * project's extractor, which reads each answer into its four sections.
 */
function providersNeeded(db: Driver, projectId: string): string[] {
  const answering = db
    .prepare(
      `SELECT DISTINCT m.provider AS provider
         FROM project_models pm JOIN models m ON m.id = pm.model_id
        WHERE pm.project_id = ?
        ORDER BY m.provider`,
    )
    .all<{ provider: string }>(projectId)
    .map((row) => row.provider);

  const extractor = db
    .prepare(
      `SELECT m.provider AS provider FROM projects p
         JOIN models m ON m.id = p.extraction_model_id
        WHERE p.id = ?`,
    )
    .get<{ provider: string }>(projectId);

  if (extractor && !answering.includes(extractor.provider)) answering.push(extractor.provider);
  return answering;
}

/** Returns the new run id. config_snapshot is the perception_only marker. */
export function createPerceptionRun(
  db: Driver,
  projectId: string,
  opts: PerceptionRunOptions = {},
): string {
  requireProject(db, projectId);

  const project = db
    .prepare("SELECT perception_prompt FROM projects WHERE id = ?")
    .get<{ perception_prompt: string }>(projectId);
  const perceptionPrompt = (project?.perception_prompt ?? "").trim();
  if (perceptionPrompt === "") {
    throw new Error("NO_PERCEPTION_PROMPT: add a perception prompt in project settings first.");
  }

  const models = db
    .prepare("SELECT model_id FROM project_models WHERE project_id = ? ORDER BY model_id")
    .all<{ model_id: string }>(projectId);
  if (models.length === 0) throw new Error("NO_MODELS: select at least one assistant");

  const withKeys = opts.providersWithKeys;
  if (withKeys) {
    const missing = providersNeeded(db, projectId).filter((provider) => !withKeys.has(provider));
    if (missing.length > 0) {
      throw new Error(
        `MISSING_CREDENTIAL: no API key configured for ${missing.join(", ")}. Add it to .env and restart.`,
      );
    }
  }

  const brand = targetBrandName(db, projectId);
  const question = interpolateBrand(perceptionPrompt, brand);
  const runId = randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO runs (id, project_id, trigger, planned_calls, config_snapshot, created_at, mock)
       VALUES (?, ?, 'manual', ?, ?, ?, ?)`,
    ).run(
      runId,
      projectId,
      // Two calls per answer: the question, then the extraction into sections.
      // Planned and completed count the same tasks, so halving calls into
      // answers stays exact.
      models.length * CALLS_PER_ANSWER,
      JSON.stringify({ perception_only: true }),
      now,
      mockProvidersEnabled() ? 1 : 0,
    );

    const insertTask = db.prepare(
      `INSERT INTO run_tasks
         (id, run_id, project_id, prompt_id, model_id, iteration, question_text,
          is_perception, next_attempt_at, created_at)
       VALUES (?, ?, ?, NULL, ?, 1, ?, 1, ?, ?)`,
    );
    for (const model of models) {
      // One per assistant, and only ever about the target brand. A description
      // is not a distribution, so there are no repeats.
      insertTask.run(randomUUID(), runId, projectId, model.model_id, question, now, now);
    }
  });

  return runId;
}
