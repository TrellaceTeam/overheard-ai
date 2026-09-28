/**
 * The contract between the run logic and the worker: the functions in
 * src/server/logic take and return these types. Row types come from
 * db/types.ts and are not redefined here.
 */
import type { Provider, RunStatus, RunTaskRow, TaskStatus, UsageKind } from "../db/types";

/**
 * Attempts allowed per phase, not per task: storeAnswer resets the count to 0
 * when the answer lands. Two means one automatic retry. A third attempt spends
 * money on a call that has already failed twice, and the run page offers Retry.
 */
export const MAX_TASK_ATTEMPTS = 2;

/**
 * Per-call ceiling before the worker aborts and retries. An answer with web
 * search runs a search and then generates, so it takes tens of seconds on
 * every provider: measured answers have a median of about 52 s, and successful
 * ones run up to about 112 s.
 *
 * The budgets live in this module because the worker waits on them and the
 * recovery sweep's window is derived from them. A lock reclaimed while its
 * call is still in flight is the same answer paid for twice.
 */
export const TIMEOUT_MS = 240_000;

/**
 * The budget for an attempt whose previous one timed out, half as much again.
 * A retry under the same ceiling fails the same way. A call that ran past
 * 240 s is long, not dead: provider congestion comes and goes, and Anthropic's
 * pause_turn resumes share one deadline with the original call, so a heavy
 * multi-search turn can use up the standard budget.
 *
 * The raise does not grow. A call that misses 360 s is treated as hung and
 * ends on the failure card, where the user can retry it.
 */
export const RAISED_TIMEOUT_MS = 360_000;

/** The longest deadline any single call can hold. */
export const MAX_CALL_TIMEOUT_MS = RAISED_TIMEOUT_MS;

/**
 * Covers the time from the claim to the call's deadline starting, and the
 * write after it ends.
 */
const STUCK_LOCK_MARGIN_MS = 60_000;

/**
 * How long the running sweep lets a lock stand before treating it as dead. It
 * must exceed the longest call deadline, or the sweep reclaims a task whose
 * call is still in flight and the provider is paid twice for one answer. Boot
 * recovery ignores it: at boot no call from this process is in flight.
 */
export const STUCK_LOCK_MS = MAX_CALL_TIMEOUT_MS + STUCK_LOCK_MARGIN_MS;

// The call ceiling and its bounds live in src/lib/call-limits, so the Settings
// screen and the plan panel use the numbers the planner refuses at.
export { CALL_LIMIT_MAX, CALL_LIMIT_MIN, DEFAULT_MAX_PLANNED_CALLS } from "@/lib/call-limits";

export interface CreateRunOptions {
  trigger?: "manual" | "scheduled";
  /** Serialised into runs.config_snapshot. Defaults to {}. */
  configSnapshot?: Record<string, unknown>;
}

/** A task the worker has just locked, joined with the catalogue columns its call needs. */
export interface ClaimedTask {
  task: RunTaskRow;
  /** `in_flight` means ask the assistant, `extracting` means score the answer. */
  phase: Extract<TaskStatus, "in_flight" | "extracting">;
  provider: Provider;
  /** The provider's own model string, for example `claude-sonnet-5`. */
  providerModelId: string;
  /**
   * The catalogue capability. Every answer from a model that can search is
   * asked to search; projects.web_search_enabled is not read.
   */
  supportsWebSearch: boolean;
}

/** What the worker persists when an assistant call succeeds. */
export interface AnswerResult {
  answerText: string;
  answerTokens: number | null;
  latencyMs: number | null;
  providerCostUsd: number | null;
}

/** What the worker persists when extraction succeeds. */
export interface ExtractionResult {
  answerFormat: "ranked_list" | "unranked_list" | "prose" | "refusal";
  totalItems: number | null;
  /** The extractor's structured output, stored as returned. */
  rawJson: unknown;
  /** The provider model string that did the extraction. */
  modelUsed: string;
  observations: ObservationInput[];
}

/** One brand seen in one answer. Never written for a perception task. */
export interface ObservationInput {
  /** Null when the raw name resolved to nothing. The row is kept anyway. */
  brandId: string | null;
  rawName: string;
  position: number | null;
  totalItems: number | null;
  mentionType: "ranked" | "recommended" | "mentioned" | "negative";
  linkedUrl: string | null;
  isCited: boolean;
  evidence: string | null;
}

/** The counters after a progress update, and the status they produced. */
export interface RunProgress {
  runId: string;
  status: RunStatus;
  plannedCalls: number;
  completedCalls: number;
  failedCalls: number;
  /** Tasks not yet terminal. Zero means the run has drained. */
  pending: number;
  /**
   * The pending tasks, split three ways so a screen can show one accounting
   * where the parts sum to the whole: `fresh` have not been asked yet,
   * `retrying` failed an attempt and are waiting on the automatic one, and
   * `working` have a call in flight (or an answer waiting on its first
   * extraction).
   */
  fresh: number;
  retrying: number;
  working: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What finalisation wrote. Running it twice produces the same numbers. */
export interface FinalizeSummary {
  runId: string;
  /** run_metrics rows written, both scope levels. */
  metricRows: number;
  progress: RunProgress;
}

/** Tasks moved by a recovery sweep. */
export interface RecoverySummary {
  /** in_flight returned to queued. The answer was never bought. */
  requeued: number;
  /** extracting returned to answered. Never to queued: the answer is paid for. */
  returnedToAnswered: number;
  /** Claimable tasks at or past the attempt ceiling, closed out. */
  exhausted: number;
}

export type Cadence = "daily" | "weekly" | "monthly";

/** Everything nextOccurrence needs. Mirrors the schedules row. */
export interface ScheduleSpec {
  cadence: Cadence;
  dayOfWeek: number | null;
  /** 1 to 28, so a monthly schedule exists in every month. */
  dayOfMonth: number | null;
  /** The local hour in `timezone`, despite the name. */
  hourUtc: number;
  /** An IANA zone name, for example `Europe/London`. */
  timezone: string;
}

export interface EnqueueSummary {
  /** Runs actually created. */
  created: number;
  /** Occurrences that advanced next_run_at without creating a run. */
  skipped: number;
}

export interface UsageEventInput {
  runId: string | null;
  runTaskId: string | null;
  kind: UsageKind;
  provider: string;
  /** The provider's own model string, so the log outlives a catalogue row. */
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  costUsd: number;
  /** Always true: prices are list rates, shown as estimates. */
  costEstimated: boolean;
  /** `ok`, or the error class that ended the call. */
  outcome: string;
}
