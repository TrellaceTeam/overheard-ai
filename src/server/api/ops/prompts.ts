/**
 * Prompts: the questions a run asks, their tag, the three states they live in,
 * and the lock that keeps a question with answers meaning the same thing.
 *
 * Three states, two flags: on (asked every run), off (in the library but
 * skipped, say while running a different set this week), archived (hidden in
 * the bottom fold, skipped, answers kept and still counted). A run asks a
 * prompt only when it is on and not archived. plan-run and create-run both
 * filter on the pair.
 *
 * A prompt with at least one done task is locked. Editing its text would
 * change what every past run measured, so a locked prompt is edited through a
 * clone: an inactive copy the user edits and switches on, leaving past runs
 * intact. The count comes from run_tasks, not a counter column, because a
 * counter drifts when a run is deleted.
 *
 * Two prompts in one project never share a text (trimmed, case-insensitive),
 * archived ones included, because a hidden twin is a duplicate the user cannot
 * see. A clone is the exception, since it exists to become a different
 * question. It cannot be switched on while identical, because then the same
 * question would be asked and paid for twice.
 *
 * Deleting a prompt deletes its answers. Its tasks go, with their extractions
 * and observations, its metric rows go, and every run it appeared in is
 * re-scored from the answers that survive. Nothing is left that cannot be
 * attributed to a prompt, so a deleted brand-named question cannot keep
 * counting. The UI warns before calling this and offers archiving instead.
 */
import type { Driver } from "../../db/driver";
import type { PromptRow } from "../../db/types";
import { finalizeRun } from "../../logic/finalize-run";
import { CALLS_PER_ANSWER } from "@/lib/run-progress";
import { updateRunProgress } from "../../logic/update-run-progress";
import { deletePromptResultsSummary } from "../../logic/prompt-results-summary";
import {
  expectChanged,
  InvalidInputError,
  newId,
  NotFoundError,
  nowIso,
  toSqlBool,
  refuseDemoForPrompt,
  refuseDemoProject,
} from "./shared";

/** Mirrors the length CHECK on prompts.text in the schema. Both must agree. */
export const PROMPT_MAX_CHARS = 2000;

/** The range this layer clamps iterations to. The database CHECK allows 1 to 100. */
export const MIN_ITERATIONS = 1;
export const MAX_ITERATIONS = 20;

/**
 * Created_at then id, because onboarding inserts share a timestamp. Without the
 * tiebreak, editing one prompt reshuffles the list under the user's cursor.
 */
const PROMPT_ORDER = "ORDER BY created_at, id";

export function listPrompts(db: Driver, projectId: string): PromptRow[] {
  return db
    .prepare(`SELECT * FROM prompts WHERE project_id = ? ${PROMPT_ORDER}`)
    .all<PromptRow>(projectId);
}

/**
 * How many answers each prompt has, as a plain object so it crosses the server
 * function boundary. A Map does not survive serialisation, so the route builds
 * one.
 */
export function promptAnswerCounts(db: Driver, projectId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT prompt_id AS promptId, count(*) AS answers FROM run_tasks
        WHERE project_id = ? AND status = 'done' AND prompt_id IS NOT NULL
        GROUP BY prompt_id`,
    )
    .all<{ promptId: string; answers: number }>(projectId);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.promptId] = row.answers;
  return counts;
}

/** Whether this prompt has answers, which is what locks its text. */
export function promptIsLocked(db: Driver, promptId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS locked FROM run_tasks WHERE prompt_id = ? AND status = 'done' LIMIT 1")
    .get<{ locked: number }>(promptId);
  return row !== undefined;
}

export interface CreatePromptInput {
  projectId: string;
  text: string;
  /** The tag. A blank one is refused. */
  category: string;
  iterations?: number | undefined;
  isActive?: boolean | undefined;
  context?: string | null | undefined;
}

export function createPrompt(db: Driver, input: CreatePromptInput): { id: string } {
  refuseDemoProject(db, input.projectId);
  const text = input.text.trim();
  if (text === "") throw new InvalidInputError("NO_TEXT", "write the prompt first");
  if (text.length > PROMPT_MAX_CHARS) {
    throw new InvalidInputError(
      "TEXT_TOO_LONG",
      `a question is at most ${PROMPT_MAX_CHARS} characters`,
    );
  }
  const tag = requireTag(input.category);
  refuseDuplicate(db, input.projectId, text);

  const id = newId();
  const stamp = nowIso();
  db.prepare(
    `INSERT INTO prompts (id, project_id, text, context, category, iterations, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    text,
    input.context ?? null,
    tag,
    clampIterations(input.iterations ?? 5),
    toSqlBool(input.isActive ?? true),
    stamp,
    stamp,
  );
  return { id };
}

export interface UpdatePromptInput {
  id: string;
  text?: string | undefined;
  isActive?: boolean | undefined;
  iterations?: number | undefined;
  /**
   * `null` is allowed by the type so an attempt to clear the tag reaches the op
   * and is refused with a readable message, not a validation error. Rows with
   * no tag keep their NULL until one is picked.
   */
  category?: string | null | undefined;
  context?: string | null | undefined;
}

/**
 * Edit a prompt. Everything except the text stays editable once the prompt is
 * locked: switching it off, retagging it and changing its iterations all leave
 * past answers meaning what they meant.
 *
 * Changed wording deletes the prompt's results summary. The text can only
 * change while the prompt has no answers, for example after every run that had
 * some was deleted, and a summary of the old question must not show under the
 * new one.
 */
export function updatePrompt(db: Driver, input: UpdatePromptInput): { ok: true } {
  refuseDemoForPrompt(db, input.id);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  let reworded = false;

  if (input.text !== undefined) {
    const text = input.text.trim();
    if (text === "") throw new InvalidInputError("NO_TEXT", "write the prompt first");
    if (text.length > PROMPT_MAX_CHARS) {
      throw new InvalidInputError(
        "TEXT_TOO_LONG",
        `a question is at most ${PROMPT_MAX_CHARS} characters`,
      );
    }
    if (promptIsLocked(db, input.id)) {
      throw new InvalidInputError(
        "PROMPT_LOCKED",
        "this question already has answers. Clone it to edit, so past runs keep their meaning",
      );
    }
    const current = db
      .prepare("SELECT project_id, text FROM prompts WHERE id = ?")
      .get<{ project_id: string; text: string }>(input.id);
    if (!current) throw new NotFoundError("PROMPT_NOT_FOUND", "that prompt does not exist");
    refuseDuplicate(db, current.project_id, text, input.id);
    sets.push("text = ?");
    params.push(text);
    reworded = text !== current.text;
  }
  if (input.isActive !== undefined) {
    if (input.isActive) refuseIdenticalActivation(db, input.id, input.text);
    sets.push("is_active = ?");
    params.push(toSqlBool(input.isActive));
  }
  if (input.iterations !== undefined) {
    sets.push("iterations = ?");
    params.push(clampIterations(input.iterations));
  }
  if (input.category !== undefined) {
    sets.push("category = ?");
    params.push(requireTag(input.category, "a prompt cannot go back to no tag; pick another"));
  }
  if (input.context !== undefined) {
    sets.push("context = ?");
    params.push(input.context);
  }

  if (sets.length === 0) return { ok: true };

  params.push(input.id);
  db.transaction(() => {
    const changes = db
      .prepare(`UPDATE prompts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params).changes;
    expectChanged(changes, "PROMPT_NOT_FOUND", "that prompt does not exist");
    if (reworded) deletePromptResultsSummary(db, input.id);
  });
  return { ok: true };
}

/**
 * Copy a prompt, switched off. The copy exists to be edited, and a run that
 * fired between the clone and the edit would ask the same question twice.
 */
export function clonePrompt(db: Driver, promptId: string): { id: string } {
  refuseDemoForPrompt(db, promptId);
  const source = db.prepare("SELECT * FROM prompts WHERE id = ?").get<PromptRow>(promptId);
  if (!source) throw new NotFoundError("PROMPT_NOT_FOUND", "that prompt does not exist");

  const id = newId();
  const stamp = nowIso();
  db.prepare(
    `INSERT INTO prompts (id, project_id, text, context, category, iterations, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    source.project_id,
    source.text,
    source.context,
    source.category,
    source.iterations,
    stamp,
    stamp,
  );
  return { id };
}

/**
 * Hide a prompt in the library's archived fold, or bring it back. The on/off
 * state is left alone, so restoring returns the prompt as it was. Runs skip an
 * archived prompt whether it is on or off.
 */
export function setPromptArchived(
  db: Driver,
  input: { id: string; archived: boolean },
): { ok: true } {
  refuseDemoForPrompt(db, input.id);
  const changes = db
    .prepare("UPDATE prompts SET archived = ?, updated_at = ? WHERE id = ?")
    .run(toSqlBool(input.archived), nowIso(), input.id).changes;
  expectChanged(changes, "PROMPT_NOT_FOUND", "that prompt does not exist");
  return { ok: true };
}

/**
 * Delete a prompt and everything only it gives meaning to: its tasks (and with
 * them, by foreign key, their extractions and observations) and its metric
 * rows. Every run it appeared in is then re-scored so the surviving answers
 * carry the statistics alone. Answers kept with a null prompt_id could not be
 * classified as self-referenced, so a deleted brand-named question would keep
 * counting, against ADR 0005.
 */
export function deletePrompt(db: Driver, promptId: string): { ok: true } {
  refuseDemoForPrompt(db, promptId);
  const prompt = db.prepare("SELECT id FROM prompts WHERE id = ?").get<{ id: string }>(promptId);
  if (!prompt) throw new NotFoundError("PROMPT_NOT_FOUND", "that prompt does not exist");

  const affectedRuns = db
    .prepare(
      `SELECT t.run_id AS runId, count(*) AS tasks, r.finalised_at IS NOT NULL AS scored
         FROM run_tasks t
         JOIN runs r ON r.id = t.run_id
        WHERE t.prompt_id = ?
        GROUP BY t.run_id`,
    )
    .all<{ runId: string; tasks: number; scored: number }>(promptId);

  db.transaction(() => {
    // Children cascade: extractions and observations follow their tasks, and
    // per-prompt metric rows follow the prompt.
    db.prepare("DELETE FROM run_tasks WHERE prompt_id = ?").run(promptId);
    db.prepare("DELETE FROM prompts WHERE id = ?").run(promptId);

    const shrinkPlan = db.prepare(
      "UPDATE runs SET planned_calls = max(planned_calls - ?, 0) WHERE id = ?",
    );
    for (const run of affectedRuns) {
      shrinkPlan.run(run.tasks * CALLS_PER_ANSWER, run.runId);
      // The worker scores a run still in progress when it drains. Finalising it
      // here would stamp it finished while it is still running.
      if (!run.scored) updateRunProgress(db, run.runId);
    }
  });

  // finalizeRun rebuilds every metric row of a scored run from the tasks that
  // survive.
  for (const run of affectedRuns) if (run.scored) finalizeRun(db, run.runId);
  return { ok: true };
}

/**
 * The other prompt in this project whose text matches, compared trimmed and
 * case-insensitively, because a user retyping a question from memory gets it
 * almost right. `excludeId` lets a prompt keep its own text. The visible twin
 * is preferred, because it is the duplicate the user can act on.
 *
 * Matched in JavaScript, not with SQL's lower(), which folds only A-Z and so
 * misses "¿QUÉ CRM ELIJO?" against "¿qué crm elijo?". A project holds tens of
 * prompts, so reading them all is cheap.
 */
function findTwin(
  db: Driver,
  projectId: string,
  text: string,
  excludeId?: string,
): { id: string; archived: number } | undefined {
  const key = promptKey(text);
  return db
    .prepare(
      "SELECT id, archived, text FROM prompts WHERE project_id = ? AND id != ? ORDER BY archived",
    )
    .all<{ id: string; archived: number; text: string }>(projectId, excludeId ?? "")
    .find((row) => promptKey(row.text) === key);
}

/**
 * Two prompt texts are the same question when their keys match. NFC first,
 * because an accented letter can arrive composed or as a letter plus an
 * accent, depending on the keyboard.
 */
function promptKey(text: string): string {
  return text.trim().normalize("NFC").toLowerCase();
}

/** One text per question per project, on the way in. */
function refuseDuplicate(db: Driver, projectId: string, text: string, excludeId?: string): void {
  const twin = findTwin(db, projectId, text, excludeId);
  if (!twin) return;
  throw new InvalidInputError(
    "PROMPT_DUPLICATE",
    twin.archived === 1
      ? "you already have this prompt; it is in your archived prompts"
      : "you already have this question",
  );
}

/**
 * A clone may exist as an identical copy, because that is how a locked prompt
 * is edited, but it cannot be switched on while identical: the same question
 * would be asked and paid for twice. The check uses the text the prompt will
 * have after this update, so editing and switching on in one call passes once
 * the wording differs.
 */
function refuseIdenticalActivation(db: Driver, promptId: string, newText?: string): void {
  const prompt = db
    .prepare("SELECT project_id, text FROM prompts WHERE id = ?")
    .get<{ project_id: string; text: string }>(promptId);
  if (!prompt) throw new NotFoundError("PROMPT_NOT_FOUND", "that prompt does not exist");

  const text = newText !== undefined ? newText.trim() : prompt.text;
  const twin = findTwin(db, prompt.project_id, text, promptId);
  if (!twin) return;
  throw new InvalidInputError(
    "PROMPT_IDENTICAL",
    twin.archived === 1
      ? "edit this prompt first; it is still identical to an archived prompt"
      : "edit this prompt first; it is still identical to another prompt",
  );
}

/**
 * Every prompt carries a tag: the server refuses to create one without it or
 * to clear it afterwards. A row stored with a NULL tag keeps it and stays
 * editable in every other way. The "Untagged" filter exists for such rows.
 */
function requireTag(
  tag: string | null,
  emptyMessage = "every prompt needs a tag; pick or write one",
): string {
  const trimmed = (tag ?? "").trim();
  if (trimmed === "") throw new InvalidInputError("NO_TAG", emptyMessage);
  if (trimmed.length > 100) {
    throw new InvalidInputError("TAG_TOO_LONG", "a tag is at most 100 characters");
  }
  return trimmed;
}

function clampIterations(value: number): number {
  const rounded = Math.round(value);
  if (Number.isNaN(rounded)) return MIN_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, rounded));
}
