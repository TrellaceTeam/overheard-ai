import { describe, expect, it } from "vitest";
import { DEFAULT_WIZARD_ITERATIONS } from "./onboarding";
import {
  EDITED_HINT,
  estimateGenerationCost,
  generateButtonLabel,
  generateState,
  generationFailedToast,
  NO_KEY_HINT,
  parseStarterPrompts,
  pickGenerationModel,
  STARTER_GENERATION_SYSTEM,
  STARTER_PROMPTS_SHAPE,
  starterGenerationChars,
  starterGenerationUserPrompt,
  THREE_DOORS_LINE,
} from "./starter-generation";

/** A catalogue row with only the columns the rule reads. Prices in USD per million tokens. */
function model(
  id: string,
  provider: string,
  tier: string,
  input: number,
  output: number,
  active: 0 | 1 = 1,
) {
  return {
    id,
    provider,
    tier,
    is_active: active,
    input_price_per_mtok: input,
    output_price_per_mtok: output,
  };
}

// Shaped like the seeded catalogue: an OpenAI and a Google mid model that tie
// exactly on price, an Anthropic one above them, and the three extractors.
const CATALOGUE = [
  model("claude-mid", "anthropic", "mid", 3, 15),
  model("claude-frontier", "anthropic", "frontier", 5, 25),
  model("gpt-mid", "openai", "mid", 2, 12),
  model("gpt-frontier", "openai", "frontier", 5, 30),
  model("gemini-mid", "google", "mid", 2, 12),
  model("gemini-frontier", "google", "frontier", 2, 12),
];
const EXTRACTORS = [
  model("gpt-small", "openai", "extraction", 0.2, 1.2),
  model("gemini-small", "google", "extraction", 0.25, 1.5),
  model("claude-small", "anthropic", "extraction", 1, 5),
];

describe("pickGenerationModel", () => {
  it("takes the cheapest active mid-tier model of a keyed provider", () => {
    expect(pickGenerationModel(CATALOGUE, EXTRACTORS, ["anthropic"])?.id).toBe("claude-mid");
    expect(pickGenerationModel(CATALOGUE, EXTRACTORS, ["anthropic", "google"])?.id).toBe(
      "gemini-mid",
    );
  });

  it("orders by input price, then output price", () => {
    const catalogue = [
      model("a-mid", "anthropic", "mid", 1, 20),
      model("o-mid", "openai", "mid", 2, 1),
      model("g-mid", "google", "mid", 1, 10),
    ];
    expect(pickGenerationModel(catalogue, [], ["openai", "anthropic", "google"])?.id).toBe("g-mid");
  });

  it("breaks an exact tie OpenAI, then Anthropic, then Google, whatever the list order", () => {
    expect(pickGenerationModel(CATALOGUE, EXTRACTORS, ["google", "openai"])?.id).toBe("gpt-mid");
    const tied = [
      model("g-mid", "google", "mid", 2, 12),
      model("a-mid", "anthropic", "mid", 2, 12),
    ];
    expect(pickGenerationModel(tied, [], ["google", "anthropic"])?.id).toBe("a-mid");
  });

  it("never takes a switched-off model or one whose provider has no key", () => {
    const catalogue = [
      model("gpt-mid", "openai", "mid", 0.1, 0.1, 0),
      model("claude-mid", "anthropic", "mid", 3, 15),
    ];
    expect(pickGenerationModel(catalogue, [], ["openai", "anthropic"])?.id).toBe("claude-mid");
  });

  it("falls back to the preferred extractor when no keyed provider has a mid-tier model", () => {
    const noMid = CATALOGUE.filter((row) => row.tier !== "mid");
    const preferred = EXTRACTORS[2]!;
    expect(pickGenerationModel(noMid, EXTRACTORS, ["openai", "anthropic"], preferred)?.id).toBe(
      "claude-small",
    );
  });

  it("falls back to the cheapest keyed extractor with no preferred one, or an unkeyed one", () => {
    const noMid = CATALOGUE.filter((row) => row.tier !== "mid");
    expect(pickGenerationModel(noMid, EXTRACTORS, ["google", "anthropic"])?.id).toBe(
      "gemini-small",
    );
    const unkeyedPreferred = EXTRACTORS[0]!;
    expect(pickGenerationModel(noMid, EXTRACTORS, ["anthropic"], unkeyedPreferred)?.id).toBe(
      "claude-small",
    );
  });

  it("is null with no key at all, which keeps the button disabled", () => {
    expect(pickGenerationModel(CATALOGUE, EXTRACTORS, [])).toBeNull();
  });
});

const REQUEST = {
  brandName: "Acme Analytics",
  category: "coworking space",
  description: "Hot desks and meeting rooms for freelancers in Lisbon.",
  variants: ["Acme"],
  competitors: ["Northwind Metrics", "Contoso Insights"],
};

describe("the request", () => {
  it("sends one labelled line per fact", () => {
    expect(starterGenerationUserPrompt(REQUEST)).toBe(
      [
        "Brand: Acme Analytics",
        "Other names for the brand: Acme",
        "Category: coworking space",
        "What the brand does, for whom and where: Hot desks and meeting rooms for freelancers in Lisbon.",
        "Competitors: Northwind Metrics, Contoso Insights",
      ].join("\n"),
    );
  });

  it("says an empty fact is empty, so the model does not guess one", () => {
    const prompt = starterGenerationUserPrompt({
      ...REQUEST,
      description: "  ",
      variants: [],
      competitors: [" "],
    });
    expect(prompt).toContain("What the brand does, for whom and where: not given");
    expect(prompt).toContain("Other names for the brand: none given");
    expect(prompt).toContain("Competitors: none given");
  });

  it("is sized from everything it sends", () => {
    expect(starterGenerationChars(REQUEST)).toBe(
      STARTER_GENERATION_SYSTEM.length + starterGenerationUserPrompt(REQUEST).length,
    );
  });

  it("keeps instructions to the assistant out of the questions it asks for", () => {
    // Search is forced on the wire at call time. The instructions ask for
    // questions a buyer would type, and say so.
    expect(STARTER_GENERATION_SYSTEM).toContain("Never tell the assistant how to answer");
    expect(STARTER_GENERATION_SYSTEM).not.toMatch(/\u2014/);
  });

  it("enforces five named string fields, every one required", () => {
    const schema = STARTER_PROMPTS_SHAPE.schema;
    expect(schema.required).toEqual([
      "visibility_1",
      "visibility_2",
      "visibility_3",
      "comparison",
      "comparison_naming_brand",
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
  });
});

/** A reply that meets the contract, with any field overridden. */
function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    visibility_1: "Which coworking spaces in Lisbon suit a freelancer who needs quiet hot desks?",
    visibility_2: "Where can a remote designer rent a desk by the day in central Lisbon?",
    visibility_3:
      "Which Lisbon coworking spaces have meeting rooms a freelancer can book by the hour?",
    comparison: "How do Lisbon coworking spaces compare on day passes versus monthly desks?",
    comparison_naming_brand:
      "Are there better alternatives than Acme Analytics for freelancers who need a desk in Lisbon?",
    ...overrides,
  });
}

const BRAND = { name: "Acme Analytics", variants: ["Acme"] };

describe("parseStarterPrompts, the contract", () => {
  it("takes five: three visibility and two comparison, at the default iterations, in order", () => {
    const prompts = parseStarterPrompts(reply(), BRAND);
    expect(prompts.map((prompt) => prompt.tag)).toEqual([
      "visibility",
      "visibility",
      "visibility",
      "comparison",
      "comparison",
    ]);
    expect(prompts.every((prompt) => prompt.iterations === DEFAULT_WIZARD_ITERATIONS)).toBe(true);
    expect(prompts[4]?.text).toMatch(/^Are there better alternatives than Acme Analytics/);
  });

  it("reads a reply wrapped in a code fence, and tidies the spacing", () => {
    const fenced = `\`\`\`json\n${reply({ comparison: "  How do Lisbon coworking spaces\n compare on price?  " })}\n\`\`\``;
    expect(parseStarterPrompts(fenced, BRAND)[3]?.text).toBe(
      "How do Lisbon coworking spaces compare on price?",
    );
  });

  it("refuses a reply that is not the shape", () => {
    expect(() => parseStarterPrompts("Here are five questions.", BRAND)).toThrow(/SHAPE_VIOLATION/);
    expect(() => parseStarterPrompts("{not json}", BRAND)).toThrow(/SHAPE_VIOLATION/);
    expect(() => parseStarterPrompts(reply({ visibility_2: undefined }), BRAND)).toThrow(
      /visibility_2 is missing/,
    );
    expect(() => parseStarterPrompts(reply({ comparison: 42 }), BRAND)).toThrow(
      /comparison is missing/,
    );
  });

  it("refuses a visibility question that names the brand or one of its variants", () => {
    expect(() =>
      parseStarterPrompts(
        reply({ visibility_1: "Is Acme Analytics the best coworking space in Lisbon?" }),
        BRAND,
      ),
    ).toThrow(/visibility_1 names the brand/);
    expect(() =>
      parseStarterPrompts(
        reply({ visibility_3: "How good is Acme for freelancers in Lisbon?" }),
        BRAND,
      ),
    ).toThrow(/visibility_3 names the brand/);
  });

  it("refuses a brand-free comparison that names the brand", () => {
    expect(() =>
      parseStarterPrompts(
        reply({
          comparison: "How does Acme Analytics compare with other Lisbon coworking spaces?",
        }),
        BRAND,
      ),
    ).toThrow(/comparison names the brand/);
  });

  it("refuses a brand-naming comparison that does not name it, so it would count", () => {
    expect(() =>
      parseStarterPrompts(
        reply({ comparison_naming_brand: "What are the alternatives to coworking in Lisbon?" }),
        BRAND,
      ),
    ).toThrow(/comparison_naming_brand does not name the brand/);
  });

  it("counts a short brand name as named even where the statistics rule skips it", () => {
    const short = { name: "Qi", variants: [] };
    const named = reply({
      comparison_naming_brand: "Are there better alternatives than Qi for desks in Lisbon?",
    });
    expect(parseStarterPrompts(named, short)[4]?.text).toContain("Qi");
  });

  it("refuses instructions to the assistant: stored questions stay natural", () => {
    for (const text of [
      "Search the web and list coworking spaces in Lisbon for freelancers?",
      "You must use Google Search: which Lisbon coworking spaces are best?",
      "Which Lisbon coworking spaces are best? Cite your sources?",
    ]) {
      expect(() => parseStarterPrompts(reply({ visibility_2: text }), BRAND)).toThrow(
        /instructs the assistant/,
      );
    }
  });

  it("refuses a statement, an empty field, a runaway one and a repeat", () => {
    expect(() =>
      parseStarterPrompts(reply({ visibility_1: "List coworking spaces in Lisbon." }), BRAND),
    ).toThrow(/not a question/);
    expect(() => parseStarterPrompts(reply({ visibility_1: "   " }), BRAND)).toThrow(/characters/);
    expect(() =>
      parseStarterPrompts(reply({ visibility_1: `${"Which desk ".repeat(40)}?` }), BRAND),
    ).toThrow(/characters/);
    const same = "Which coworking spaces in Lisbon suit a freelancer who needs quiet hot desks?";
    expect(() => parseStarterPrompts(reply({ visibility_2: same.toUpperCase() }), BRAND)).toThrow(
      /repeats another question/,
    );
  });
});

describe("estimateGenerationCost", () => {
  const mid = model("gpt-mid", "openai", "mid", 2, 12);

  it("prices what the call sends plus a typical reply, at the model called", () => {
    const chars = starterGenerationChars(REQUEST);
    const expected = (Math.ceil(chars / 4) / 1e6) * 2 + (1_000 / 1e6) * 12;
    expect(estimateGenerationCost(mid, chars)).toBeCloseTo(expected, 10);
  });

  it("follows the model: a dearer one quotes more", () => {
    const chars = starterGenerationChars(REQUEST);
    const dearer = model("claude-mid", "anthropic", "mid", 3, 15);
    expect(estimateGenerationCost(dearer, chars)).toBeGreaterThan(
      estimateGenerationCost(mid, chars),
    );
  });

  it("is zero with no model to price", () => {
    expect(estimateGenerationCost(null, 5_000)).toBe(0);
  });
});

describe("the generate button", () => {
  const ready = { generating: false, hasModel: true, untouched: true, source: "template" as const };

  it("is armed on untouched templates with a model to call, and reads its cost", () => {
    expect(generateState(ready)).toBe("armed");
    expect(generateButtonLabel("armed", 0.014)).toBe("Generate custom prompts ~ $0.01 on your key");
    expect(generateButtonLabel("armed", 0.0042)).toBe(
      "Generate custom prompts ~ $0.0042 on your key",
    );
  });

  it("reads Generating while the call is out", () => {
    expect(generateState({ ...ready, generating: true })).toBe("generating");
    expect(generateButtonLabel("generating", 0.01)).toBe("Generating…");
  });

  it("ends at Prompts generated while the generated set is untouched: one shot per input set", () => {
    expect(generateState({ ...ready, source: "generated" })).toBe("generated");
    expect(generateButtonLabel("generated", 0.01)).toBe("Prompts generated");
  });

  it("needs a key, which it says, and prices nothing", () => {
    expect(generateState({ ...ready, hasModel: false })).toBe("no-key");
    expect(generateButtonLabel("no-key", 0)).toBe("Generate custom prompts");
    expect(NO_KEY_HINT).toBe("Needs a provider key. Add one in Account settings.");
  });

  it("stays shut once the list is edited by hand: the user took the manual door", () => {
    expect(generateState({ ...ready, untouched: false })).toBe("edited");
    expect(generateState({ ...ready, source: "generated", untouched: false })).toBe("edited");
    expect(generateState({ ...ready, source: "prefill" })).toBe("edited");
    expect(EDITED_HINT).toBe("You edited these prompts, so they stay as you wrote them.");
  });

  it("names the three doors in one line", () => {
    expect(THREE_DOORS_LINE).toBe(
      "These prompts are a starting point. Keep them, edit them by hand, or generate a set tailored to your brand on your own keys.",
    );
  });
});

describe("generationFailedToast", () => {
  it("gives the reason, then says the list did not change, with no final period", () => {
    expect(generationFailedToast("That OpenAI key was rejected.")).toBe(
      "That OpenAI key was rejected. Your prompts are unchanged",
    );
    expect(generationFailedToast("the provider is down")).toBe(
      "the provider is down. Your prompts are unchanged",
    );
  });
});
