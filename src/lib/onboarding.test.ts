import { describe, it, expect } from "vitest";
import type { SearchCheckStatus } from "./setup-check";
import {
  computePerceptionPrompt,
  createGate,
  DEFAULT_WIZARD_ITERATIONS,
  DESCRIPTION_MAX_CHARS,
  defaultPerceptionPrompt,
  estimateWizardSpend,
  listUntouched,
  normalizeDescription,
  perceptionPromptToSubmit,
  pickExtractor,
  promptReset,
  SETUP_CHECK_TTL_MS,
  setupCheckGate,
  starterInputs,
  starterPrompts,
  TYPICAL_ANSWER_BY_PROVIDER,
  TYPICAL_ANSWER_FALLBACK,
  TYPICAL_EXTRACTION,
  typicalAnswerCost,
  typicalExtractionCost,
} from "./onboarding";
import { PERCEPTION_TEMPLATE, resolvePerceptionPrompt } from "./perception";

describe("starterPrompts", () => {
  it("names the brand once and the category everywhere else", () => {
    const prompts = starterPrompts("Acme Analytics", "CRM");
    expect(prompts).toHaveLength(5);
    expect(prompts.filter((p) => p.text.includes("Acme Analytics"))).toHaveLength(1);
    expect(prompts.every((p) => p.text.includes("CRM") || p.text.includes("Acme"))).toBe(true);
  });

  it("seeds only the two starter tags", () => {
    const tags = new Set(starterPrompts("Acme Analytics", "CRM").map((p) => p.tag));
    expect([...tags].sort()).toEqual(["comparison", "visibility"]);
  });

  it("asks the visibility questions before the comparison ones", () => {
    // Whether assistants name the brand at all is the question a new project
    // most needs answered; the comparison prompts build on it.
    const tags = starterPrompts("Acme Analytics", "CRM").map((p) => p.tag);
    expect(tags).toEqual(["visibility", "visibility", "visibility", "comparison", "comparison"]);
  });

  it("keeps the five templates word for word: they are the measuring instrument", () => {
    // Generation rewrites the five on request; it never changes these.
    expect(starterPrompts("Acme Analytics", "CRM").map((prompt) => prompt.text)).toEqual([
      "What are the best options for CRM?",
      "Which CRM would you recommend, and why?",
      "What are the best options for CRM on a tight budget?",
      "What should I consider when comparing options for CRM?",
      "Is Acme Analytics a good option? What are the main alternatives?",
    ]);
  });

  it("seeds every prompt with the default repeats count", () => {
    const prompts = starterPrompts("Acme Analytics", "CRM");
    expect(prompts.every((p) => p.iterations === DEFAULT_WIZARD_ITERATIONS)).toBe(true);
    expect(DEFAULT_WIZARD_ITERATIONS).toBe(3);
  });
});

describe("the brand description", () => {
  it("is one sentence: line breaks and runs of spaces collapse, the ends are trimmed", () => {
    expect(normalizeDescription("  Coworking desks\nfor freelancers   in Lisbon. ")).toBe(
      "Coworking desks for freelancers in Lisbon.",
    );
    expect(normalizeDescription(" \n ")).toBe("");
  });

  it("is capped at the length the projects CHECK holds", () => {
    expect(DESCRIPTION_MAX_CHARS).toBe(280);
  });
});

describe("the reset rule", () => {
  const acme = starterInputs("Acme Analytics", "CRM", "");
  const generated = [
    { text: "Which CRM suits a Lisbon agency?", tag: "visibility", iterations: 3 },
    {
      text: "Are there better alternatives than Acme Analytics?",
      tag: "comparison",
      iterations: 3,
    },
  ];
  const templateOrigin = (inputs = acme) => ({
    source: "template" as const,
    inputs,
    prompts: starterPrompts(inputs.brand, inputs.category),
  });
  const generatedOrigin = { source: "generated" as const, inputs: acme, prompts: generated };

  it("puts the templates on a list nothing has written yet", () => {
    const reset = promptReset([], null, acme);
    expect(reset?.prompts).toEqual(starterPrompts("Acme Analytics", "CRM"));
    expect(reset?.origin).toEqual(templateOrigin());
  });

  it("keeps the list, whoever wrote it, when the inputs are unchanged", () => {
    const edited = [{ text: "my own prompt", tag: null, iterations: 4 }];
    expect(promptReset(edited, templateOrigin(), acme)).toBeNull();
    expect(promptReset(generated, generatedOrigin, acme)).toBeNull();
    // Trimming is not a change.
    expect(
      promptReset(generated, generatedOrigin, starterInputs(" Acme Analytics ", "CRM", " ")),
    ).toBeNull();
  });

  it("resets untouched templates to the templates for the new category", () => {
    const moved = starterInputs("Acme Analytics", "email tools", "");
    const reset = promptReset(templateOrigin().prompts, templateOrigin(), moved);
    expect(reset?.prompts).toEqual(starterPrompts("Acme Analytics", "email tools"));
    expect(reset?.origin.inputs).toEqual(moved);
  });

  it("resets an untouched generated set to the templates, which re-arms the button", () => {
    for (const changed of [
      starterInputs("Northwind Metrics", "CRM", ""),
      starterInputs("Acme Analytics", "email tools", ""),
      starterInputs("Acme Analytics", "CRM", "For agencies in Lisbon."),
    ]) {
      const reset = promptReset(generated, generatedOrigin, changed);
      expect(reset?.origin.source).toBe("template");
      expect(reset?.prompts).toEqual(starterPrompts(changed.brand, changed.category));
    }
  });

  it("keeps a list edited by hand whatever changed: templates or generated, it is the user's", () => {
    const changed = starterInputs("Acme Analytics", "email tools", "For agencies.");
    const editedTemplates = templateOrigin().prompts.map((prompt, index) =>
      index === 0 ? { ...prompt, text: `${prompt.text} For agencies.` } : prompt,
    );
    expect(promptReset(editedTemplates, templateOrigin(), changed)).toBeNull();
    const retagged = generated.map((prompt, index) =>
      index === 1 ? { ...prompt, tag: "alternatives" } : prompt,
    );
    expect(promptReset(retagged, generatedOrigin, changed)).toBeNull();
    const fewer = generated.slice(0, 1);
    expect(promptReset(fewer, generatedOrigin, changed)).toBeNull();
  });

  it("keeps the tutorial's prefill: it was written for the inputs it arrives with", () => {
    const prefill = [
      { text: "What are the best web analytics options?", tag: "visibility", iterations: 3 },
    ];
    const inputs = starterInputs("Acme Analytics", "web analytics", "");
    expect(
      promptReset(prefill, { source: "prefill", inputs, prompts: prefill }, inputs),
    ).toBeNull();
  });
});

describe("listUntouched", () => {
  const origin = {
    source: "template" as const,
    inputs: starterInputs("Acme Analytics", "CRM", ""),
    prompts: starterPrompts("Acme Analytics", "CRM"),
  };

  it("is true row for row, and false with nothing written yet", () => {
    expect(listUntouched(starterPrompts("Acme Analytics", "CRM"), origin)).toBe(true);
    expect(listUntouched([], null)).toBe(false);
  });

  it("counts a changed text, tag or iteration count, an added row and a removed one as edits", () => {
    const rows = starterPrompts("Acme Analytics", "CRM");
    const change = (patch: Partial<(typeof rows)[number]>) =>
      rows.map((row, index) => (index === 2 ? { ...row, ...patch } : row));
    expect(listUntouched(change({ text: "Something else?" }), origin)).toBe(false);
    expect(listUntouched(change({ tag: "comparison" }), origin)).toBe(false);
    expect(listUntouched(change({ iterations: 5 }), origin)).toBe(false);
    expect(listUntouched([...rows, { text: "", tag: null, iterations: 3 }], origin)).toBe(false);
    expect(listUntouched(rows.slice(1), origin)).toBe(false);
  });

  it("is true again when an edit is put back exactly", () => {
    const rows = starterPrompts("Acme Analytics", "CRM");
    const restored = rows.map((row) => ({ ...row }));
    expect(listUntouched(restored, origin)).toBe(true);
  });
});

describe("defaultPerceptionPrompt", () => {
  it("is the canonical template with the brand name resolved", () => {
    const text = defaultPerceptionPrompt("Northwind Metrics");
    expect(text).toBe(resolvePerceptionPrompt(PERCEPTION_TEMPLATE, "Northwind Metrics"));
    expect(text).toContain("What do you know about Northwind Metrics?");
    expect(text).not.toContain("{brand}");
  });
});

describe("computePerceptionPrompt", () => {
  it("pre-fills the default prompt for the brand while untouched", () => {
    expect(computePerceptionPrompt(false, "", "Northwind Metrics")).toBe(
      defaultPerceptionPrompt("Northwind Metrics"),
    );
  });

  it("follows a brand change while untouched", () => {
    const before = computePerceptionPrompt(false, "", "Northwind Metrics");
    expect(computePerceptionPrompt(false, before, "Contoso Insights")).toContain(
      "What do you know about Contoso Insights?",
    );
  });

  it("preserves the user's edit once dirty, whatever the brand", () => {
    expect(computePerceptionPrompt(true, "Describe Northwind briefly.", "Contoso Insights")).toBe(
      "Describe Northwind briefly.",
    );
  });
});

describe("perceptionPromptToSubmit", () => {
  it("sends the canonical template, token and all, when the user has not edited", () => {
    expect(perceptionPromptToSubmit(false, "anything shown")).toBe(PERCEPTION_TEMPLATE);
  });

  it("sends the user's edit when they have", () => {
    expect(perceptionPromptToSubmit(true, "Describe {brand} briefly.")).toBe(
      "Describe {brand} briefly.",
    );
  });
});

describe("pickExtractor", () => {
  const models = [
    { id: "m1", provider: "anthropic" },
    { id: "m2", provider: "openai" },
  ];

  it("returns the first extraction model whose provider has a key", () => {
    expect(pickExtractor(models, ["openai"])?.id).toBe("m2");
  });

  it("returns undefined when no configured provider can extract", () => {
    // google is not in the fixture, so no configured provider can extract.
    expect(pickExtractor(models, ["google"])).toBeUndefined();
  });
});

describe("starterPrompts with no category", () => {
  it("still reads as English in all four sentences", () => {
    // The wizard requires a category, but a caller with an empty one gets the
    // fallback, and a phrase like "products like this" would produce "What are
    // the best products like this options?".
    const prompts = starterPrompts("Acme Analytics", "   ");
    expect(prompts.map((prompt) => prompt.text)).toEqual([
      "What are the best options for product?",
      "Which product would you recommend, and why?",
      "What are the best options for product on a tight budget?",
      "What should I consider when comparing options for product?",
      "Is Acme Analytics a good option? What are the main alternatives?",
    ]);
  });
});

describe("spend estimate", () => {
  // Prices shaped like the catalog's: $10/Mtok in, $30/Mtok out, $30 per
  // 1,000 searches, so the arithmetic stays checkable by hand.
  const anthropic = {
    provider: "anthropic",
    inputPerMtok: 10,
    outputPerMtok: 30,
    searchPerCall: 0.03,
  };
  const perplexity = {
    provider: "perplexity",
    inputPerMtok: 10,
    outputPerMtok: 30,
    searchPerCall: 0.03,
  };
  const extractor = { provider: "anthropic", inputPerMtok: 1, outputPerMtok: 4, searchPerCall: 0 };

  it("prices a typical answer from the calibrated per-provider token counts", () => {
    const typical = TYPICAL_ANSWER_BY_PROVIDER["anthropic"]!;
    const expected =
      (typical.inputTokens / 1e6) * anthropic.inputPerMtok +
      (typical.outputTokens / 1e6) * anthropic.outputPerMtok +
      typical.searchCalls * anthropic.searchPerCall;
    expect(typicalAnswerCost(anthropic)).toBeCloseTo(expected, 10);
  });

  it("falls back to middle-of-the-table tokens for a provider it has not met", () => {
    const typical = TYPICAL_ANSWER_FALLBACK;
    const expected =
      (typical.inputTokens / 1e6) * perplexity.inputPerMtok +
      (typical.outputTokens / 1e6) * perplexity.outputPerMtok +
      typical.searchCalls * perplexity.searchPerCall;
    expect(typicalAnswerCost(perplexity)).toBeCloseTo(expected, 10);
  });

  it("prices a typical extraction with no search leg", () => {
    const expected =
      (TYPICAL_EXTRACTION.inputTokens / 1e6) * extractor.inputPerMtok +
      (TYPICAL_EXTRACTION.outputTokens / 1e6) * extractor.outputPerMtok;
    expect(typicalExtractionCost(extractor)).toBeCloseTo(expected, 10);
  });

  it("multiplies iterations by assistants and adds the extraction per answer", () => {
    const spend = estimateWizardSpend({
      totalIterations: 15,
      assistants: [anthropic, anthropic],
      extractor,
      includePerception: false,
    });
    const perAnswer = typicalAnswerCost(anthropic) + typicalExtractionCost(extractor);
    expect(spend).toBeCloseTo(15 * perAnswer * 2, 10);
  });

  it("adds one answer plus one extraction per assistant for the first run's perception question", () => {
    const without = estimateWizardSpend({
      totalIterations: 9,
      assistants: [anthropic],
      extractor,
      includePerception: false,
    });
    const withPerception = estimateWizardSpend({
      totalIterations: 9,
      assistants: [anthropic],
      extractor,
      includePerception: true,
    });
    const perAnswer = typicalAnswerCost(anthropic) + typicalExtractionCost(extractor);
    expect(withPerception - without).toBeCloseTo(perAnswer, 10);
  });

  it("estimates the answer side alone when no extractor can be picked", () => {
    const spend = estimateWizardSpend({
      totalIterations: 3,
      assistants: [anthropic],
      extractor: null,
      includePerception: true,
    });
    expect(spend).toBeCloseTo(4 * typicalAnswerCost(anthropic), 10);
  });

  it("prices each assistant at its own provider's typical tokens", () => {
    const google = { provider: "google", inputPerMtok: 10, outputPerMtok: 30, searchPerCall: 0.03 };
    const spend = estimateWizardSpend({
      totalIterations: 3,
      assistants: [anthropic, google],
      extractor: null,
      includePerception: false,
    });
    expect(spend).toBeCloseTo(3 * (typicalAnswerCost(anthropic) + typicalAnswerCost(google)), 10);
    // Anthropic bills thinking tokens; Gemini's typical answer costs less at
    // the same prices. If this ever inverts, the calibration table is wrong.
    expect(typicalAnswerCost(anthropic)).toBeGreaterThan(typicalAnswerCost(google));
  });

  it("is zero with no assistants, and free models contribute nothing", () => {
    expect(
      estimateWizardSpend({
        totalIterations: 9,
        assistants: [],
        extractor,
        includePerception: true,
      }),
    ).toBe(0);
    const free = { provider: "openai", inputPerMtok: 0, outputPerMtok: 0, searchPerCall: 0 };
    expect(
      estimateWizardSpend({
        totalIterations: 9,
        assistants: [free],
        extractor: free,
        includePerception: true,
      }),
    ).toBe(0);
  });
});

describe("setupCheckGate", () => {
  const rows = (statuses: SearchCheckStatus[]) =>
    statuses.map((status) => ({ result: { status } }));
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("says never when no check has run", () => {
    expect(
      setupCheckGate({
        checkedSelection: null,
        checkedAt: null,
        rows: [],
        selectedModelIds: ["a"],
        now,
      }),
    ).toBe("never");
  });

  it("says selection-changed when the ticked models are not the checked ones", () => {
    expect(
      setupCheckGate({
        checkedSelection: ["a"],
        checkedAt: at(1000),
        rows: rows(["ok", "mocked"]),
        selectedModelIds: ["a", "b"],
        now,
      }),
    ).toBe("selection-changed");
    // Order is not a change.
    expect(
      setupCheckGate({
        checkedSelection: ["b", "a"],
        checkedAt: at(1000),
        rows: rows(["ok", "ok"]),
        selectedModelIds: ["a", "b"],
        now,
      }),
    ).toBe("passed");
  });

  it("says failed when any checked row did not pass", () => {
    expect(
      setupCheckGate({
        checkedSelection: ["a"],
        checkedAt: at(1000),
        rows: rows(["ok", "no_credits"]),
        selectedModelIds: ["a"],
        now,
      }),
    ).toBe("failed");
  });

  it("says stale past the TTL, passed within it", () => {
    const input = {
      checkedSelection: ["a"],
      rows: rows(["ok"]),
      selectedModelIds: ["a"],
    };
    expect(setupCheckGate({ ...input, checkedAt: at(SETUP_CHECK_TTL_MS + 1000), now })).toBe(
      "stale",
    );
    expect(setupCheckGate({ ...input, checkedAt: at(1000), now })).toBe("passed");
    // A checkedAt in the future means the clock moved; re-check rather than trust it.
    expect(setupCheckGate({ ...input, checkedAt: at(-60_000), now })).toBe("stale");
  });
});

describe("createGate", () => {
  const ready = {
    busy: false,
    promptCount: 5,
    untaggedCount: 0,
    blankPerception: false,
    selectedCount: 3,
    checkGate: "passed" as const,
  };

  it("opens with prompts, tags, a perception prompt, assistants and a passed check", () => {
    expect(createGate(ready)).toEqual({ enabled: true, hint: null });
  });

  it("opens on a stale pass, because the click re-runs the check", () => {
    expect(createGate({ ...ready, checkGate: "stale" })).toEqual({ enabled: true, hint: null });
  });

  it("stays shut while busy, with no prompts, an untagged prompt or a blank perception prompt", () => {
    expect(createGate({ ...ready, busy: true }).enabled).toBe(false);
    expect(createGate({ ...ready, promptCount: 0 }).enabled).toBe(false);
    expect(createGate({ ...ready, untaggedCount: 1 }).enabled).toBe(false);
    expect(createGate({ ...ready, blankPerception: true }).enabled).toBe(false);
    // The prompt list explains those itself.
    expect(createGate({ ...ready, untaggedCount: 1 }).hint).toBeNull();
  });

  it("asks for an assistant before it mentions the check", () => {
    const gate = createGate({ ...ready, selectedCount: 0, checkGate: "never" });
    expect(gate.enabled).toBe(false);
    expect(gate.hint).toMatch(/^Choose at least one assistant/);
  });

  it("says why the check holds the button shut", () => {
    expect(createGate({ ...ready, checkGate: "never" }).hint).toMatch(/^Run the setup check/);
    expect(createGate({ ...ready, checkGate: "selection-changed" }).hint).toMatch(
      /selection changed/,
    );
    expect(createGate({ ...ready, checkGate: "failed" }).hint).toMatch(/has to pass/);
    for (const checkGate of ["never", "selection-changed", "failed"] as const) {
      expect(createGate({ ...ready, checkGate }).enabled).toBe(false);
    }
  });
});
