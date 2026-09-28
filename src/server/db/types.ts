/**
 * Row types for every table, in the shape SQLite hands back: snake_case column
 * names, INTEGER 0 or 1 where the domain has a boolean, TEXT holding ISO-8601
 * for every timestamp, and TEXT holding a JSON array for every string list.
 *
 * These are storage types, not view models. Nothing here is decoded: a caller
 * that wants `string[]` out of `brands.variants` parses it, and a caller that
 * wants a boolean compares to 1. Keeping the raw shape means a row read and a
 * row written are the same type, and a column added to the schema shows up as a
 * type error at every site that builds one.
 */

/** SQLite has no boolean. 0 is false, 1 is true. */
export type SqlBool = 0 | 1;

export type Provider = "openai" | "anthropic" | "google";

/** The models CHECK also admits two providers the app never calls. */
export type ModelProvider = Provider | "perplexity" | "moonshot";

export type ModelTier = "extraction" | "mid" | "frontier";
export type BrandRole = "target" | "competitor" | "discovered";
export type RunTrigger = "manual" | "scheduled";
export type RunStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type TaskStatus = "queued" | "in_flight" | "answered" | "extracting" | "done" | "failed";
export type AnswerFormat = "ranked_list" | "unranked_list" | "prose" | "refusal";
export type MentionType = "ranked" | "recommended" | "mentioned" | "negative";
export type Cadence = "daily" | "weekly" | "monthly";
export type UsageKind =
  | "answer"
  | "extraction"
  | "summary"
  | "prompt_summary"
  | "prompt_generation";

export interface ModelRow {
  id: string;
  provider: ModelProvider;
  /** The provider's own string id, for example `claude-haiku-4-5`. */
  model_id: string;
  display_name: string;
  tier: ModelTier;
  supports_web_search: SqlBool;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  search_price_per_call: number;
  is_extraction_model: SqlBool;
  /** Lower is preferred as the extractor. Null on a model that cannot extract. */
  extraction_rank: number | null;
  is_active: SqlBool;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  extraction_model_id: string | null;
  /** Not read: search follows models.supports_web_search, with no project switch. */
  web_search_enabled: SqlBool;
  /** Blank disables perception. There is no separate enabled flag. */
  perception_prompt: string;
  /** The prompt extraction calls use for this project; the canonical text until edited. */
  extraction_prompt: string;
  /** The built-in demo project (ADR 0006): invented data, browse-only. At most one per database. */
  is_demo: SqlBool;
  /**
   * The brand description from setup: one sentence on what the brand does, for
   * whom and where. Null when left empty. Starter prompt generation reads the
   * setup screen's copy before the project exists, so no screen reads this back.
   */
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandRow {
  id: string;
  project_id: string;
  name: string;
  role: BrandRole;
  /** JSON array of strings. */
  variants: string;
  /** JSON array of strings. */
  domains: string;
  /** JSON array of strings. */
  suggested_domains: string;
  is_active: SqlBool;
  created_at: string;
}

export interface PromptRow {
  id: string;
  project_id: string;
  text: string;
  context: string | null;
  /** The user-facing tag. Null is the Untagged bucket. */
  category: string | null;
  iterations: number;
  is_active: SqlBool;
  /** Out of sight in the library's bottom fold; answers kept and still counted. */
  archived: SqlBool;
  created_at: string;
  updated_at: string;
}

export interface ProjectModelRow {
  project_id: string;
  model_id: string;
}

export interface RunRow {
  id: string;
  project_id: string;
  trigger: RunTrigger;
  status: RunStatus;
  /** Provider calls, already doubled. */
  planned_calls: number;
  completed_calls: number;
  failed_calls: number;
  /** JSON object. */
  config_snapshot: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** 1 when the answers came from the offline provider seam rather than a provider. */
  mock: SqlBool;
  /** When the run was scored. Null means it never has been. */
  finalised_at: string | null;
  created_at: string;
}

export interface RunTaskRow {
  id: string;
  run_id: string;
  project_id: string;
  /** Null on a perception task. The app deletes a prompt's measured tasks with it. */
  prompt_id: string | null;
  model_id: string;
  iteration: number;
  /** The question as sent, context composed and {brand} resolved. */
  question_text: string | null;
  is_perception: SqlBool;
  status: TaskStatus;
  attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  answer_text: string | null;
  answer_tokens: number | null;
  latency_ms: number | null;
  provider_cost_usd: number | null;
  error: string | null;
  /**
   * The typed failure code (lib/failure-codes) for the stored `error`. Null on
   * any task that has not failed, and on rows written before migration 0009,
   * which classify from the prose.
   */
  failure_code: string | null;
  created_at: string;
}

export interface ExtractionRow {
  id: string;
  run_task_id: string;
  project_id: string;
  answer_format: AnswerFormat;
  total_items: number | null;
  /** The extractor's structured output, as returned. */
  raw_json: string;
  model_used: string;
  created_at: string;
}

export interface BrandObservationRow {
  id: string;
  run_task_id: string;
  run_id: string;
  project_id: string;
  /** Null means unresolved. Kept, and excluded from metrics. */
  brand_id: string | null;
  raw_name: string;
  position: number | null;
  total_items: number | null;
  mention_type: MentionType;
  linked_url: string | null;
  is_cited: SqlBool;
  evidence: string | null;
  created_at: string;
}

export interface RunMetricRow {
  id: string;
  run_id: string;
  project_id: string;
  /** Null means across every assistant. */
  model_id: string | null;
  /** Null means across every prompt. */
  prompt_id: string | null;
  brand_id: string | null;
  answers: number;
  mentions: number;
  ranked: number;
  citations: number;
  mention_rate: number;
  rank_rate: number;
  citation_rate: number;
  link_when_mentioned: number | null;
  avg_rank: number | null;
  best_rank: number | null;
  worst_rank: number | null;
  /** Population standard deviation. One sample gives 0. */
  rank_stddev: number | null;
  share_of_voice: number | null;
  top_pick_share: number | null;
  top3_rate: number | null;
  created_at: string;
}

export interface PerceptionSummaryRow {
  id: string;
  project_id: string;
  /** Null is the merged across-assistants row. */
  model_id: string | null;
  run_id: string | null;
  question_text: string | null;
  knows_brand: SqlBool;
  what_it_does: string | null;
  typical_customers: string | null;
  well_regarded_for: string | null;
  downsides: string | null;
  source_answers: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRow {
  id: string;
  project_id: string;
  cadence: Cadence;
  day_of_week: number | null;
  day_of_month: number | null;
  /** The local hour in `timezone`, despite the name. */
  hour_utc: number;
  timezone: string;
  is_active: SqlBool;
  next_run_at: string;
  last_run_at: string | null;
  last_skip_reason: string | null;
  last_skipped_at: string | null;
  created_at: string;
}

export interface UsageEventRow {
  id: string;
  run_id: string | null;
  run_task_id: string | null;
  kind: UsageKind;
  provider: string;
  /** The provider's own string id, not a models(id) reference. */
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  search_calls: number;
  cost_usd: number;
  cost_estimated: SqlBool;
  outcome: string;
  created_at: string;
}

export interface SchemaMigrationRow {
  version: string;
  applied_at: string;
}
