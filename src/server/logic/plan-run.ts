/**
 * What a run would cost, computed without writing anything.
 *
 * The same function backs the Run button preview and createRun's own arithmetic,
 * so the number shown and the number spent cannot drift.
 */
import { planCounts, type RunPlanCounts } from "@/lib/run-plan";
import type { Driver } from "../db/driver";
import { CALL_LIMIT_MIN, DEFAULT_MAX_PLANNED_CALLS } from "./types";

/**
 * The ceiling this install plans against: app_state.max_planned_calls, or the
 * default when the row is unreadable (a database mid-migration, a test that
 * never ran one). Exported because the Settings screen shows the same number
 * the planner will use, and the two must not drift.
 */
export function effectiveCallLimit(db: Driver): number {
  const row = db
    .prepare("SELECT max_planned_calls FROM app_state WHERE id = 1")
    .get<{ max_planned_calls: number } | undefined>();
  const value = row?.max_planned_calls;
  return typeof value === "number" && Number.isInteger(value) && value >= CALL_LIMIT_MIN
    ? value
    : DEFAULT_MAX_PLANNED_CALLS;
}

/**
 * Prompts that are on AND not archived, times their iterations, times the
 * monitored assistants. Raises NO_PROMPTS with no askable prompt, NO_MODELS
 * with no assistant, and RUN_TOO_LARGE above the install's call limit.
 *
 * `models.is_active` is not consulted: the monitored set is whatever
 * project_models holds.
 */
export function planRun(db: Driver, projectId: string): RunPlanCounts {
  const promptTotals = db
    .prepare(
      `SELECT count(*) AS prompts, coalesce(sum(iterations), 0) AS iterations
         FROM prompts WHERE project_id = ? AND is_active = 1 AND archived = 0`,
    )
    .get<{ prompts: number; iterations: number }>(projectId);
  const prompts = promptTotals?.prompts ?? 0;
  if (prompts === 0) throw new Error("NO_PROMPTS: add at least one active prompt");

  const assistantRow = db
    .prepare("SELECT count(*) AS assistants FROM project_models WHERE project_id = ?")
    .get<{ assistants: number }>(projectId);
  const plan = planCounts(prompts, promptTotals?.iterations ?? 0, assistantRow?.assistants ?? 0);
  if (plan.answers === 0) throw new Error("NO_MODELS: select at least one assistant");

  const { calls } = plan;
  const limit = effectiveCallLimit(db);
  if (calls > limit) {
    // Shown as is in the Run dialog and the Prompts panel, so it carries the
    // count the planner computed (there is no plan object to render once this
    // throws), the live limit, and the screen that changes it.
    throw new Error(
      `RUN_TOO_LARGE: this run plans ${calls.toLocaleString("en-US")} provider calls. Your run size limit is ${limit.toLocaleString("en-US")}. Raise it in Account settings, or switch off prompts or assistants`,
    );
  }

  return plan;
}

/** Answers this plan buys from each assistant. Every assistant gets the same. */
export function answersPerAssistant(plan: RunPlanCounts): number {
  return plan.assistants === 0 ? 0 : plan.answers / plan.assistants;
}
