import { useCallback, useMemo, useState } from "react";
import { commitEntries } from "@/components/badge-input.logic";
import { isPlausibleDomain, normalizeDomain } from "@/lib/brand-matching";
import {
  computePerceptionPrompt,
  DEFAULT_WIZARD_ITERATIONS,
  defaultPerceptionPrompt,
  listUntouched,
  normalizeDescription,
  perceptionPromptToSubmit,
  type PromptOrigin,
  promptReset,
  type StarterInputs,
  type StarterPrompt,
  starterInputs,
} from "@/lib/onboarding";
import type { WizardDraftFields } from "@/lib/setup-draft";
import type { StarterRequest } from "@/lib/starter-generation";

/** A prompt row. The key stays with the row through edits and removals. */
export type WizardPrompt = StarterPrompt & { key: string };

let lastKey = 0;
function keyed(prompt: StarterPrompt): WizardPrompt {
  lastKey += 1;
  return { ...prompt, key: `prompt-${lastKey}` };
}

/** Everything the tutorial fills the form with. */
export interface WizardPrefill {
  brandName: string;
  category: string;
  variants: string[];
  domains: string[];
  competitors: string[];
  prompts: StarterPrompt[];
  perceptionPrompt: string;
}

const STARTER_TAGS = ["visibility", "comparison"];
const MAX_COMPETITORS = 3;

/**
 * The setup wizard's form: what the user typed, what it means, and the
 * createProject input it adds up to.
 */
export function useWizardForm() {
  const [brandName, setBrandName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [variants, setVariants] = useState<string[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [competitors, setCompetitors] = useState<string[]>([]);
  // BadgeInput commits on Enter, comma or blur, and a disabled button takes no
  // focus in Chrome, so text left in the box would never commit and Continue
  // would stay disabled. The pending text counts as entered.
  const [domainDraft, setDomainDraft] = useState("");
  const [competitorDraft, setCompetitorDraft] = useState("");
  // One optional domain per competitor, keyed by the name as entered. Without
  // one a competitor can be named by an assistant but never cited.
  const [competitorDomains, setCompetitorDomains] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<WizardPrompt[]>([]);
  // What wrote the list, and for which inputs. The reset rule and the generate
  // button both read it, and an edit is told from it by comparison, so there
  // is no dirty flag to keep in step.
  const [promptOrigin, setPromptOrigin] = useState<PromptOrigin | null>(null);
  const [perceptionPrompt, setPerceptionPrompt] = useState("");
  const [perceptionDirty, setPerceptionDirty] = useState(false);

  // A domain is required and has to be a usable one: citation rate is an
  // answer linking one of the brand's domains, so a typo scores 0% forever.
  // A value that does not look like a domain blocks and is named, never dropped.
  const enteredDomains = commitEntries(domains, domainDraft, Infinity);
  const enteredCompetitors = commitEntries(competitors, competitorDraft, MAX_COMPETITORS);
  const badDomains = enteredDomains.filter((domain) => domain.trim() && !isPlausibleDomain(domain));
  const usableDomains = enteredDomains.filter(isPlausibleDomain).map(normalizeDomain);
  const badCompetitorDomains = enteredCompetitors
    .map((name) => ({ name, domain: (competitorDomains[name] ?? "").trim() }))
    .filter((entry) => entry.domain !== "" && !isPlausibleDomain(entry.domain));

  const writtenPrompts = useMemo(() => prompts.filter((prompt) => prompt.text.trim()), [prompts]);
  // Every question needs a tag: tags are the only grouping the statistics have.
  const untaggedPrompts = writtenPrompts.filter((prompt) => !prompt.tag);
  // The warnings name rows by number, which is how the user finds them.
  const rowNumbers = (test: (prompt: WizardPrompt) => boolean) =>
    prompts.flatMap((prompt, index) => (test(prompt) ? [index + 1] : []));
  const untaggedNumbers = rowNumbers((prompt) => prompt.text.trim() !== "" && !prompt.tag);
  const blankNumbers = rowNumbers((prompt) => prompt.text.trim() === "");
  const tagChoices = [
    ...new Set([
      ...STARTER_TAGS,
      ...prompts
        .map((prompt) => prompt.tag)
        .filter((tag): tag is string => !!tag && tag.trim() !== ""),
    ]),
  ];
  const blankPerception = !perceptionPrompt.trim();

  const canContinue =
    brandName.trim() !== "" &&
    category.trim() !== "" &&
    usableDomains.length > 0 &&
    badDomains.length === 0 &&
    badCompetitorDomains.length === 0;

  const inputs = starterInputs(brandName, category, description);
  const promptsUntouched = listUntouched(prompts, promptOrigin);

  const seed = useCallback((values: WizardPrefill) => {
    setBrandName(values.brandName);
    setCategory(values.category);
    setDescription("");
    setVariants(values.variants);
    setDomains(values.domains);
    setCompetitors(values.competitors);
    setPrompts(values.prompts.map(keyed));
    // Written for exactly these inputs, so the step change keeps the seeded
    // text instead of putting the templates back.
    setPromptOrigin({
      source: "prefill",
      inputs: starterInputs(values.brandName, values.category, ""),
      prompts: values.prompts,
    });
    setPerceptionPrompt(values.perceptionPrompt);
    setPerceptionDirty(true);
  }, []);

  /** Everything a reload would lose, for the saved setup draft. */
  const draftFields = useMemo<WizardDraftFields>(
    () => ({
      brandName,
      category,
      description,
      variants,
      domains,
      competitors,
      competitorDomains,
      prompts: prompts.map(({ text, tag, iterations }) => ({ text, tag, iterations })),
      promptOrigin,
      perceptionPrompt,
      perceptionDirty,
    }),
    [
      brandName,
      category,
      description,
      variants,
      domains,
      competitors,
      competitorDomains,
      prompts,
      promptOrigin,
      perceptionPrompt,
      perceptionDirty,
    ],
  );

  /** Puts a saved draft back. The empty draft is how Start over clears the form. */
  const restore = useCallback((draft: WizardDraftFields) => {
    setBrandName(draft.brandName);
    setCategory(draft.category);
    setDescription(draft.description);
    setVariants(draft.variants);
    setDomains(draft.domains);
    setCompetitors(draft.competitors);
    setCompetitorDomains(draft.competitorDomains);
    setDomainDraft("");
    setCompetitorDraft("");
    setPrompts(draft.prompts.map(keyed));
    setPromptOrigin(draft.promptOrigin);
    setPerceptionPrompt(draft.perceptionPrompt);
    setPerceptionDirty(draft.perceptionDirty);
  }, []);

  /** Leaving the brand step: the reset rule for the prompts, and the perception prompt. */
  function advance() {
    // Only a reset writes new rows, and only new rows need keys.
    const reset = promptReset(prompts, promptOrigin, inputs);
    if (reset) {
      setPrompts(reset.prompts.map(keyed));
      setPromptOrigin(reset.origin);
    }
    setPerceptionPrompt(computePerceptionPrompt(perceptionDirty, perceptionPrompt, brandName));
  }

  function editPrompt(key: string, patch: Partial<StarterPrompt>) {
    setPrompts(prompts.map((prompt) => (prompt.key === key ? { ...prompt, ...patch } : prompt)));
  }

  function removePrompt(key: string) {
    setPrompts(prompts.filter((prompt) => prompt.key !== key));
  }

  function addPrompt() {
    setPrompts([...prompts, keyed({ text: "", tag: null, iterations: DEFAULT_WIZARD_ITERATIONS })]);
  }

  /** What the generate button sends: the brand as the form holds it when the button is pressed. */
  function generationRequest(): StarterRequest {
    return {
      brandName: brandName.trim(),
      category: category.trim(),
      description: normalizeDescription(description),
      variants,
      competitors: enteredCompetitors,
    };
  }

  /**
   * A generated set replaces the list, and becomes what wrote it for the
   * inputs it was generated from, so the next input change can reset it.
   */
  function applyGenerated(generated: StarterPrompt[], generatedFor: StarterInputs) {
    setPrompts(generated.map(keyed));
    setPromptOrigin({ source: "generated", inputs: generatedFor, prompts: generated });
  }

  function editPerception(text: string) {
    setPerceptionDirty(true);
    setPerceptionPrompt(text);
  }

  function resetPerception() {
    setPerceptionDirty(false);
    setPerceptionPrompt(defaultPerceptionPrompt(brandName));
  }

  function setCompetitorDomain(name: string, domain: string) {
    setCompetitorDomains((current) => ({ ...current, [name]: domain }));
  }

  /** The createProject input: trimmed names, usable domains, written prompts only. */
  function projectInput(monitoredModelIds: string[]) {
    return {
      brandName: brandName.trim(),
      category: category.trim(),
      description: normalizeDescription(description),
      variants,
      domains: usableDomains,
      competitors: enteredCompetitors.map((name) => {
        const domain = (competitorDomains[name] ?? "").trim();
        return {
          name,
          domains: domain !== "" && isPlausibleDomain(domain) ? [normalizeDomain(domain)] : [],
        };
      }),
      prompts: writtenPrompts.map(({ text, tag, iterations }) => ({ text, tag, iterations })),
      perceptionPrompt: perceptionPromptToSubmit(perceptionDirty, perceptionPrompt),
      monitoredModelIds,
    };
  }

  return {
    brandName,
    setBrandName,
    category,
    setCategory,
    description,
    setDescription,
    variants,
    setVariants,
    domains,
    setDomains,
    setDomainDraft,
    competitors,
    setCompetitors,
    setCompetitorDraft,
    competitorDomains,
    setCompetitorDomain,
    enteredCompetitors,
    badDomains,
    usableDomains,
    badCompetitorDomains,
    canContinue,
    prompts,
    writtenPrompts,
    untaggedPrompts,
    untaggedNumbers,
    blankNumbers,
    tagChoices,
    editPrompt,
    removePrompt,
    addPrompt,
    inputs,
    promptsUntouched,
    promptSource: promptOrigin?.source ?? null,
    generationRequest,
    applyGenerated,
    perceptionPrompt,
    perceptionDirty,
    blankPerception,
    editPerception,
    resetPerception,
    seed,
    advance,
    projectInput,
    draftFields,
    restore,
  };
}

/** The form as it opens, which Start over restores. */
export const EMPTY_WIZARD_DRAFT: WizardDraftFields = {
  brandName: "",
  category: "",
  description: "",
  variants: [],
  domains: [],
  competitors: [],
  competitorDomains: {},
  prompts: [],
  promptOrigin: null,
  perceptionPrompt: "",
  perceptionDirty: false,
};

export type WizardForm = ReturnType<typeof useWizardForm>;
