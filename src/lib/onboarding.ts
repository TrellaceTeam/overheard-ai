// Pure logic behind the onboarding flow, kept out of the route component so the
// starter prompts and their reset rule, the extractor choice and the
// setup-check gate can be unit-tested in node with no browser and no database.
// The project-creation transaction lives in src/server/api/ops/projects.ts, and
// starter prompt generation in ./starter-generation.

import { pickExtraction } from "./extraction-choice";
import { PERCEPTION_TEMPLATE, resolvePerceptionPrompt } from "./perception";
import { allRowsPassed, type SearchCheckStatus } from "./setup-check";

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** A starter prompt, the tag it is seeded under, and how often it is asked per run. */
export type StarterPrompt = { text: string; tag: string | null; iterations: number };

/**
 * How often each starter prompt is asked per run, and the bounds the wizard
 * and the create operation both enforce. Three keeps a first run's spend down
 * while a brand named in 2 of 3 answers is still a signal. Every prompt's count
 * is editable in the wizard.
 */
export const DEFAULT_WIZARD_ITERATIONS = 3;
export const MIN_WIZARD_ITERATIONS = 1;
export const MAX_WIZARD_ITERATIONS = 20;

/**
 * What the iterations box accepts: free typing clamped to the create
 * operation's range as it lands, so the wizard never submits a number the
 * server would refuse, and the estimate on screen is the number that is stored.
 */
export function clampIterations(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_WIZARD_ITERATIONS;
  return Math.min(MAX_WIZARD_ITERATIONS, Math.max(MIN_WIZARD_ITERATIONS, parsed));
}

/**
 * Industry-neutral starter prompts, tailored to the brand and category.
 *
 * Seeded under two tags so a new project opens with its prompts already
 * grouped. The tags are labels only: no code branches on their value, and a
 * user can move any prompt to another tag. The server refuses to leave a
 * prompt with no tag.
 *
 * Text and tag travel together, not as two index-aligned arrays, because the
 * onboarding editor rewrites the text in place.
 */
export function starterPrompts(brand: string, category: string): StarterPrompt[] {
  // The fallback is a singular noun because every template either follows it
  // with "options" or asks "which {c} would you recommend". The wizard
  // requires a category, so this is a floor, not a normal path.
  const c = category.trim() || "product";
  // "options" and "comparing" keep the sentences grammatical whatever the
  // category is. It is free text, so it arrives singular ("CRM"), plural
  // ("CRMs") or uncountable ("analytics software"), and these sentences are
  // sent to paid assistants and measured.
  // Visibility first, then comparison: whether assistants name the brand at
  // all is what a new project most needs answered.
  const iterations = DEFAULT_WIZARD_ITERATIONS;
  return [
    { text: `What are the best options for ${c}?`, tag: "visibility", iterations },
    { text: `Which ${c} would you recommend, and why?`, tag: "visibility", iterations },
    {
      text: `What are the best options for ${c} on a tight budget?`,
      tag: "visibility",
      iterations,
    },
    {
      text: `What should I consider when comparing options for ${c}?`,
      tag: "comparison",
      iterations,
    },
    {
      text: `Is ${brand} a good option? What are the main alternatives?`,
      tag: "comparison",
      iterations,
    },
  ];
}

/* ------------------------------------------------------- brand description */

/**
 * The longest brand description the setup screen accepts. The projects CHECK
 * in migration 0011 holds the same number.
 */
export const DESCRIPTION_MAX_CHARS = 280;

/**
 * The description as it is stored and sent: one sentence, so line breaks and
 * runs of spaces collapse to single spaces, and the ends are trimmed.
 */
export function normalizeDescription(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/* ---------------------------------------------------------- the reset rule */

/** What starter prompts are written from. A change to any of them can reset an untouched list. */
export interface StarterInputs {
  brand: string;
  category: string;
  description: string;
}

/** The inputs as they are compared: trimmed, with the description normalised. */
export function starterInputs(brand: string, category: string, description: string): StarterInputs {
  return {
    brand: brand.trim(),
    category: category.trim(),
    description: normalizeDescription(description),
  };
}

/**
 * What wrote the list the setup screen shows, and for which inputs:
 * the generic templates, a generated set, or the tutorial's prefill.
 */
export interface PromptOrigin {
  source: "template" | "generated" | "prefill";
  inputs: StarterInputs;
  prompts: readonly StarterPrompt[];
}

function sameInputs(a: StarterInputs, b: StarterInputs): boolean {
  return a.brand === b.brand && a.category === b.category && a.description === b.description;
}

/**
 * Whether the list still equals whatever wrote it, row for row: text, tag and
 * iterations. Any edit, addition or removal makes it the user's. An edit put
 * back exactly as it was makes it untouched again, because nothing is lost by
 * treating it so.
 */
export function listUntouched(
  current: readonly StarterPrompt[],
  origin: PromptOrigin | null,
): boolean {
  if (origin === null || current.length !== origin.prompts.length) return false;
  return current.every((prompt, index) => {
    const written = origin.prompts[index];
    return (
      written !== undefined &&
      prompt.text === written.text &&
      prompt.tag === written.tag &&
      prompt.iterations === written.iterations
    );
  });
}

/**
 * The reset rule, applied when the user leaves the brand step for the prompts:
 * the list to show instead, or null to keep the one there.
 *
 * - A list nothing has written yet gets the templates.
 * - Unchanged inputs keep the list, whoever wrote it.
 * - Changed inputs and a list that still equals what wrote it, templates or a
 *   generated set: the templates for the new inputs, which re-arms the
 *   generate button.
 * - Changed inputs and a list edited by hand: kept. The user took the manual
 *   door, and the reset only ever discards text nobody touched.
 */
export function promptReset(
  current: readonly StarterPrompt[],
  origin: PromptOrigin | null,
  inputs: StarterInputs,
): { prompts: StarterPrompt[]; origin: PromptOrigin } | null {
  if (origin !== null) {
    if (sameInputs(origin.inputs, inputs)) return null;
    if (!listUntouched(current, origin)) return null;
  }
  const prompts = starterPrompts(inputs.brand, inputs.category);
  return { prompts, origin: { source: "template", inputs, prompts } };
}

/**
 * The perception prompt as the setup screen first shows it: the canonical
 * template with {brand} resolved to the brand name. Also what "Reset to
 * template" puts back, so the pre-fill and the reset cannot drift apart.
 */
export function defaultPerceptionPrompt(brand: string): string {
  return resolvePerceptionPrompt(PERCEPTION_TEMPLATE, brand);
}

/**
 * What the perception prompt should show when the user advances from step 0.
 * Until the user edits it (`dirty`), it is the default prompt for the current
 * brand name; once edited, their wording is preserved.
 */
export function computePerceptionPrompt(dirty: boolean, current: string, brand: string): string {
  return dirty ? current : defaultPerceptionPrompt(brand);
}

/**
 * What to send when creating a project. Untouched, it is the canonical template
 * with the {brand} token intact, so the stored prompt keeps the token just as
 * the column default does, and the brand is resolved when a run fans out.
 * Edited, it is the user's own text.
 */
export function perceptionPromptToSubmit(dirty: boolean, current: string): string {
  return dirty ? current : PERCEPTION_TEMPLATE;
}

/**
 * The extraction model to auto-select: the lightest active extraction model from
 * a provider a key is configured for. `extractionModels` is expected pre-ordered
 * by `extraction_rank`, so the first match is the cheapest usable one.
 */
export function pickExtractor<T extends { provider: string }>(
  extractionModels: T[],
  keyedProviders: string[],
): T | undefined {
  // The shared rule (lib/extraction-choice) with no preferred model: a
  // project does not exist yet at onboarding.
  return pickExtraction(extractionModels, null, keyedProviders) ?? undefined;
}

/* --------------------------------------------------------- spend estimate */

/**
 * What the wizard's "this run will cost about $X" is built from. These are the
 * catalogue's list prices for one model; every estimate below is labelled as an
 * estimate on screen, because real spend depends on how long each answer
 * actually is, and the run screen logs the real figures as they land.
 */
export interface ModelPrices {
  provider: string;
  inputPerMtok: number;
  outputPerMtok: number;
  searchPerCall: number;
}

/**
 * A typical successful answer call per provider, in tokens, measured over 68
 * successful answer calls across the three providers. Failed calls are left
 * out: one is logged with zero tokens at the worker's worst-case cost, and
 * averaging it in would halve the token counts and double the money.
 *
 * The spread between providers is real. Anthropic bills its thinking tokens
 * and reports them, so an answer there carries about 33k input tokens. Gemini
 * reports almost no input tokens, so its logged cost, and this estimate, run
 * below the provider's own bill. These are not the worst-case bounds the
 * worker falls back on: those overstate an unmeasured call, and a preview that
 * overstates teaches people to ignore it.
 */
export const TYPICAL_ANSWER_BY_PROVIDER: Record<
  string,
  { inputTokens: number; outputTokens: number; searchCalls: number }
> = {
  anthropic: { inputTokens: 33_000, outputTokens: 1_700, searchCalls: 2.9 },
  openai: { inputTokens: 14_000, outputTokens: 950, searchCalls: 1.3 },
  google: { inputTokens: 0, outputTokens: 900, searchCalls: 2 },
};

/** For a provider the calibration has not met: a middle-of-the-table answer. */
export const TYPICAL_ANSWER_FALLBACK = {
  inputTokens: 16_000,
  outputTokens: 1_100,
  searchCalls: 2,
} as const;

/** A typical extraction call, from the same measurements: about 1,000 in, 600 out, no search. */
export const TYPICAL_EXTRACTION = { inputTokens: 1_000, outputTokens: 600 } as const;

export function typicalAnswerCost(prices: ModelPrices): number {
  const typical = TYPICAL_ANSWER_BY_PROVIDER[prices.provider] ?? TYPICAL_ANSWER_FALLBACK;
  return (
    (typical.inputTokens / 1_000_000) * prices.inputPerMtok +
    (typical.outputTokens / 1_000_000) * prices.outputPerMtok +
    typical.searchCalls * prices.searchPerCall
  );
}

export function typicalExtractionCost(prices: ModelPrices): number {
  return (
    (TYPICAL_EXTRACTION.inputTokens / 1_000_000) * prices.inputPerMtok +
    (TYPICAL_EXTRACTION.outputTokens / 1_000_000) * prices.outputPerMtok
  );
}

/**
 * What the run the wizard is about to start will cost, in USD, at list prices.
 *
 * The same shape as the server-side plan: every iteration of every prompt on
 * every assistant, plus one extraction call per answer, over a project that
 * does not exist yet. `includePerception` is true in the wizard because a new
 * project's first run also asks each assistant what it knows about the brand:
 * one answer call and one extraction each.
 *
 * The extractor is nullable: with no key for any extraction-capable provider
 * there is nothing to price, and the answer side alone is still useful. An
 * assistant with no catalogue prices (all zeros) contributes zero, as it does
 * in the run screen's real logging.
 */
export function estimateWizardSpend(input: {
  /** Sum of every written prompt's iterations. */
  totalIterations: number;
  assistants: readonly ModelPrices[];
  extractor: ModelPrices | null;
  includePerception: boolean;
}): number {
  const extractionCost = input.extractor ? typicalExtractionCost(input.extractor) : 0;
  let total = 0;
  for (const assistant of input.assistants) {
    const perAnswer = typicalAnswerCost(assistant) + extractionCost;
    total += input.totalIterations * perAnswer;
    if (input.includePerception) total += perAnswer;
  }
  return total;
}

/* ------------------------------------------------------- setup-check gate */

/**
 * How long a passing setup check stays fresh. Past this, "Create project"
 * re-runs the check first: a key can change in .env, credit can run out, and
 * the gate should notice at the moment money is about to be spent, not five
 * minutes stale.
 */
export const SETUP_CHECK_TTL_MS = 5 * 60_000;

export interface SetupCheckGateInput {
  /** The selection the report was run against, or null when none has run. */
  checkedSelection: readonly string[] | null;
  /** When the report was produced (ISO), or null when none has run. */
  checkedAt: string | null;
  rows: readonly { result: { status: SearchCheckStatus } }[];
  /** The selection ticked right now. */
  selectedModelIds: readonly string[];
  now: number;
}

export type SetupCheckGateState = "never" | "selection-changed" | "failed" | "stale" | "passed";

/**
 * Whether "Create project" may open, as a state the wizard can branch on and
 * explain. Order matters: a check of a different selection is not a failed
 * check of this one, and a stale pass is not a failure either. Only "passed"
 * opens the gate, and "stale" means re-run, not refuse.
 */
export function setupCheckGate(input: SetupCheckGateInput): SetupCheckGateState {
  const { checkedSelection, checkedAt, rows, selectedModelIds, now } = input;
  if (checkedSelection === null || checkedAt === null) return "never";
  if (selectionKey(checkedSelection) !== selectionKey(selectedModelIds)) {
    return "selection-changed";
  }
  if (!allRowsPassed(rows)) return "failed";
  const age = now - Date.parse(checkedAt);
  // A negative age means the clock moved since the check; re-run rather than
  // trust a timestamp from the future.
  if (Number.isNaN(age) || age < 0 || age > SETUP_CHECK_TTL_MS) return "stale";
  return "passed";
}

function selectionKey(modelIds: readonly string[]): string {
  return [...modelIds].sort().join("\u0000");
}

/**
 * Whether the setup check lets the create button be pressed. A stale pass
 * does: the click re-runs the check before anything is spent, and the server
 * checks again regardless.
 */
export function checkUnlocksCreate(gate: SetupCheckGateState): boolean {
  return gate === "passed" || gate === "stale";
}

export interface CreateGateInput {
  busy: boolean;
  /** Prompts with text, the ones a create would submit. */
  promptCount: number;
  untaggedCount: number;
  blankPerception: boolean;
  selectedCount: number;
  checkGate: SetupCheckGateState;
}

export interface CreateGate {
  enabled: boolean;
  /** The line under the button, or null when it has nothing to say. */
  hint: string | null;
}

/**
 * Whether "Create project and run" can be pressed, and what the line under it
 * says. Untagged prompts and a blank perception prompt are explained where
 * they are, on the prompt list, so the hint covers the assistants and the
 * setup check only.
 */
export function createGate(input: CreateGateInput): CreateGate {
  const unlocked = checkUnlocksCreate(input.checkGate);
  const enabled =
    !input.busy &&
    input.promptCount > 0 &&
    input.untaggedCount === 0 &&
    !input.blankPerception &&
    input.selectedCount > 0 &&
    unlocked;
  return { enabled, hint: createHint(input.selectedCount, input.checkGate, unlocked) };
}

function createHint(selectedCount: number, gate: SetupCheckGateState, unlocked: boolean) {
  if (selectedCount === 0) {
    return "Choose at least one assistant. A run asks every prompt of every assistant you pick.";
  }
  if (unlocked) return null;
  if (gate === "selection-changed") {
    return "Your assistant selection changed after the last setup check. Run it again to create the project.";
  }
  if (gate === "failed") {
    return "The setup check has to pass for every assistant you picked before you can create the project.";
  }
  return "Run the setup check before you create the project. A check that passed more than five minutes ago runs again when you click.";
}
