/**
 * Claiming work, and closing out work that can never succeed.
 *
 * Selection, status change, lock stamp and attempt increment happen inside one
 * write transaction, so no two claims return the same row and no provider is
 * paid twice for one answer. A `queued` task becomes `in_flight` and an
 * `answered` task becomes `extracting`.
 *
 * SQLite has no `FOR UPDATE SKIP LOCKED`, so the select and the update run
 * under BEGIN IMMEDIATE. It takes the write lock before the read, so a second
 * claimer cannot see the same rows as claimable.
 */
import type { Driver } from "../db/driver";
import type { Provider, RunTaskRow, SqlBool, TaskStatus } from "../db/types";
import type { ClaimedTask } from "./types";
import { MAX_TASK_ATTEMPTS } from "./types";
import type { FailureCode } from "@/lib/failure-codes";

/**
 * What the attempt-ceiling sweep records for a task that never recorded a
 * reason of its own: the typed code, and the detail written beside it.
 */
const EXHAUSTED_CODE: FailureCode = "MAX_ATTEMPTS_EXCEEDED";
const EXHAUSTED_DETAIL = "MAX_ATTEMPTS_EXCEEDED";

/** The claim's own row shape: a full task plus the columns the worker needs. */
interface ClaimedRow extends RunTaskRow {
  provider: Provider;
  provider_model_id: string;
  supports_web_search: SqlBool;
}

/**
 * Default in-flight calls per provider. Providers limit rates, not
 * connections, so the cap is how the client stays inside a lower-tier key's
 * tokens-per-minute budget. A web-search answer is roughly 8k tokens, which
 * binds OpenAI first. Google publishes no numeric rates, so its cap is lower.
 * A cap set too high costs speed, not money: providers do not bill 429
 * rejections, and the worker backs off with jitter.
 *
 * The three sum to BATCH_SIZE, so the batch stays the overall ceiling.
 * Override per provider in Account settings, or with
 * OVERHEARD_MAX_INFLIGHT_<PROVIDER>, which wins (see worker/concurrency.ts),
 * once the account's tier is known.
 */
export const DEFAULT_PROVIDER_CAPS: Record<Provider, number> = {
  openai: 6,
  anthropic: 6,
  google: 3,
};

/**
 * Candidates fetched per claim. It exceeds the batch so that, when the head of
 * the queue belongs to a provider at its cap, the fill reaches other
 * providers' tasks instead of claiming nothing this pass.
 */
const CANDIDATE_SCAN_LIMIT = 200;

/** A claimable or in-flight task, with what it takes to say which provider its call hits. */
interface CallRow {
  id: string;
  status: TaskStatus;
  project_id: string;
  answer_provider: Provider;
}

const SELECT_CLAIMABLE = `
  SELECT t.id, t.status, t.project_id, m.provider AS answer_provider
    FROM run_tasks t
    JOIN runs r ON r.id = t.run_id
    JOIN models m ON m.id = t.model_id
   WHERE t.status IN ('queued','answered')
     AND t.next_attempt_at <= ?
     AND t.attempts < ?
     AND r.status IN ('queued','running')
   ORDER BY t.next_attempt_at
   LIMIT ?`;

const SELECT_IN_FLIGHT = `
  SELECT t.id, t.status, t.project_id, m.provider AS answer_provider
    FROM run_tasks t
    JOIN models m ON m.id = t.model_id
   WHERE t.status IN ('in_flight','extracting')`;

const SELECT_PREFERRED_EXTRACTOR_PROVIDER = `
  SELECT m.provider FROM projects p
    JOIN models m ON m.id = p.extraction_model_id
   WHERE p.id = ?`;

/**
 * Which provider a project's extraction calls go to. The worker passes the
 * extractor it will actually call, which depends on the keys it holds; without
 * one the claim falls back to the project's stored preference.
 */
export type ExtractorProvider = (projectId: string) => Provider | null;

function preferredExtractorProvider(db: Driver): ExtractorProvider {
  const query = db.prepare(SELECT_PREFERRED_EXTRACTOR_PROVIDER);
  return (projectId) => query.get<{ provider: Provider }>(projectId)?.provider ?? null;
}

/**
 * The provider the task's next or current call hits: its own model's for an
 * answer, the project's extractor's for an extraction. A project with no
 * extractor charges the answer model's provider, which is the safe direction.
 */
function callProvider(row: CallRow, extractorProvider: ExtractorProvider): Provider {
  const answering = row.status === "queued" || row.status === "in_flight";
  if (answering) return row.answer_provider;
  return extractorProvider(row.project_id) ?? row.answer_provider;
}

const SELECT_CLAIMED = `
  SELECT t.id, t.run_id, t.project_id, t.prompt_id, t.model_id, t.iteration, t.question_text,
         t.is_perception, t.status, t.attempts, t.next_attempt_at, t.locked_at, t.locked_by,
         t.answer_text, t.answer_tokens, t.latency_ms, t.provider_cost_usd, t.error,
         t.failure_code, t.created_at,
         m.provider AS provider,
         m.model_id AS provider_model_id,
         m.supports_web_search AS supports_web_search
    FROM run_tasks t
    JOIN models m ON m.id = t.model_id
   WHERE t.id IN (%ids%)
   ORDER BY t.next_attempt_at`;

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function toClaimedTask(row: ClaimedRow): ClaimedTask {
  const {
    provider,
    provider_model_id: providerModelId,
    supports_web_search: supportsWebSearch,
    ...task
  } = row;
  return {
    task,
    phase: task.status as Extract<TaskStatus, "in_flight" | "extracting">,
    provider,
    providerModelId,
    supportsWebSearch: supportsWebSearch === 1,
  };
}

/**
 * Up to `limit` claimable tasks, oldest next_attempt_at first, never taking a
 * provider past its in-flight cap. Claimable means status in (queued,
 * answered), next_attempt_at has passed, attempts is under MAX_TASK_ATTEMPTS,
 * and the task's run is still queued or running. A task skipped because its
 * provider is at cap stays unclaimed for a later pass. The cap applies before
 * the claim: a limiter applied after it would hold locked rows across the
 * reaper window and pay for one answer twice (docs/architecture.md, "The
 * worker loop").
 */
export function claimTasks(
  db: Driver,
  limit: number,
  lockedBy: string,
  caps: Record<Provider, number> = DEFAULT_PROVIDER_CAPS,
  extractorProvider: ExtractorProvider = preferredExtractorProvider(db),
): ClaimedTask[] {
  if (limit <= 0) return [];
  const now = new Date().toISOString();

  return db.immediateTransaction(() => {
    const candidates = db
      .prepare(SELECT_CLAIMABLE)
      .all<CallRow>(now, MAX_TASK_ATTEMPTS, CANDIDATE_SCAN_LIMIT);

    // The schema CHECK admits two provider names the app never calls. A row
    // carrying one has no cap entry and falls back to the global limit below.
    const inFlight = new Map<Provider, number>();
    for (const row of db.prepare(SELECT_IN_FLIGHT).all<CallRow>()) {
      const provider = callProvider(row, extractorProvider);
      inFlight.set(provider, (inFlight.get(provider) ?? 0) + 1);
    }

    const ids: string[] = [];
    for (const candidate of candidates) {
      if (ids.length >= limit) break;
      const provider = callProvider(candidate, extractorProvider);
      const used = inFlight.get(provider) ?? 0;
      if (used >= (caps[provider] ?? limit)) continue;
      inFlight.set(provider, used + 1);
      ids.push(candidate.id);
    }
    if (ids.length === 0) return [];

    // One UPDATE, so selection, phase routing, lock and attempt increment cannot
    // come apart. The status found decides the status written.
    db.prepare(
      `UPDATE run_tasks
          SET status = CASE WHEN status = 'queued' THEN 'in_flight' ELSE 'extracting' END,
              locked_at = ?, locked_by = ?, attempts = attempts + 1
        WHERE id IN (${placeholders(ids.length)})`,
    ).run(now, lockedBy, ...ids);

    return db
      .prepare(SELECT_CLAIMED.replace("%ids%", placeholders(ids.length)))
      .all<ClaimedRow>(...ids)
      .map(toClaimedTask);
  });
}

/**
 * Fails every claimable task at or past the attempt ceiling, writing
 * MAX_ATTEMPTS_EXCEEDED only where `error` is null, so a row that already
 * recorded a reason keeps its own code. Returns the run id of each task it
 * failed, one entry per task; the caller owns recounting those runs.
 */
export function failExhaustedTasks(db: Driver): string[] {
  return db
    .prepare(
      `UPDATE run_tasks
          SET status = 'failed',
              error = coalesce(error, ?),
              failure_code = coalesce(failure_code,
                CASE WHEN error IS NULL THEN ? END),
              locked_at = NULL,
              locked_by = NULL
        WHERE status IN ('queued','answered') AND attempts >= ?
    RETURNING run_id`,
    )
    .all<{ run_id: string }>(EXHAUSTED_DETAIL, EXHAUSTED_CODE, MAX_TASK_ATTEMPTS)
    .map((row) => row.run_id);
}
