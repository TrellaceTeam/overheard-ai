/**
 * The Runner's money figure, pinned to the same arithmetic the wizard uses:
 * typical call sizes at catalog list prices, one extraction call per answer,
 * perception only on a first run.
 */
import { describe, expect, it } from "vitest";
import { estimateRunSpend, type PricedModelRow } from "./run-estimate";

const row = (id: string, provider: string, prices: [number, number, number]): PricedModelRow => ({
  id,
  provider,
  input_price_per_mtok: prices[0],
  output_price_per_mtok: prices[1],
  search_price_per_call: prices[2],
});

// Anthropic's typical answer: 33k in, 1.7k out, 2.9 searches (lib/onboarding).
const CLAUDE = row("claude", "anthropic", [3, 15, 0.01]);
// OpenAI's: 14k in, 950 out, 1.3 searches.
const GPT = row("gpt", "openai", [2.5, 10, 0.03]);
// A typical extraction: 1k in, 600 out, no search.
const HAIKU = row("haiku", "anthropic", [1, 5, 0]);

describe("estimateRunSpend", () => {
  it("prices every iteration of every prompt on every assistant, plus one extraction per answer", () => {
    // Claude answer: 33000/1e6*3 + 1700/1e6*15 + 2.9*0.01 = 0.1535.
    // Extraction: 1000/1e6*1 + 600/1e6*5 = 0.004. Per answer: 0.1575.
    const estimate = estimateRunSpend({
      totalIterations: 15,
      assistants: [CLAUDE],
      extractorId: "haiku",
      extractionCatalogue: [HAIKU],
      includePerception: false,
    });
    expect(estimate).toBeCloseTo(15 * 0.1575, 10);
  });

  it("sums assistants at their own provider's typical answer", () => {
    // GPT answer: 14000/1e6*2.5 + 950/1e6*10 + 1.3*0.03 = 0.0835; +0.004 extraction.
    const estimate = estimateRunSpend({
      totalIterations: 15,
      assistants: [CLAUDE, GPT],
      extractorId: "haiku",
      extractionCatalogue: [HAIKU],
      includePerception: false,
    });
    expect(estimate).toBeCloseTo(15 * (0.1575 + 0.0875), 10);
  });

  it("adds one perception answer per assistant while the next run is the first", () => {
    const withPerception = estimateRunSpend({
      totalIterations: 15,
      assistants: [CLAUDE],
      extractorId: "haiku",
      extractionCatalogue: [HAIKU],
      includePerception: true,
    });
    expect(withPerception).toBeCloseTo(16 * 0.1575, 10);
  });

  it("prices the answer side alone when the extractor is missing from the catalog", () => {
    const estimate = estimateRunSpend({
      totalIterations: 15,
      assistants: [CLAUDE],
      extractorId: "not-in-catalog",
      extractionCatalogue: [HAIKU],
      includePerception: false,
    });
    expect(estimate).toBeCloseTo(15 * 0.1535, 10);
  });

  it("is zero with no assistant selected", () => {
    expect(
      estimateRunSpend({
        totalIterations: 15,
        assistants: [],
        extractorId: "haiku",
        extractionCatalogue: [HAIKU],
        includePerception: true,
      }),
    ).toBe(0);
  });
});
