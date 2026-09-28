/**
 * One bounded pass of the run queue: reap, claim, call, persist, finalise.
 *
 * Database writes go through src/server/logic or ./queries. This file owns the
 * ordering and the provider calls.
 *
 * Two orderings must hold:
 *
 *   1. The answer is persisted before extraction starts, and the extraction
 *      phase re-reads the stored text instead of the claimed row. A failed
 *      extraction then costs one cheap call to redo, not the searching answer
 *      call again.
 *   2. Nothing queues after a task is claimed. The whole batch runs under
 *      Promise.allSettled, so BATCH_SIZE is the overall ceiling, divided by
 *      the per-provider in-flight caps claimTasks applies
 *      (logic/claim-tasks.ts). A limiter after the claim would hold claimed
 *      tasks locked while they wait. They could cross the reaper's stale-lock
 *      window and be reclaimed, and the provider would be called a second time
 *      while the first call was still running.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import type { ModelProvider, ModelRow, RunTaskRow } from "../db/types";
import type { ClaimedTask } from "../logic/types";
import { claimTasks } from "../logic/claim-tasks";
import { effectiveCaps } from "./concurrency";
import { finalizeRun } from "../logic/finalize-run";
import { reapStuckTasks } from "../logic/recovery";
import {
  backoffAt,
  failTask,
  releaseTaskForRetry,
  storeAnswer,
  storeExtraction,
} from "../logic/store-answer";
import { updateRunProgress } from "../logic/update-run-progress";
import { recordUsageEvent } from "../logic/usage";
import { autoTrackTopCompetitor, enrichNewBrands } from "./brand-enrichment";
import {
  buildObservations,
  EXTRACTION_SHAPE,
  EXTRACTION_SYSTEM,
  extractionUserPrompt,
  parseExtraction,
  type BrandResolver,
  type MatchableBrand,
} from "./extraction";
import {
  extractionLadder as buildExtractionLadder,
  walkExtractionLadder,
} from "./extraction-ladder";
import { resolveProviderKey } from "./keys";
import { resolveExtractionModel } from "./extractor";
import { classifyFailure } from "@/lib/failure-reasons";
import {
  deriveCodeFromMessage,
  failureCode,
  failureCodeBase,
  toStoredFailure,
} from "@/lib/failure-codes";
import { mockCallProvider, mockProvidersEnabled } from "./mock-provider";
import {
  parsePerception,
  perceptionUserPrompt,
  PERCEPTION_SYSTEM,
  summarisePerception,
  type PerceptionFields,
} from "./perception-extract";
import {
  ANSWER_MAX_TOKENS,
  callExtractionModel,
  callProvider,
  EXTRACTION_MAX_TOKENS,
  MAX_SEARCHES,
  ProviderError,
  scrubError,
  supportedProvider,
  timeoutForRetry,
  type Provider,
  type ProviderResult,
  type ProviderUsage,
} from "./providers";
import {
  countPendingTasks,
  getExtractionPrompt,
  getModel,
  getStoredAnswerText,
  getStoredCaps,
  insertDiscoveredBrand,
  listFinalisationCandidates,
  listMatchableBrands,
  markTaskDone,
  targetBrandName,
  type RunCandidate,
} from "./queries";
import { writePerceptionSummary } from "../logic/perception-summary";

/**
 * Tasks claimed and run concurrently per pass: the overall ceiling. The
 * per-provider in-flight caps (logic/claim-tasks.ts, overridable through
 * worker/concurrency.ts) divide it at claim time, so a mixed batch cannot
 * oversubscribe one provider. It equals the sum of the default caps
 * (6 + 6 + 3), so a smaller global ceiling strands no provider's allowance.
 * It is also the highest cap Account settings accepts (lib/inflight-caps.ts,
 * migration 0010), because no pass could reach a higher one.
 */
export const BATCH_SIZE = 15;

/** How long a pass keeps claiming new batches before it yields to the loop. */
export const DEFAULT_BUDGET_MS = 45_000;

/** Answer text is stored sliced, so one runaway answer cannot bloat the file. */
const ANSWER_TEXT_LIMIT = 100_000;

const ANSWER_SYSTEM =
  "You are a helpful assistant answering a buyer's question. Recommend specific products or companies by name, as you normally would. Cite the sources you use: when a claim comes from a web page you found, include that page's URL next to the claim.";

/**
 * Gemini's grounding tool has no force mode, so a skipped search can only be
 * pushed for in words. Prepended to the question on a retry after
 * NO_WEB_SEARCH, never on a first attempt, which asks the question the way a
 * buyer would.
 */
const GEMINI_SEARCH_PRESSURE = "You must use the Google Search tool before answering.";

export interface WorkerPassOptions {
  /** Checked only between batches, so a pass can outlive it by one call. */
  budgetMs?: number;
  /** The lock stamp written on every claimed row. Defaults to a short uuid. */
  lockedBy?: string;
  /** Injected for tests. Used by the reaper to judge lock age. */
  now?: Date;
}

export interface WorkerPassResult {
  processed: number;
  finalised: number;
}

/**
 * Catalogue prices times reported usage. A mock call costs nothing, since the
 * seam bills nothing, but its usage row is still written.
 */
export function costOf(model: ModelRow | undefined, r: ProviderUsage): number {
  if (!model || mockProvidersEnabled()) return 0;
  return (
    ((r.inputTokens ?? 0) / 1_000_000) * Number(model.input_price_per_mtok) +
    ((r.outputTokens ?? 0) / 1_000_000) * Number(model.output_price_per_mtok) +
    (r.searchCalls ?? 0) * Number(model.search_price_per_call)
  );
}

/**
 * An estimate for a billed call that reported no usage. It errs high, because
 * a call recorded as zero never shows up in the spend figure.
 *
 * Output tokens are a true worst case, since the caps are sent on every
 * provider. Input tokens are a fixed guess that search results can exceed.
 * MAX_SEARCHES applies on Anthropic only, so for OpenAI and Google the search
 * count is a floor.
 */
export function worstCaseCost(model: ModelRow | undefined, kind: "answer" | "extraction"): number {
  if (!model || mockProvidersEnabled()) return 0;
  const inputTokens = kind === "answer" ? 1_500 : 4_000;
  const outputTokens = kind === "answer" ? ANSWER_MAX_TOKENS : EXTRACTION_MAX_TOKENS;
  const searches = kind === "answer" ? MAX_SEARCHES : 0;
  return (
    (inputTokens / 1_000_000) * Number(model.input_price_per_mtok) +
    (outputTokens / 1_000_000) * Number(model.output_price_per_mtok) +
    searches * Number(model.search_price_per_call)
  );
}

/**
 * Whether a failed call may have been billed: a 5xx, an empty answer, a
 * timeout, or any throw that is not a ProviderError. A timeout only ends the
 * wait: the provider still finishes the answer and bills it. A 4xx, or a
 * network error before any response (status 0), counts as unbilled.
 */
export function mayHaveBilled(err: unknown): boolean {
  if (err instanceof ProviderError) {
    const base = failureCodeBase(err.code);
    return err.status >= 500 || base === "EMPTY_ANSWER" || base === "TIMEOUT";
  }
  return true;
}

/** supportedProvider, but a provider with no adapter fails the task. */
function asProvider(provider: ModelProvider): Provider {
  const supported = supportedProvider(provider);
  if (!supported) {
    throw new ProviderError(
      `UNSUPPORTED_PROVIDER:${provider}`,
      400,
      failureCode("UNSUPPORTED_PROVIDER", provider),
    );
  }
  return supported;
}

/**
 * Reads cached for the whole pass: catalogue rows for costs, brand lists for
 * name resolution, and each project's extraction prompt, model and ladder.
 */
export class PassContext {
  private readonly models = new Map<string, ModelRow | undefined>();
  private readonly brands = new Map<string, MatchableBrand[]>();
  private readonly extractors = new Map<string, ModelRow | null>();
  private readonly extractionPrompts = new Map<string, string>();
  private readonly ladders = new Map<string, ModelRow[]>();

  constructor(private readonly db: Driver) {}

  model(modelId: string): ModelRow | undefined {
    if (!this.models.has(modelId)) this.models.set(modelId, getModel(this.db, modelId));
    return this.models.get(modelId);
  }

  brandList(projectId: string): MatchableBrand[] {
    let hit = this.brands.get(projectId);
    if (!hit) {
      hit = listMatchableBrands(this.db, projectId);
      this.brands.set(projectId, hit);
    }
    return hit;
  }

  invalidateBrands(projectId: string): void {
    this.brands.delete(projectId);
  }

  resolver(projectId: string): BrandResolver {
    return {
      list: () => this.brandList(projectId),
      create: (name: string) => insertDiscoveredBrand(this.db, projectId, name),
      invalidate: () => this.invalidateBrands(projectId),
    };
  }

  /** The project's stored extraction prompt, or EXTRACTION_SYSTEM when the row is missing. */
  extractionPrompt(projectId: string): string {
    const hit = this.extractionPrompts.get(projectId);
    if (hit !== undefined) return hit;
    const prompt = getExtractionPrompt(this.db, projectId) ?? EXTRACTION_SYSTEM;
    this.extractionPrompts.set(projectId, prompt);
    return prompt;
  }

  /** The project's extraction model, by the rule in worker/extractor.ts. */
  extractionModel(projectId: string): ModelRow | null {
    const hit = this.extractors.get(projectId);
    if (hit !== undefined) return hit;
    const chosen = resolveExtractionModel(this.db, projectId);
    this.extractors.set(projectId, chosen);
    return chosen;
  }

  /**
   * The readers one stored answer climbs through when a model replies in the
   * wrong shape (see worker/extraction-ladder).
   */
  extractionLadder(projectId: string): ModelRow[] {
    const hit = this.ladders.get(projectId);
    if (hit !== undefined) return hit;
    const rungs = buildExtractionLadder(this.db, this.extractionModel(projectId));
    this.ladders.set(projectId, rungs);
    return rungs;
  }
}

/**
 * Makes the answer call. Mock mode is checked here as well as inside
 * callProvider, because only this caller knows the project's brand names to
 * put in the canned answer.
 */
async function callModel(args: {
  provider: Provider;
  modelId: string;
  apiKey: string;
  system: string;
  user: string;
  jsonMode: boolean;
  webSearch: boolean;
  maxTokens: number;
  /** This attempt's wall-clock budget, raised after a timeout (timeoutForRetry). */
  timeoutMs: number;
  brands?: readonly string[] | undefined;
  citationDomain?: string | null | undefined;
}): Promise<ProviderResult> {
  if (mockProvidersEnabled()) {
    return mockCallProvider({
      provider: args.provider,
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      jsonMode: args.jsonMode,
      brands: args.brands,
      citationDomain: args.citationDomain,
    });
  }
  return callProvider({
    provider: args.provider,
    modelId: args.modelId,
    apiKey: args.apiKey,
    system: args.system,
    user: args.user,
    jsonMode: args.jsonMode,
    webSearch: args.webSearch,
    maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs,
  });
}

function logUsage(
  db: Driver,
  task: RunTaskRow,
  model: ModelRow | undefined,
  kind: "answer" | "extraction",
  result: ProviderResult,
  outcome: "success" | "retried",
): void {
  recordUsageEvent(db, {
    runId: task.run_id,
    runTaskId: task.id,
    kind,
    provider: model?.provider ?? "unknown",
    modelId: model?.model_id ?? "unknown",
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    searchCalls: result.searchCalls,
    costUsd: costOf(model, result),
    costEstimated: true,
    outcome,
  });
}

/** A call that burned tokens and returned nothing usable still gets a row. */
function logFailedUsage(
  db: Driver,
  task: RunTaskRow,
  model: ModelRow | undefined,
  kind: "answer" | "extraction",
  reported?: ProviderUsage | undefined,
): void {
  // The response's own usage wins whenever it reported any, since worst-case
  // numbers badly overstate a rejected answer. A billed call that reported
  // nothing gets the estimate, never zero. "Reported" means non-zero: the
  // Anthropic adapter defaults missing usage fields to 0.
  const hasReal =
    reported !== undefined &&
    ((reported.inputTokens ?? 0) > 0 ||
      (reported.outputTokens ?? 0) > 0 ||
      reported.searchCalls > 0);
  recordUsageEvent(db, {
    runId: task.run_id,
    runTaskId: task.id,
    kind,
    provider: model?.provider ?? "unknown",
    modelId: model?.model_id ?? "unknown",
    inputTokens: hasReal ? (reported.inputTokens ?? 0) : 0,
    outputTokens: hasReal ? (reported.outputTokens ?? 0) : 0,
    searchCalls: hasReal ? reported.searchCalls : 0,
    costUsd: hasReal ? costOf(model, reported) : worstCaseCost(model, kind),
    costEstimated: true,
    outcome: "failed",
  });
}

async function answerPhase(db: Driver, claimed: ClaimedTask, ctx: PassContext): Promise<void> {
  const { task, provider, providerModelId, supportsWebSearch } = claimed;

  // createRun stores the composed, {brand}-resolved question on the task, so
  // that is what gets asked and what the run detail shows.
  const question = task.question_text ?? "";
  if (!question.trim()) {
    throw new ProviderError(
      "PROMPT_MISSING: this task has no question to ask.",
      400,
      "PROMPT_MISSING",
    );
  }
  // The claimed row carries this phase's last failure reason, so only a retry
  // after a skipped search gets the pressure. A timeout retry asks the plain
  // question again. classifyFailure is the same reading the failure card uses.
  const user =
    provider === "google" && classifyFailure(toStoredFailure(task)).key === "no-web-search"
      ? `${GEMINI_SEARCH_PRESSURE}\n\n${question}`
      : question;

  const model = ctx.model(task.model_id);
  const brandRows = ctx.brandList(task.project_id);
  const key = resolveProviderKey(provider);
  if (!key) {
    throw new ProviderError(
      `MISSING_CREDENTIAL:${provider}`,
      400,
      failureCode("MISSING_CREDENTIAL", provider),
    );
  }

  const started = Date.now();
  let result: ProviderResult | undefined;
  try {
    result = await callModel({
      provider,
      modelId: providerModelId,
      apiKey: key,
      system: ANSWER_SYSTEM,
      user,
      jsonMode: false,
      // Every answer is asked to search. An answer from the model's training
      // data is not what a run measures, so there is no project switch.
      webSearch: supportsWebSearch,
      maxTokens: ANSWER_MAX_TOKENS,
      // A retry after a timeout gets the raised budget.
      timeoutMs: timeoutForRetry(toStoredFailure(task)),
      brands: brandRows.map((b) => b.name),
      // The canned answer links the first brand it names to this domain.
      // Without a domain the link never matches a brand, and the mock run's
      // citation rate reads zero.
      citationDomain: brandRows[0]?.domains[0],
    });
    // Record why there is no text. The usual cause is a paused turn or a
    // server tool that errored, both HTTP 200 with no text block, not a model
    // that returned nothing.
    if (!result.text.trim()) {
      throw new ProviderError(
        `EMPTY_ANSWER: stop_reason=${result.stopReason ?? "unreported"}`,
        502,
        failureCode("EMPTY_ANSWER", result.stopReason ?? "unreported"),
      );
    }
    // A search was asked for and none happened. The answer measures the
    // model's training data, not the live web, so it is not stored. A 502 like
    // EMPTY_ANSWER: the provider answered and billed, and a retry is worth it
    // because a model that skipped searching once usually searches next time.
    if (supportsWebSearch && (result.searchCalls ?? 0) === 0) {
      throw new ProviderError(
        "NO_WEB_SEARCH: the assistant answered without searching the web",
        502,
        "NO_WEB_SEARCH",
      );
    }
  } catch (err) {
    // A rejected response was still billed. Its usage is on `result` when this
    // function rejected it, and on the error when the adapter did.
    const reported = result ?? (err instanceof ProviderError ? err.usage : undefined);
    if (reported || mayHaveBilled(err)) logFailedUsage(db, task, model, "answer", reported);
    throw err;
  }

  storeAnswer(db, task.id, {
    answerText: result.text.slice(0, ANSWER_TEXT_LIMIT),
    answerTokens: result.tokens,
    latencyMs: Date.now() - started,
    providerCostUsd: costOf(model, result),
  });

  logUsage(db, task, model, "answer", result, "success");
  updateRunProgress(db, task.run_id);
}

async function extractPhase(db: Driver, claimed: ClaimedTask, ctx: PassContext): Promise<void> {
  const { task } = claimed;

  // The stored answer, not the claimed row's, so an extraction retry never
  // re-buys the answer.
  const answerText = getStoredAnswerText(db, task.id);
  if (!answerText) throw new ProviderError("NO_ANSWER_TO_EXTRACT", 400, "NO_ANSWER_TO_EXTRACT");

  const model = ctx.extractionModel(task.project_id);
  if (!model) throw new ProviderError("NO_EXTRACTION_CREDENTIAL", 400, "NO_EXTRACTION_CREDENTIAL");
  // Fails the task before any call when the extractor has no adapter.
  asProvider(model.provider);

  // A retry after a timeout gets the raised budget. Every rung of the ladder
  // shares it, because the failure history belongs to the task.
  const timeoutMs = timeoutForRetry(toStoredFailure(task));

  const call = (system: string, user: string): Promise<ProviderResult> =>
    callExtractionModel(model, system, user, { timeoutMs });

  if (task.is_perception === 1) {
    await perceptionPhase(db, task, model, answerText, call);
    return;
  }

  const user = extractionUserPrompt(answerText);
  // The canonical prompt unless someone edited it in project settings.
  const extractionSystem = ctx.extractionPrompt(task.project_id);

  // Every provider enforces the shape in the request. A model that still
  // replies in the wrong shape is re-read by the next rung inside this claim,
  // so the task stays `extracting` and the answer is never bought twice.
  // Running out of rungs raises a non-retryable EXTRACTION_UNREADABLE.
  const walked = await walkExtractionLadder(
    ctx.extractionLadder(task.project_id),
    extractionSystem,
    user,
    (rung, system, prompt) =>
      callExtractionModel(rung, system, prompt, { jsonSchema: EXTRACTION_SHAPE, timeoutMs }),
    parseExtraction,
    {
      // A discarded reply was still billed.
      onViolation: (rung, raw) => logUsage(db, task, rung, "extraction", raw, "retried"),
      onCallError: (rung, error) => {
        const reported = error instanceof ProviderError ? error.usage : undefined;
        if (reported || mayHaveBilled(error)) {
          logFailedUsage(db, task, rung, "extraction", reported);
        }
      },
    },
  );

  storeExtraction(db, task.id, {
    answerFormat: walked.extraction.answer_format,
    totalItems: walked.extraction.total_items,
    rawJson: walked.extraction,
    modelUsed: `${walked.model.provider}/${walked.model.model_id}`,
    observations: buildObservations(walked.extraction, ctx.resolver(task.project_id)),
  });

  logUsage(db, task, walked.model, "extraction", walked.result, "success");
  updateRunProgress(db, task.run_id);
}

/**
 * A perception answer is read into four sections instead of mined for brands,
 * and written to perception_summaries, never brand_observations. So perception
 * cannot produce a measurement, even if the extractor finds brands in a
 * company description.
 *
 * It asks for different JSON, so it skips the enforced shape and the ladder
 * and retries the parse once.
 */
async function perceptionPhase(
  db: Driver,
  task: RunTaskRow,
  model: ModelRow,
  answerText: string,
  call: (system: string, user: string) => Promise<ProviderResult>,
): Promise<void> {
  const brand = targetBrandName(db, task.project_id);
  const user = perceptionUserPrompt(brand, answerText);

  let raw: ProviderResult;
  try {
    raw = await call(PERCEPTION_SYSTEM, user);
  } catch (err) {
    if (mayHaveBilled(err)) logFailedUsage(db, task, model, "extraction");
    throw err;
  }

  let fields: PerceptionFields;
  try {
    fields = parsePerception(raw.text);
  } catch {
    logUsage(db, task, model, "extraction", raw, "retried");
    try {
      raw = await call(PERCEPTION_SYSTEM, user);
      fields = parsePerception(raw.text);
    } catch (err) {
      if (mayHaveBilled(err)) logFailedUsage(db, task, model, "extraction");
      throw err;
    }
  }

  writePerceptionSummary(db, task.project_id, task.model_id, {
    ...fields,
    run_id: task.run_id,
    question_text: task.question_text,
    source_answers: 1,
  });

  markTaskDone(db, task.id);
  logUsage(db, task, model, "extraction", raw, "success");
  updateRunProgress(db, task.run_id);
}

/**
 * Which phase runs is decided purely by the status the claimer left on the row:
 * `in_flight` means the answer call is in progress, `extracting` means the
 * extraction call is.
 */
export async function processTask(
  db: Driver,
  claimed: ClaimedTask,
  ctx: PassContext,
): Promise<void> {
  const { task, phase } = claimed;
  try {
    if (phase === "in_flight") await answerPhase(db, claimed, ctx);
    else await extractPhase(db, claimed, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A throw that is not a ProviderError is retryable. Status 0 is a local
    // failure: a timeout, an abort, a network error, DEADLINE_EXCEEDED.
    const retryable = err instanceof ProviderError ? err.retryable : true;
    // A ProviderError carries its code from the throw site. Anything else is
    // classified from its message, and an unrecognised one is UNEXPECTED.
    const code = err instanceof ProviderError ? err.code : deriveCodeFromMessage(message);
    if (!retryable) {
      failTask(db, task.id, code, scrubError(message));
    } else {
      // Never gives up here. The attempt ceiling lives in the claim query and
      // the exhausted sweep, where the attempt counter is incremented.
      releaseTaskForRetry(db, task.id, code, scrubError(message), backoffAt(task.attempts));
    }
    // Scrubbed again, so a throw site that forgets to scrub cannot print a
    // raw key.
    console.error("[worker] task failed", {
      task_id: task.id,
      run_id: task.run_id,
      message: scrubError(message),
    });
  }
}

export async function runWorkerPass(
  db: Driver,
  options: WorkerPassOptions = {},
): Promise<WorkerPassResult> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const lockedBy = options.lockedBy ?? randomUUID().slice(0, 8);
  const deadline = Date.now() + budgetMs;
  const touchedRuns = new Set<string>();
  let processed = 0;

  // Reap first, so an abandoned claim is claimable again and a task out of
  // attempts is closed. reapStuckTasks does both.
  reapStuckTasks(db, options.now ?? new Date());

  const ctx = new PassContext(db);

  // Read every pass, so a cap saved in Account settings applies from the next
  // pass with no restart.
  const caps = effectiveCaps(getStoredCaps(db));
  const extractorProvider = (projectId: string) => {
    const model = ctx.extractionModel(projectId);
    return model ? supportedProvider(model.provider) : null;
  };

  // The budget is checked only between batches. A batch in flight runs to
  // completion, so a pass can outlive its budget by one call's budget,
  // possibly the raised one.
  while (Date.now() < deadline) {
    const claimed = claimTasks(db, BATCH_SIZE, lockedBy, caps, extractorProvider);
    if (claimed.length === 0) break;
    await Promise.allSettled(claimed.map((task) => processTask(db, task, ctx)));
    for (const task of claimed) touchedRuns.add(task.task.run_id);
    processed += claimed.length;
  }

  for (const runId of touchedRuns) {
    try {
      updateRunProgress(db, runId);
    } catch (err) {
      logRunFailure("recount", runId, err);
    }
  }

  let finalised = 0;
  for (const candidate of listFinalisationCandidates(db, [...touchedRuns])) {
    if (countPendingTasks(db, candidate.id) !== 0) continue;
    try {
      await scoreDrainedRun(db, ctx, candidate);
      finalised += 1;
    } catch (err) {
      logRunFailure("scoring", candidate.id, err);
    }
  }

  return { processed, finalised };
}

/**
 * Enrichment seeds the domains citation attribution needs, finalisation
 * computes the metrics, and auto-tracking reads those metrics back, so the
 * order is fixed.
 */
async function scoreDrainedRun(db: Driver, ctx: PassContext, run: RunCandidate): Promise<void> {
  enrichNewBrands(db, run.id, run.project_id);
  finalizeRun(db, run.id);
  autoTrackTopCompetitor(db, run.id, run.project_id);
  await summarisePerception(db, run.id, run.project_id, {
    call: mergeCall(ctx, run.project_id),
    recordUsage: (anchorTaskId, result) => {
      const model = ctx.extractionModel(run.project_id);
      recordUsageEvent(db, {
        runId: run.id,
        runTaskId: anchorTaskId,
        kind: "extraction",
        provider: model?.provider ?? "unknown",
        modelId: model?.model_id ?? "unknown",
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        searchCalls: result.searchCalls,
        costUsd: costOf(model ?? undefined, result),
        costEstimated: true,
        outcome: "success",
      });
    },
  });
}

/** A run that fails to recount or score is logged and retried next pass, never skipping another. */
function logRunFailure(step: "recount" | "scoring", runId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[worker] run ${step} failed`, { run_id: runId, message: scrubError(message) });
}

/** The synthesis call, or null when there is no extractor to make it with. */
function mergeCall(
  ctx: PassContext,
  projectId: string,
): ((system: string, user: string) => Promise<ProviderResult>) | null {
  const model = ctx.extractionModel(projectId);
  if (!model) return null;
  // No usable extractor means no merge, not a failed task. The adapter would
  // throw on a missing adapter or key, so both are checked here first.
  const provider = supportedProvider(model.provider);
  if (!provider) return null;
  if (!resolveProviderKey(provider)) return null;
  return (system, user) => callExtractionModel(model, system, user);
}
