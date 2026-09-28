/**
 * The prop shapes the components under src/components take.
 *
 * These are view models, not row types. The names mirror src/server/db/types.ts
 * so a stored row maps straight in, but the shapes are what a component needs
 * to render: booleans instead of SQLite's 0 and 1, string arrays instead of
 * JSON text, and only the columns that reach a pixel.
 *
 * Nothing here imports from src/server. The browser never sees that code, and a
 * view model that depended on it would drag a database driver into the bundle.
 */
import type { Agg } from "@/lib/metrics";
import type { RunPlanCounts } from "@/lib/run-plan";
import type { SearchCheckStatus } from "@/lib/setup-check";
import type { StoredFailure } from "@/lib/failure-codes";

/** The three providers Overheard AI can call. Mirrors db types `Provider`. */
export type ProviderSlug = "openai" | "anthropic" | "google";

/** Mirrors db types `BrandRole`. */
export type BrandRole = "target" | "competitor" | "discovered";

/** Mirrors db types `Cadence`. */
export type Cadence = "daily" | "weekly" | "monthly";

/** A brand as the tables and charts need it. Mirrors `BrandRow` columns. */
export type BrandView = {
  id: string;
  name: string;
  role: BrandRole;
};

/** One brand beside its aggregated run_metrics rows. */
export type BrandAgg = {
  id: string;
  name: string;
  agg: Agg;
};

/** One row of the competitor table. */
export type CompetitorRow = {
  brand: BrandView;
  agg: Agg;
};

/** A prompt as the filter strip needs it. Mirrors `PromptRow` columns. */
export type PromptOption = {
  id: string;
  text: string;
};

/** One line of a trend chart. */
export type CompareSeries = {
  key: string;
  label: string;
  color: string;
};

/** One x position on a trend chart. Extra keys are the series values. */
export type ComparePoint = { date: string } & Record<string, number | string>;

/**
 * The four perception headings, in the order the dashboard shows them.
 *
 * The extractor's copy of this list lives in src/server/worker and cannot be
 * imported here, so the labels are duplicated. The keys are the
 * `perception_summaries` column names, which is what keeps the two in step.
 */
export const PERCEPTION_SECTIONS = [
  { key: "what_it_does", label: "What it does" },
  { key: "typical_customers", label: "Typical customers" },
  { key: "well_regarded_for", label: "Well regarded for" },
  { key: "downsides", label: "Downsides" },
] as const satisfies ReadonlyArray<{ key: PerceptionSectionKey; label: string }>;

export type PerceptionSectionKey =
  | "what_it_does"
  | "typical_customers"
  | "well_regarded_for"
  | "downsides";

/**
 * One stored summary. Mirrors `PerceptionSummaryRow`, with `knows_brand` as a
 * real boolean and the columns the band never reads left out.
 */
export type PerceptionSummary = {
  /** Null is the merged across-assistants row. */
  model_id: string | null;
  question_text: string | null;
  knows_brand: boolean;
  what_it_does: string | null;
  typical_customers: string | null;
  well_regarded_for: string | null;
  downsides: string | null;
  source_answers: number;
  updated_at: string;
};

/** A per-assistant summary with the assistant's display name resolved. */
export type NamedSummary = PerceptionSummary & { name: string };

/**
 * The newest perception-only run, counted from its tasks. Mirrors the server's
 * PerceptionRunView. The band reads it to say a check is still being asked or
 * stumbled, because the run itself is a page nobody is ever taken to: the
 * first run's page shows the measured run, and the perception half runs beside
 * it as its own run.
 */
export type PerceptionRunNotice = {
  runId: string;
  status: string;
  totalTasks: number;
  doneTasks: number;
  failedTasks: number;
  pendingTasks: number;
  /** The run's failures as stored: typed code (null on older rows) plus detail. */
  failedReasons: StoredFailure[];
  createdAt: string;
};

/**
 * A failed task, flattened. Mirrors `RunTaskRow`, with the prompt text and the
 * model's display name already joined so the card renders without a lookup.
 */
export type FailedTask = {
  id: string;
  status: string;
  iteration: number;
  error: string | null;
  /** The typed failure code for `error` (lib/failure-codes). Null on older rows. */
  failure_code: string | null;
  /** The question as it was sent. Null on tasks stored before it was recorded. */
  question_text: string | null;
  /** The live prompt row's text, null once the prompt is deleted. */
  prompt_text: string | null;
  model_name: string | null;
};

/**
 * A schedule as stored. Mirrors `ScheduleRow`, booleans decoded. `hour_utc` is
 * the local hour in `timezone`, whatever the column name says.
 */
export type Schedule = {
  id: string;
  cadence: Cadence;
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number;
  timezone: string;
  is_active: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_skip_reason: string | null;
};

/** What the schedule card hands back when the user saves. */
export type ScheduleDraft = {
  cadence: Cadence;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourUtc: number;
  timezone: string;
};

/** A project in the switcher. Mirrors `ProjectRow` columns. */
export type ProjectSummary = {
  id: string;
  name: string;
};

/** Whether a setup check has run for a provider, and what it said. */
export type SetupCheckState =
  | { state: "untested" }
  | { state: "checking" }
  | { state: "done"; status: SearchCheckStatus; message: string; hint?: string | undefined };

/**
 * One provider's key status. The key value itself never reaches the browser, so
 * `configured` is the only thing there is to show before a check.
 */
export type KeyStatus = {
  /**
   * Why a configured key is unusable, when it is. The sentence travels from
   * the worker's key check. A screen that drops it leaves the reader with
   * "key found" and a refusal that never explains itself.
   */
  problem?: string | null;
  provider: ProviderSlug;
  /** True when the environment holds a key for this provider. */
  configured: boolean;
  /**
   * Why it is configured. Mirrors `ProviderKeyStatus.source`: "env" is a real
   * key, "mock" is the offline seam answering for a provider the user has no
   * key for, "none" is neither. Without it the settings screen says "key found"
   * three times over on a machine with no keys at all.
   */
  source: "env" | "mock" | "none";
  result: SetupCheckState;
};

/**
 * What a run will cost before anything is spent: `calls` is provider calls,
 * `answers` is what a person asked for. See lib/run-progress.ts for why the two
 * units differ.
 */
export type RunPlan = RunPlanCounts & {
  /**
   * Calls the perception question adds on top of `calls`, which happens on a
   * project's first run only. Zero, or absent, means there is nothing extra.
   */
  perceptionCalls?: number | undefined;
  /**
   * What the run will cost in USD at catalogue list prices, when the caller
   * can compute one (the wizard and both Run now dialogs do). Absent means no
   * dollar line is shown. Always an estimate: the run screen logs real spend
   * per answer as it lands.
   */
  estimateUsd?: number | undefined;
};

/**
 * A run's counters. Mirrors `RunRow`. Every count is in provider calls, as
 * stored.
 */
export type RunProgress = {
  status: string | null;
  plannedCalls: number;
  completedCalls: number;
  failedCalls: number;
  /** Outstanding tasks, split: never asked, waiting on the automatic retry, call in flight. */
  fresh?: number;
  retrying?: number;
  working?: number;
};
