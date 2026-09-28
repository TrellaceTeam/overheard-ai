/**
 * Test seam. Not a provider, not a fallback, and never the default.
 *
 * With OVERHEARD_MOCK_PROVIDERS=1, callProvider returns canned answers and
 * canned extractor JSON instead of making an HTTP request. The whole flow,
 * from creating a run to finalised metrics and a perception band, then runs
 * in a test or a demo with no provider key and no spend. Every result is
 * deterministic, costs nothing, and takes about 50 ms so progress is visible.
 *
 * The default brands are fictional and the default link is on example.com.
 * Nothing here talks to a network.
 */
import { STARTER_GENERATION_SYSTEM } from "@/lib/starter-generation";
import { PERCEPTION_SYNTHESIS_SYSTEM, PERCEPTION_SYSTEM } from "./perception-extract";
import type { Provider } from "../db/types";
import type { ProviderResult } from "./providers";

/** Read at call time, so a test can set and unset it. */
export function mockProvidersEnabled(): boolean {
  return process.env["OVERHEARD_MOCK_PROVIDERS"] === "1";
}

/** Enough delay that a run looks like it is working, short enough for a test. */
export const MOCK_LATENCY_MS = 50;

/** Fictional brands, in the ranked order the canned answer presents them. */
export const MOCK_BRANDS: readonly string[] = [
  "Acme Analytics",
  "Northwind Metrics",
  "Contoso Insights",
];

/**
 * Two brands the canned answer names that a project does not track, so
 * competitor discovery and the promote button have something to show after a
 * mock run.
 */
export const MOCK_DISCOVERED_BRANDS: readonly string[] = ["Fabrikam Labs", "Globex Search"];

/** Used when the project has no domain of its own to cite. */
export const MOCK_CITATION = "https://acme-analytics.example.com";

/**
 * The canned answer's link: the project's own domain when it has one, so the
 * link can count as a citation and the mock citation rate is not stuck at zero.
 */
export function mockCitationUrl(domain?: string | null | undefined): string {
  const trimmed = (domain ?? "").trim().toLowerCase();
  return trimmed === "" ? MOCK_CITATION : `https://${trimmed}`;
}

/** Case-insensitive membership, so a tracked brand is not named twice. */
function alreadyNamed(names: readonly string[], candidate: string): boolean {
  const key = candidate.trim().toLocaleLowerCase();
  return names.some((name) => name.trim().toLocaleLowerCase() === key);
}

/**
 * The canned answer. A ranked list with a link on the first brand, so
 * extraction has a position, a total and one citation to find, followed by
 * brands the project does not track so discovery has something to find.
 */
export function mockAnswerText(
  brands: readonly string[] = MOCK_BRANDS,
  citation: string = MOCK_CITATION,
): string {
  const tracked = brands.length > 0 ? brands : MOCK_BRANDS;
  const named = [...tracked];
  for (const extra of MOCK_DISCOVERED_BRANDS) {
    if (!alreadyNamed(named, extra)) named.push(extra);
  }
  const lines = named.map((name, index) => {
    const link = index === 0 ? ` See ${citation} for their own summary.` : "";
    return `${index + 1}. ${name} is a reasonable choice for this.${link}`;
  });
  return [
    "Here are the options worth considering, best first.",
    "",
    ...lines,
    "",
    "This is mock output from Overheard AI's offline provider seam, not a real answer.",
  ].join("\n");
}

/**
 * Extractor JSON matching whatever mockAnswerText produced. It is parsed back
 * off the answer, so an answer seeded with a project's own brand names
 * extracts to those names and to the link it carried. Only mockAnswerText's
 * line shape is recognised.
 */
export function mockExtractionJson(answerText: string): string {
  const brands: Array<Record<string, unknown>> = [];
  for (const line of answerText.split("\n")) {
    const match = /^(\d+)\. (.+?) is a reasonable choice for this\./.exec(line.trim());
    if (!match) continue;
    const position = Number(match[1]);
    const name = match[2] ?? "";
    const link = /See (\S+) for their own summary\./.exec(line);
    brands.push({
      name,
      position,
      mention_type: "ranked",
      linked_url: link?.[1] ?? null,
      evidence: `${name} is a reasonable choice for this.`,
    });
  }
  return JSON.stringify({
    answer_format: brands.length > 0 ? "ranked_list" : "prose",
    total_items: brands.length,
    brands,
  });
}

/** Perception JSON, in the four sections, with nothing graded or scored. */
export function mockPerceptionJson(): string {
  return JSON.stringify({
    knows_brand: true,
    what_it_does: "Tracks how often a brand is named in AI assistant answers.",
    typical_customers: "Small marketing teams running their own measurement.",
    well_regarded_for: "Running entirely on the user's own machine and keys.",
    downsides: "Mock output, so nothing here was observed anywhere.",
  });
}

/**
 * The generated starter prompts, as the generation call's enforced shape: the
 * same five for the same brand and category, and within the contract, so the
 * setup screen's generate button works with no key. The brand and category
 * are read back off the call's labelled lines (starterGenerationUserPrompt).
 */
export function mockStarterPromptsJson(user: string): string {
  const line = (label: string) => new RegExp(`^${label}: (.*)$`, "m").exec(user)?.[1]?.trim();
  const brand = line("Brand") || "Acme Analytics";
  const given = line("Category");
  const category = given && given !== "not given" ? given : "analytics software";
  return JSON.stringify({
    visibility_1: `Which options for ${category} do small teams recommend this year?`,
    visibility_2: `What should a first-time buyer shortlist when choosing ${category}?`,
    visibility_3: `Which options for ${category} give the best value on a small budget?`,
    comparison: `How do the leading options for ${category} compare on price and support?`,
    comparison_naming_brand: `Are there better alternatives than ${brand} for ${category}?`,
  });
}

export interface MockCallInput {
  provider: Provider;
  modelId: string;
  system: string;
  user: string;
  jsonMode: boolean;
  /** The project's brand names, so a canned answer names real project brands. */
  brands?: readonly string[] | undefined;
  /** The first brand's domain, so the answer's link can count as a citation. */
  citationDomain?: string | null | undefined;
}

function usage(text: string): Omit<ProviderResult, "text"> {
  // About four characters per token, and stable because the text is. The
  // tokens are counted, but costOf in pass.ts prices a mock call at zero.
  const outputTokens = Math.ceil(text.length / 4);
  return {
    inputTokens: 0,
    outputTokens,
    tokens: outputTokens,
    searchCalls: 0,
    stopReason: "end_turn",
  };
}

/**
 * The mock adapter. It picks the contract to answer from the call's shape, so
 * a caller never says which phase it is in. Perception and starter prompt
 * generation are recognised by their fixed system prompts. Extraction is any
 * other JSON-mode call, since its system prompt is a per-project setting.
 * Everything else is an answer.
 */
export async function mockCallProvider(input: MockCallInput): Promise<ProviderResult> {
  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));

  if (input.system === PERCEPTION_SYSTEM || input.system === PERCEPTION_SYNTHESIS_SYSTEM) {
    const text = mockPerceptionJson();
    return { text, ...usage(text) };
  }

  if (input.system === STARTER_GENERATION_SYSTEM) {
    const text = mockStarterPromptsJson(input.user);
    return { text, ...usage(text) };
  }

  if (input.jsonMode) {
    const text = mockExtractionJson(input.user);
    return { text, ...usage(text) };
  }

  const text = mockAnswerText(input.brands, mockCitationUrl(input.citationDomain));
  // The worker rejects an answer that shows no completed search, so the canned
  // answer reports one. costOf prices mock calls at nothing.
  return { text, ...usage(text), searchCalls: 1 };
}
