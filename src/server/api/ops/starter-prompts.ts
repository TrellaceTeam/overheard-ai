/**
 * Generating starter prompts: one call on the user's own key that rewrites the
 * five generic starter prompts to fit the brand, from the setup screen, before
 * the project exists.
 *
 * The rules this module owns:
 * - the model is picked by the rule in lib/starter-generation, from the two
 *   catalogue lists the setup screen priced the button from;
 * - the reply rides the enforced-JSON mechanism with its own shape, and the
 *   set is checked against the contract here, whatever the provider enforced;
 * - a reply that breaks the shape or the contract gets one retry inside the
 *   call, and there is no ladder: the ladder heals a stored answer by
 *   re-reading it, and a generation has nothing stored to re-read;
 * - every call that may have billed is logged at list prices under its own
 *   kind, with no run and so no project, because neither exists yet;
 * - a failure is refused with a sentence that names the reason, for the
 *   setup screen's toast.
 *
 * The call goes through the worker's provider layer, so the mock provider mode
 * covers it and no key passes through this module.
 */
import type { Driver } from "../../db/driver";
import type { ModelRow } from "../../db/types";
import { recordUsageEvent } from "../../logic/usage";
import { mockProvidersEnabled } from "../../worker/mock-provider";
import { costOf, mayHaveBilled } from "../../worker/pass";
import {
  callExtractionModel,
  ProviderError,
  scrubError,
  supportedProvider,
  type ProviderResult,
} from "../../worker/providers";
import { classifySearchFailure } from "@/lib/setup-check";
import type { StarterPrompt } from "@/lib/onboarding";
import {
  NO_KEY_HINT,
  parseStarterPrompts,
  pickGenerationModel,
  STARTER_GENERATION_SYSTEM,
  STARTER_PROMPTS_SHAPE,
  starterGenerationChars,
  starterGenerationUserPrompt,
  type StarterRequest,
} from "@/lib/starter-generation";
import { listExtractionModels, listModels } from "./models";
import { InvalidInputError } from "./shared";

/**
 * The output cap sent to the provider. Five questions need a few hundred
 * tokens, and a mid-tier model's reasoning spends the same allowance, so a
 * tight cap would cut the reply off before the JSON.
 */
export const GENERATION_MAX_TOKENS = 4096;

/** A person is waiting on the button, so a hung call gives up well inside a run call's budget. */
export const GENERATION_TIMEOUT_MS = 60_000;

/** Calls per press: the first, and one retry on a reply that breaks the shape or the contract. */
const MAX_ATTEMPTS = 2;

/** Injected in tests, like the summaries' call: no network, no keys. */
export type GenerationCall = (
  model: ModelRow,
  system: string,
  user: string,
) => Promise<ProviderResult>;

export interface GenerateStarterPromptsOptions {
  /** Providers with a key in this process's environment, for the model rule. */
  providersWithKeys: readonly string[];
  call?: GenerationCall | undefined;
}

export interface GeneratedStarterPrompts {
  /** The five, tagged and at the default iterations, in the order the list shows them. */
  prompts: StarterPrompt[];
  /** What this press cost at list prices, the retry included. Zero under the mock provider mode. */
  costUsd: number;
}

/** The reason when both replies broke the shape or the contract. */
export const UNUSABLE_REPLY_REASON =
  "The model replied twice in a shape we could not use. Trying again usually works.";

/** The reason for a refusal the setup check's wording does not fit. */
const UNCLASSIFIED_REASON = "The provider refused the call in a way we could not classify.";

/**
 * The setup check's verdicts whose sentence reads true for a call with no
 * search in it. The others speak of search or of a check, and fall back to
 * the unclassified reason.
 */
const REASONS_THAT_FIT = new Set([
  "invalid_key",
  "no_credits",
  "rate_limited",
  "provider_unavailable",
  "model_unavailable",
  "region_unsupported",
]);

/**
 * A failed call's reason, in the setup check's words where they fit: a
 * rejected key, no credit, a rate limit, a provider down or unreachable, and a
 * model the account cannot use, which is also how a retired model id answers.
 */
export function generationFailureReason(provider: string, error: unknown): string {
  if (error instanceof ProviderError && error.code.startsWith("MISSING_CREDENTIAL")) {
    return NO_KEY_HINT;
  }
  const known = supportedProvider(provider);
  if (!(error instanceof ProviderError) || known === null) return UNCLASSIFIED_REASON;
  const verdict = classifySearchFailure(known, error.status, scrubError(error.message));
  return REASONS_THAT_FIT.has(verdict.status) ? verdict.message : UNCLASSIFIED_REASON;
}

/**
 * What a failed call that may have billed is logged at: what was sent, plus
 * the full output cap. Zero under the mock provider mode, like every logged
 * cost.
 */
function worstCaseGenerationCost(model: ModelRow, sentChars: number): number {
  if (mockProvidersEnabled()) return 0;
  return (
    (Math.ceil(sentChars / 4) / 1_000_000) * Number(model.input_price_per_mtok) +
    (GENERATION_MAX_TOKENS / 1_000_000) * Number(model.output_price_per_mtok)
  );
}

/** The usage a rejected response reported, when it reported any: it beats a worst case. */
function reportedUsage(error: unknown): ProviderResult | null {
  if (!(error instanceof ProviderError) || !error.usage) return null;
  const usage = error.usage;
  const any = (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0;
  return any ? { text: "", tokens: null, ...usage } : null;
}

/**
 * Generate the five for the brand the setup screen describes. Returns them
 * with what the press cost. Refuses with NO_BRAND before anything is sent,
 * NO_PROVIDER_KEY when no keyed provider has a model to call, and
 * GENERATION_FAILED with the reason when the call fails or both replies are
 * unusable.
 */
export async function generateStarterPrompts(
  db: Driver,
  request: StarterRequest,
  options: GenerateStarterPromptsOptions,
): Promise<GeneratedStarterPrompts> {
  const brandName = request.brandName.trim();
  if (brandName === "") throw new InvalidInputError("NO_BRAND", "give the brand a name");

  const model = pickGenerationModel(
    listModels(db),
    listExtractionModels(db),
    options.providersWithKeys,
  );
  if (!model) throw new InvalidInputError("NO_PROVIDER_KEY", NO_KEY_HINT);

  const doCall: GenerationCall =
    options.call ??
    ((m, system, user) =>
      callExtractionModel(m, system, user, {
        jsonSchema: STARTER_PROMPTS_SHAPE,
        maxTokens: GENERATION_MAX_TOKENS,
        timeoutMs: GENERATION_TIMEOUT_MS,
      }));

  const user = starterGenerationUserPrompt(request);
  const sentChars = starterGenerationChars(request);
  let spent = 0;

  const logUsage = (result: ProviderResult | null, outcome: string): void => {
    const costUsd = result ? costOf(model, result) : worstCaseGenerationCost(model, sentChars);
    spent += costUsd;
    recordUsageEvent(db, {
      runId: null,
      runTaskId: null,
      kind: "prompt_generation",
      provider: model.provider,
      modelId: model.model_id,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      searchCalls: 0,
      costUsd,
      costEstimated: true,
      outcome,
    });
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let result: ProviderResult;
    try {
      result = await doCall(model, STARTER_GENERATION_SYSTEM, user);
    } catch (error) {
      // A provider error is not a shape violation: it fails the press at
      // once, with the list left as it was.
      const reported = reportedUsage(error);
      if (reported || mayHaveBilled(error)) logUsage(reported, "error");
      throw new InvalidInputError(
        "GENERATION_FAILED",
        generationFailureReason(model.provider, error),
      );
    }
    try {
      const prompts = parseStarterPrompts(result.text, {
        name: brandName,
        variants: request.variants,
      });
      logUsage(result, "success");
      return { prompts, costUsd: spent };
    } catch {
      // The discarded reply was still billed.
      logUsage(result, attempt < MAX_ATTEMPTS ? "retried" : "failed");
    }
  }
  throw new InvalidInputError("GENERATION_FAILED", UNUSABLE_REPLY_REASON);
}
