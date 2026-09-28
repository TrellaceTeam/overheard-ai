/**
 * The extraction ladder: the readers one stored answer climbs through when a
 * model replies in the wrong shape.
 *
 * Shape enforcement in the request (see extraction.ts) makes a wrong-shape
 * reply rare, not impossible, and the answer behind it came from a searching
 * call that must not be paid for twice. So the re-read happens inside the same
 * claim and the task stays `extracting`: first the same provider's next tier
 * up, then the cheapest extractor whose provider has a key. When the last rung
 * also replies in the wrong shape, the task fails on a code the failure card
 * reads as "We could not read this answer", with no fault owner. Retry on that
 * card re-queues the task, and a fresh claim walks the whole ladder again.
 *
 * Every rung is a billed call, so the pass logs each one through the hooks
 * below.
 */
import type { Driver } from "../db/driver";
import type { ModelRow } from "../db/types";
import { pickExtraction } from "@/lib/extraction-choice";
import type { Extraction } from "./extraction";
import { configuredProviders } from "./keys";
import { ProviderError, supportedProvider, type ProviderResult } from "./providers";
import { listActiveModels, listExtractionCandidates } from "./queries";

/** The catalogue's tiers, ordered for climbing. */
const TIER_ORDER: Record<ModelRow["tier"], number> = {
  extraction: 0,
  mid: 1,
  frontier: 2,
};

/**
 * The first read plus two escalations. A fourth rung would spend more money on
 * an answer three models could not read. The failure card and the user's
 * Retry handle that case.
 */
export const LADDER_MAX_RUNGS = 3;

/**
 * The same provider's next tier up: the cheapest active model on that provider
 * whose tier outranks the current reader's, or null.
 *
 * Active models only. A model the user switched off in Settings is one they do
 * not want to pay for.
 */
export function nextTierUp(preferred: ModelRow, models: readonly ModelRow[]): ModelRow | null {
  const floor = TIER_ORDER[preferred.tier];
  const higher = models.filter(
    (model) =>
      model.id !== preferred.id &&
      model.provider === preferred.provider &&
      model.is_active === 1 &&
      supportedProvider(model.provider) !== null &&
      TIER_ORDER[model.tier] > floor,
  );
  if (higher.length === 0) return null;
  higher.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      Number(a.input_price_per_mtok) - Number(b.input_price_per_mtok),
  );
  return higher[0] ?? null;
}

/**
 * The rungs, in order: the resolved extractor, the same provider's next tier
 * up, the cheapest keyed extractor. Duplicates are dropped, so a ladder can be
 * shorter than three and every rung is a reader not yet tried.
 */
export function extractionLadder(db: Driver, preferred: ModelRow | null): ModelRow[] {
  if (!preferred) return [];
  const candidates: ModelRow[] = [preferred];

  const up = nextTierUp(preferred, listActiveModels(db));
  if (up) candidates.push(up);

  const cheapest = pickExtraction(listExtractionCandidates(db), null, configuredProviders());
  if (cheapest) candidates.push(cheapest);

  const seen = new Set<string>();
  const rungs: ModelRow[] = [];
  for (const rung of candidates) {
    if (seen.has(rung.id)) continue;
    seen.add(rung.id);
    rungs.push(rung);
    if (rungs.length === LADDER_MAX_RUNGS) break;
  }
  return rungs;
}

/** How the pass buys one rung. Injected, so the walk is testable with no network. */
export type LadderCall = (model: ModelRow, system: string, user: string) => Promise<ProviderResult>;

export interface LadderHooks {
  /**
   * A rung answered in the wrong shape. Called with the reply that was thrown
   * away, before the next rung is bought, because that reply was still billed.
   */
  onViolation?: ((model: ModelRow, result: ProviderResult) => void) | undefined;
  /** A rung's call itself failed. Called before the error propagates out. */
  onCallError?: ((model: ModelRow, error: unknown) => void) | undefined;
}

export interface LadderOutcome {
  extraction: Extraction;
  /** The rung that read the answer. The extractions row names this model. */
  model: ModelRow;
  /** The winning call's own report, for the usage row. */
  result: ProviderResult;
}

/**
 * The stored failure code when the last rung also violated. Classified by
 * lib/failure-reasons into the chip-less "We could not read this answer" card.
 */
export const UNREADABLE_PREFIX = "EXTRACTION_UNREADABLE";

/**
 * Walks the rungs until one parses. A provider error (429, timeout, a hard
 * 4xx) is not a shape violation. It propagates at once, after the onCallError
 * hook, and the task's normal retry budget applies. The ladder is for models
 * that answered in the wrong shape.
 *
 * Running out of rungs raises a non-retryable ProviderError, so the task fails
 * instead of buying the whole ladder again automatically.
 *
 * Precondition: `rungs` is non-empty. The pass resolves the extractor, and
 * fails the task with NO_EXTRACTION_CREDENTIAL, before walking.
 */
export async function walkExtractionLadder(
  rungs: readonly ModelRow[],
  system: string,
  user: string,
  call: LadderCall,
  parse: (raw: string) => Extraction,
  hooks: LadderHooks = {},
): Promise<LadderOutcome> {
  let lastViolation: unknown = null;
  for (const model of rungs) {
    let result: ProviderResult;
    try {
      result = await call(model, system, user);
    } catch (error) {
      hooks.onCallError?.(model, error);
      throw error;
    }
    try {
      return { extraction: parse(result.text), model, result };
    } catch (violation) {
      lastViolation = violation;
      hooks.onViolation?.(model, result);
    }
  }
  const detail = lastViolation instanceof Error ? lastViolation.message : String(lastViolation);
  throw new ProviderError(
    `${UNREADABLE_PREFIX}: ${rungs.length} ${rungs.length === 1 ? "reader" : "readers"} replied in the wrong shape (last: ${detail})`,
    400,
    "EXTRACTION_UNREADABLE",
  );
}
