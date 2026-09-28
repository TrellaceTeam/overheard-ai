/**
 * Creating a measured run: the fan-out over active prompts, iterations and
 * monitored assistants, with the question text composed and the brand token
 * resolved at fan-out time so editing a prompt later cannot rewrite what a past
 * run asked.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import type { CreateRunOptions } from "./types";
import { planRun } from "./plan-run";
import { mockProvidersEnabled } from "../worker/mock-provider";

/** The token a prompt writes when it means "the brand this project tracks". */
export const BRAND_TOKEN = "{brand}";

/**
 * Whether the answers in this run will come from the offline provider seam.
 *
 * Stored on the row rather than read when a screen renders it, because the seam
 * is an environment variable read at call time: unset it and the canned rows
 * become indistinguishable from measured ones while still averaging into the
 * same headline numbers.
 */
function mockFlag(): 0 | 1 {
  return mockProvidersEnabled() ? 1 : 0;
}

/**
 * The oldest active target brand's name, or null. Null leaves the token visible
 * in the question, which is easier to notice than a sentence with a hole in it.
 */
export function targetBrandName(db: Driver, projectId: string): string | null {
  const row = db
    .prepare(
      `SELECT name FROM brands
        WHERE project_id = ? AND role = 'target' AND is_active = 1
        ORDER BY created_at
        LIMIT 1`,
    )
    .get<{ name: string }>(projectId);
  return row?.name ?? null;
}

/** Replaces every occurrence of the token, not only the first. */
export function interpolateBrand(text: string, brand: string | null): string {
  return text.split(BRAND_TOKEN).join(brand ?? BRAND_TOKEN);
}

/**
 * The stored question: trimmed context, a blank line, then the prompt text, with
 * the brand token resolved. A null or blank context drops the prefix entirely.
 */
export function composeQuestion(
  text: string,
  context: string | null,
  brand: string | null,
): string {
  const trimmed = (context ?? "").trim();
  const prefix = trimmed === "" ? "" : `${trimmed}\n\n`;
  return interpolateBrand(`${prefix}${text}`, brand);
}

export function requireProject(db: Driver, projectId: string): void {
  const row = db.prepare("SELECT id FROM projects WHERE id = ?").get<{ id: string }>(projectId);
  if (!row) throw new Error("PROJECT_NOT_FOUND: project not found");
}

/**
 * Inserts one `runs` row and one `run_tasks` row per planned answer, in one
 * transaction, and returns the run id. Refuses above the install's call limit
 * (app_state.max_planned_calls) before any provider is called. Creates no
 * perception task: perception is its own run.
 */
export function createRun(db: Driver, projectId: string, opts: CreateRunOptions = {}): string {
  requireProject(db, projectId);

  const plan = planRun(db, projectId);
  const brand = targetBrandName(db, projectId);

  const prompts = db
    .prepare(
      `SELECT id, text, context, iterations FROM prompts
        WHERE project_id = ? AND is_active = 1 AND archived = 0
        ORDER BY created_at, id`,
    )
    .all<{ id: string; text: string; context: string | null; iterations: number }>(projectId);

  const models = db
    .prepare("SELECT model_id FROM project_models WHERE project_id = ? ORDER BY model_id")
    .all<{ model_id: string }>(projectId);

  const runId = randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO runs (id, project_id, trigger, planned_calls, config_snapshot, created_at, mock)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      projectId,
      opts.trigger ?? "manual",
      plan.calls,
      JSON.stringify(opts.configSnapshot ?? {}),
      now,
      mockFlag(),
    );

    const insertTask = db.prepare(
      `INSERT INTO run_tasks
         (id, run_id, project_id, prompt_id, model_id, iteration, question_text, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const prompt of prompts) {
      const question = composeQuestion(prompt.text, prompt.context, brand);
      for (const model of models) {
        for (let iteration = 1; iteration <= prompt.iterations; iteration += 1) {
          insertTask.run(
            randomUUID(),
            runId,
            projectId,
            prompt.id,
            model.model_id,
            iteration,
            question,
            now,
            now,
          );
        }
      }
    }
  });

  return runId;
}
