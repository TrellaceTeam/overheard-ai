/**
 * What the next run of an existing project will cost, in USD at list prices.
 *
 * The wizard's estimateWizardSpend prices a project that does not exist yet
 * from drafts. This prices the project's selected assistants and its chosen
 * extractor, looked up in the seeded catalogue, with the same arithmetic
 * (typical call sizes, list prices, one extraction per answer), so the Runner
 * on the Prompts tab and the wizard quote the same money for the same shape of
 * run. Always an estimate: the run screen logs real spend per answer as it
 * lands.
 */
import { estimateWizardSpend, type ModelPrices } from "./onboarding";

/** The catalogue columns an estimate reads, as the models table stores them. */
export interface PricedModelRow {
  id: string;
  provider: string;
  input_price_per_mtok: number | string;
  output_price_per_mtok: number | string;
  search_price_per_call: number | string;
}

export function modelPrices(row: PricedModelRow): ModelPrices {
  return {
    provider: row.provider,
    inputPerMtok: Number(row.input_price_per_mtok),
    outputPerMtok: Number(row.output_price_per_mtok),
    searchPerCall: Number(row.search_price_per_call),
  };
}

/**
 * The estimated cost of the next run.
 *
 * `extractorId` is the project's extraction model. An extractor that is not in
 * the extraction catalogue prices as no extractor at all: the answer side
 * alone is still a useful number, and the run screen's real logging is the
 * authority either way.
 */
export function estimateRunSpend(input: {
  /** Sum of the iterations of every active, unarchived prompt. */
  totalIterations: number;
  /** The project's selected assistants, as catalogue rows. */
  assistants: readonly PricedModelRow[];
  /** The project's extraction model id, and the catalogue to price it from. */
  extractorId: string | null;
  extractionCatalogue: readonly PricedModelRow[];
  /** True while the next run is the project's first and also asks perception. */
  includePerception: boolean;
}): number {
  const extractor =
    input.extractorId === null
      ? null
      : (input.extractionCatalogue.find((row) => row.id === input.extractorId) ?? null);
  return estimateWizardSpend({
    totalIterations: input.totalIterations,
    assistants: input.assistants.map(modelPrices),
    extractor: extractor ? modelPrices(extractor) : null,
    includePerception: input.includePerception,
  });
}
