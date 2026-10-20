/**
 * Buying prose from the extraction model. Both summary kinds, the run page's
 * Answer summary and the Prompts tab's Prompt results summary, plan a feed and
 * store a paragraph. Everything in between lives here: the call, the spend
 * log, the worst-case sizing, the scrubbing and the refusals.
 *
 * The spend rules:
 * - a call refused before any request was made logs nothing, because nothing
 *   was spent;
 * - a call that may have billed and reported nothing logs the worst case,
 *   sized from what was sent, so a very long prompt is not undercounted;
 * - nothing billed is logged as zero, and under the mock provider mode or a
 *   plan in subscription mode every logged cost is zero, because neither
 *   bills per call;
 * - an empty reply is a refusal with its spend logged, because the call
 *   happened;
 * - a provider message reaches the user scrubbed of key-shaped strings.
 */
import type { Driver } from "../../db/driver";
import type { ModelRow } from "../../db/types";
import { recordUsageEvent } from "../../logic/usage";
import { billsNothing, providerCli } from "../../worker/keys";
import { costOf, mayHaveBilled } from "../../worker/pass";
import {
  callExtractionModel,
  ProviderError,
  scrubError,
  type ProviderResult,
} from "../../worker/providers";
import { InvalidInputError } from "./shared";

/** The output token cap sent to the provider. A summary is short prose. */
export const SUMMARY_MAX_TOKENS = 512;

/** The estimate's output side, in tokens: two to five sentences, rounded up. */
const ESTIMATED_OUTPUT_TOKENS = 300;

/** The system prompt and scaffolding, in tokens, at four characters to a token. */
const OVERHEAD_TOKENS = 250;

/**
 * What summarizing this many characters of answers will roughly cost, at list
 * prices. Sized from the answers themselves, because a summary of 25 answers
 * costs several times a summary of 3.
 *
 * Not zeroed under the mock provider mode, like the wizard's run estimate. The
 * logged cost of a mock call is zero (costOf returns 0), but the preview still
 * shows what a real summary would cost. Zeroed in subscription mode, where a
 * real summary costs nothing per call either.
 */
export function estimateSummaryCost(model: ModelRow | null, totalChars: number): number {
  if (!model || providerCli(model.provider)) return 0;
  const inputTokens = Math.ceil(totalChars / 4) + OVERHEAD_TOKENS;
  return (
    (inputTokens / 1_000_000) * Number(model.input_price_per_mtok) +
    (ESTIMATED_OUTPUT_TOKENS / 1_000_000) * Number(model.output_price_per_mtok)
  );
}

/** Injected in tests, like the setup check's probe: no network, no keys. */
export type ProseCall = (model: ModelRow, system: string, user: string) => Promise<ProviderResult>;

export interface BuyProseInput {
  db: Driver;
  /** The project's extraction model. The caller picks it. */
  model: ModelRow;
  system: string;
  user: string;
  /**
   * What the call sends, in characters (system + user): the sizing basis for
   * the worst case when a call may have billed but reported nothing.
   */
  sentChars: number;
  /** The spend log's kind: which summary was bought. */
  kind: "summary" | "prompt_summary";
  /** The run the summary belongs to, or null for the cross-run one. */
  runId: string | null;
}

export interface BoughtProse {
  /** The trimmed paragraph, never empty. An empty reply is a refusal. */
  summary: string;
  costUsd: number;
}

/**
 * What a failed call that may have billed is logged at: priced like the
 * preview from what was sent, plus the full output cap. The worker overstates
 * in the same way. Zero under the mock provider mode, like every logged cost.
 */
function worstCaseProseCost(model: ModelRow, sentChars: number): number {
  if (billsNothing(model.provider)) return 0;
  return (
    estimateSummaryCost(model, sentChars) +
    (SUMMARY_MAX_TOKENS / 1_000_000) * Number(model.output_price_per_mtok)
  );
}

/** How a missing key's ProviderError message starts. It is rethrown as an InvalidInputError a screen can show. */
const MISSING_CREDENTIAL_PREFIX = "MISSING_CREDENTIAL:";

export async function buyProse(input: BuyProseInput, call?: ProseCall): Promise<BoughtProse> {
  const { db, model, system, user, sentChars, kind, runId } = input;

  // The default call is the extraction adapter in prose mode (no JSON) with
  // the summary token cap. Key resolution and the mock provider mode live
  // there.
  const doCall: ProseCall =
    call ??
    ((m, sys, usr) =>
      callExtractionModel(m, sys, usr, { jsonMode: false, maxTokens: SUMMARY_MAX_TOKENS }));

  const logUsage = (result: ProviderResult | null, outcome: string): number => {
    const costUsd = result ? costOf(model, result) : worstCaseProseCost(model, sentChars);
    recordUsageEvent(db, {
      runId,
      runTaskId: null,
      kind,
      provider: model.provider,
      modelId: model.model_id,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      searchCalls: 0,
      costUsd,
      costEstimated: true,
      outcome,
    });
    return costUsd;
  };

  let result: ProviderResult;
  try {
    result = await doCall(model, system, user);
  } catch (error) {
    // Refused before any request was made: nothing was spent, so nothing is
    // logged. Checked before mayHaveBilled, which is true for anything that
    // is not a provider error.
    if (error instanceof InvalidInputError) throw error;
    if (error instanceof ProviderError && error.message.startsWith(MISSING_CREDENTIAL_PREFIX)) {
      const provider = error.message.slice(MISSING_CREDENTIAL_PREFIX.length);
      throw new InvalidInputError(
        "MISSING_CREDENTIAL",
        `no API key is configured for ${provider}; add it to .env and try again`,
      );
    }
    if (mayHaveBilled(error)) logUsage(null, "error");
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidInputError("SUMMARY_FAILED", scrubError(message));
  }

  const summary = result.text.trim();
  if (!summary) {
    // The call happened and returned tokens, so the spend is logged even
    // though the buyer gets a refusal.
    logUsage(result, "empty");
    throw new InvalidInputError(
      "EMPTY_SUMMARY",
      "the extraction model returned an empty summary; asking again usually works",
    );
  }

  return { summary, costUsd: logUsage(result, "success") };
}
