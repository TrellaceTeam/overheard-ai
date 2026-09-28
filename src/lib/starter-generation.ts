/**
 * Starter prompt generation: one call on the user's own key that rewrites the
 * five generic starter prompts to fit the brand, before the project exists.
 *
 * Everything here is pure and client-safe, so the setup screen prices the
 * button, and the server makes and checks the call, from one set of rules:
 * which model is called, what it is sent, the shape its reply is enforced to,
 * the contract the five have to meet, and what the button says. The call
 * itself lives in src/server/api/ops/starter-prompts.ts.
 */
import { normalizeName } from "./brand-matching";
import { pickExtraction } from "./extraction-choice";
import { money } from "./money";
import {
  DEFAULT_WIZARD_ITERATIONS,
  normalizeDescription,
  type PromptOrigin,
  type StarterPrompt,
} from "./onboarding";
import { isSelfReferenced } from "./selfReference";

/* ------------------------------------------------------------ the model rule */

/** The catalogue columns the model rule reads, as the models table stores them. */
export interface GenerationCandidate {
  id: string;
  provider: string;
  tier: string;
  is_active: number;
  superseded?: number;
  input_price_per_mtok: number | string;
  output_price_per_mtok: number | string;
}

/** The break for an exact price tie, from the spec: OpenAI, then Anthropic, then Google. */
const TIE_ORDER = ["openai", "anthropic", "google"];

function tieRank(provider: string): number {
  const rank = TIE_ORDER.indexOf(provider);
  return rank === -1 ? TIE_ORDER.length : rank;
}

/**
 * The model the generation call goes to: the cheapest active, current mid-tier
 * model of a keyed provider, by input price, then output price, then provider.
 * A superseded model can cost the same as its replacement. With
 * no such model, the shared extraction rule instead of a refusal: the
 * preferred extractor when it is keyed, else the cheapest keyed extractor.
 * Null only when no keyed provider has any active model to call.
 *
 * `catalogue` and `extractionModels` are the two lists the setup screen reads
 * (listModels and listExtractionModels), and the server passes the same two,
 * so the price on the button is the price of the model that is called.
 */
export function pickGenerationModel<T extends GenerationCandidate>(
  catalogue: readonly T[],
  extractionModels: readonly T[],
  keyedProviders: readonly string[],
  preferredExtractor: T | null = null,
): T | null {
  const keyed = new Set(keyedProviders);
  const seen = new Set<string>();
  const mid = [...catalogue, ...extractionModels].filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return (
      model.tier === "mid" &&
      model.is_active === 1 &&
      model.superseded !== 1 &&
      keyed.has(model.provider)
    );
  });
  if (mid.length > 0) {
    mid.sort(
      (a, b) =>
        Number(a.input_price_per_mtok) - Number(b.input_price_per_mtok) ||
        Number(a.output_price_per_mtok) - Number(b.output_price_per_mtok) ||
        tieRank(a.provider) - tieRank(b.provider),
    );
    return mid[0] ?? null;
  }
  return pickExtraction(extractionModels, preferredExtractor, keyedProviders);
}

/* ------------------------------------------------------------- the request */

/** What the setup screen knows about the brand when the button is pressed. */
export interface StarterRequest {
  brandName: string;
  category: string;
  /** The brand description, possibly empty. */
  description: string;
  variants: readonly string[];
  competitors: readonly string[];
}

/**
 * The fixed instructions. The mock provider seam recognises the generation
 * call by this exact text, so it is never built from parts.
 */
export const STARTER_GENERATION_SYSTEM = `You write the questions a buyer types into an AI assistant while choosing a product or a service. An app asks these questions of several assistants and counts how often each brand is named in the answers, so every question has to read as if a real buyer wrote it.

You are given the brand's name and other names, its category and its competitors, and often one sentence on what it does, for whom and where. Return exactly five questions, one in each field:

- visibility_1, visibility_2 and visibility_3: questions a buyer asks while looking for options. They name no brand at all, because they test whether assistants bring the brand up unprompted.
- comparison: a question a buyer asks while weighing options against each other. It does not name the brand or any of its other names.
- comparison_naming_brand: a question that names the brand and asks for alternatives to it, for example "Are there better alternatives than [brand] for [use]?".

Make every question specific to what the brand does: its audience, its place and its use case. A business that serves one city gets questions about that city, and a product for one kind of team gets questions that team would ask. A question that specific cannot be answered from general knowledge alone, which is the point. Never write a question you cannot make specific; write a different one that you can. With no sentence on what the brand does, work from the category and the competitors, and plainer questions are acceptable.

Write each question the way a buyer would type it: plain words, one or two sentences, ending with a question mark. Rephrase the category into natural words rather than pasting it in, so every question is grammatical. Never tell the assistant how to answer: no instructions to search, to browse, to cite sources or to format the reply. Do not invent facts about the brand, a place or a price that the details do not give.

Return only the five fields.`;

function listed(items: readonly string[]): string {
  const kept = items.map((item) => item.trim()).filter((item) => item !== "");
  return kept.length > 0 ? kept.join(", ") : "none given";
}

/** The user message: one labelled line per fact, an empty one said as such. */
export function starterGenerationUserPrompt(request: StarterRequest): string {
  return [
    `Brand: ${request.brandName.trim()}`,
    `Other names for the brand: ${listed(request.variants)}`,
    `Category: ${request.category.trim() || "not given"}`,
    `What the brand does, for whom and where: ${normalizeDescription(request.description) || "not given"}`,
    `Competitors: ${listed(request.competitors)}`,
  ].join("\n");
}

/** What one generation call sends, in characters: the sizing basis for its price. */
export function starterGenerationChars(request: StarterRequest): number {
  return STARTER_GENERATION_SYSTEM.length + starterGenerationUserPrompt(request).length;
}

/* ---------------------------------------------------------- the enforced shape */

/**
 * The five fields, in the order the list shows them: visibility first, then
 * comparison, as the templates are. The last one names the brand, so it is
 * self-referenced and never counts (ADR 0005): four counted, one not, the
 * same split as the templates.
 */
const STARTER_FIELDS = [
  { key: "visibility_1", tag: "visibility", namesBrand: false },
  { key: "visibility_2", tag: "visibility", namesBrand: false },
  { key: "visibility_3", tag: "visibility", namesBrand: false },
  { key: "comparison", tag: "comparison", namesBrand: false },
  { key: "comparison_naming_brand", tag: "comparison", namesBrand: true },
] as const;

/**
 * The reply's shape, sent in the request and enforced the provider's own way,
 * as extraction's is (worker/extraction.ts). Five named string fields rather
 * than an array, so the count and the tags are the shape itself and no
 * provider has to honour an array length keyword.
 */
export const STARTER_PROMPTS_SHAPE = {
  name: "starter_prompts",
  description: "Return the five questions as this tool's input, with no other output.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: STARTER_FIELDS.map((field) => field.key),
    properties: Object.fromEntries(STARTER_FIELDS.map((field) => [field.key, { type: "string" }])),
  },
};

/* ------------------------------------------------------------- the contract */

/** Bounds on one generated question. Two plain sentences fit well inside the upper one. */
const MIN_QUESTION_CHARS = 10;
const MAX_QUESTION_CHARS = 300;

/**
 * Phrasing addressed to the assistant rather than asked by a buyer. Search is
 * forced on the wire at call time, never in stored text, so a question that
 * carries it is refused.
 */
const INSTRUCTION =
  /\b(?:you must|please (?:search|browse|look up|cite)|search (?:the web|the internet|online|google)|use (?:the )?(?:web|google|internet) search|look (?:it|this|them) up online|cite (?:your |the )?sources|include (?:links|urls|sources|citations)|(?:answer|respond|reply) in json)\b/i;

/**
 * Whether a question names the brand: the self-reference rule the statistics
 * use, plus the plain name as a word, which that rule skips below three
 * characters.
 */
function namesBrand(text: string, brand: { name: string; variants: readonly string[] }): boolean {
  if (isSelfReferenced(text, { name: brand.name, variants: [...brand.variants] })) return true;
  const name = normalizeName(brand.name);
  return name !== "" && ` ${normalizeName(text)} `.includes(` ${name} `);
}

/**
 * The generated set, checked against the contract: all five fields, each a
 * natural question with no instructions in it, the first four not naming the
 * brand and the last one naming it, no two alike. Throws a SHAPE_VIOLATION
 * naming the first break, which the server answers with its one retry.
 */
export function parseStarterPrompts(
  raw: string,
  brand: { name: string; variants: readonly string[] },
): StarterPrompt[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("SHAPE_VIOLATION: no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("SHAPE_VIOLATION: not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SHAPE_VIOLATION: not a JSON object");
  }
  const record = parsed as Record<string, unknown>;

  const seen = new Set<string>();
  return STARTER_FIELDS.map((field) => {
    const value = record[field.key];
    if (typeof value !== "string") throw new Error(`SHAPE_VIOLATION: ${field.key} is missing`);
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length < MIN_QUESTION_CHARS || text.length > MAX_QUESTION_CHARS) {
      throw new Error(`SHAPE_VIOLATION: ${field.key} is ${text.length} characters`);
    }
    if (!text.endsWith("?")) throw new Error(`SHAPE_VIOLATION: ${field.key} is not a question`);
    if (INSTRUCTION.test(text)) {
      throw new Error(`SHAPE_VIOLATION: ${field.key} instructs the assistant`);
    }
    if (namesBrand(text, brand) !== field.namesBrand) {
      throw new Error(
        `SHAPE_VIOLATION: ${field.key} ${field.namesBrand ? "does not name" : "names"} the brand`,
      );
    }
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`SHAPE_VIOLATION: ${field.key} repeats another question`);
    seen.add(key);
    return { text, tag: field.tag, iterations: DEFAULT_WIZARD_ITERATIONS };
  });
}

/* ------------------------------------------------------------------ spend */

/**
 * The reply's size in the estimate, in tokens: five short questions as JSON,
 * plus room for a mid-tier model's reasoning, which is billed as output.
 */
const ESTIMATED_OUTPUT_TOKENS = 1_000;

/**
 * What one generation call will roughly cost at list prices, at the model
 * that will be called, sized from what it sends. Priced like the summary
 * buttons (estimateSummaryCost), and not zeroed under the mock provider mode.
 */
export function estimateGenerationCost(
  model: Pick<GenerationCandidate, "input_price_per_mtok" | "output_price_per_mtok"> | null,
  sentChars: number,
): number {
  if (!model) return 0;
  const inputTokens = Math.ceil(sentChars / 4);
  return (
    (inputTokens / 1_000_000) * Number(model.input_price_per_mtok) +
    (ESTIMATED_OUTPUT_TOKENS / 1_000_000) * Number(model.output_price_per_mtok)
  );
}

/* ------------------------------------------------------------- the button */

/**
 * The line under the prompt library that names the three doors. It says
 * "these prompts", not a count: the tutorial's list has four, and a user can
 * add or remove rows before reading it.
 */
export const THREE_DOORS_LINE =
  "These prompts are a starting point. Keep them, edit them by hand, or generate a set tailored to your brand on your own keys.";

/** Under the button when there is no key to call a model with. */
export const NO_KEY_HINT = "Needs a provider key. Add one in Account settings.";

/** On the button once the list is edited by hand. */
export const EDITED_HINT = "You edited these prompts, so they stay as you wrote them.";

/**
 * The generate button's state:
 * - `armed`: the list is the templates, untouched, and a model can be called;
 * - `generating`: the call is out;
 * - `generated`: the list is a generated set, untouched, so this input set's
 *   one shot is spent;
 * - `no-key`: no keyed provider has a model to call;
 * - `edited`: the list is the user's own, which a generated set would replace.
 * Only `armed` can be pressed.
 */
export type GenerateState = "armed" | "generating" | "generated" | "no-key" | "edited";

export function generateState(input: {
  generating: boolean;
  hasModel: boolean;
  untouched: boolean;
  source: PromptOrigin["source"] | null;
}): GenerateState {
  if (input.generating) return "generating";
  if (!input.hasModel) return "no-key";
  if (!input.untouched) return "edited";
  if (input.source === "generated") return "generated";
  if (input.source === "template") return "armed";
  return "edited";
}

/** What the button reads in each state. The rough cost carries no model name. */
export function generateButtonLabel(state: GenerateState, costUsd: number): string {
  switch (state) {
    case "generating":
      return "Generating…";
    case "generated":
      return "Prompts generated";
    case "no-key":
      return "Generate custom prompts";
    case "armed":
    case "edited":
      return `Generate custom prompts ~ ${money(costUsd)} on your key`;
  }
}

/**
 * The toast for a failed generation: the server's reason, then what did not
 * happen. Toasts end without a period.
 */
export function generationFailedToast(reason: string): string {
  const sentence = reason.trim();
  const closed = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  return `${closed} Your prompts are unchanged`;
}
