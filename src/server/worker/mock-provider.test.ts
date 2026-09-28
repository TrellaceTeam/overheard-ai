import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseStarterPrompts,
  STARTER_GENERATION_SYSTEM,
  starterGenerationUserPrompt,
} from "@/lib/starter-generation";
import { EXTRACTION_SYSTEM, parseExtraction } from "./extraction";
import {
  MOCK_BRANDS,
  MOCK_DISCOVERED_BRANDS,
  mockAnswerText,
  mockCallProvider,
  mockCitationUrl,
  mockExtractionJson,
  mockProvidersEnabled,
  mockStarterPromptsJson,
} from "./mock-provider";
import { parsePerception, PERCEPTION_SYSTEM } from "./perception-extract";
import { callProvider } from "./providers";

beforeEach(() => {
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

afterEach(() => {
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

describe("mockProvidersEnabled", () => {
  it("is off unless the variable is exactly 1", () => {
    expect(mockProvidersEnabled()).toBe(false);
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "true";
    expect(mockProvidersEnabled()).toBe(false);
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    expect(mockProvidersEnabled()).toBe(true);
  });
});

describe("the canned answer", () => {
  it("names the brands it was given, in ranked order, with one example.com link", () => {
    const text = mockAnswerText(["Acme Analytics", "Northwind Metrics"]);
    expect(text).toContain("1. Acme Analytics");
    expect(text).toContain("2. Northwind Metrics");
    expect(text).toContain("https://acme-analytics.example.com");
    expect(text).toContain("mock output");
  });

  it("names brands the project does not track, so discovery has something to find", () => {
    // With only tracked brands in the answer, a mock run would discover
    // nothing and the promote button could not be reached.
    const text = mockAnswerText(["Acme Analytics"]);
    for (const brand of MOCK_DISCOVERED_BRANDS) expect(text).toContain(brand);
  });

  it("never names a brand twice, however the project spells it", () => {
    const text = mockAnswerText(["Acme Analytics", "fabrikam labs"]);
    expect(text.match(/Fabrikam Labs/gi)).toHaveLength(1);
  });

  it("cites the project's own domain when it has one", () => {
    // A fixed link could never match a project's domains, so the mock
    // citation rate would be stuck at zero.
    const text = mockAnswerText(["Acme Analytics"], mockCitationUrl("acme.example.com"));
    expect(text).toContain("https://acme.example.com");
    expect(text).not.toContain("acme-analytics.example.com");
  });

  it("falls back to the example link when the project has no domain", () => {
    expect(mockCitationUrl(undefined)).toBe("https://acme-analytics.example.com");
    expect(mockCitationUrl("  ")).toBe("https://acme-analytics.example.com");
  });

  it("falls back to the fictional roster when no brands are supplied", () => {
    const text = mockAnswerText();
    for (const brand of MOCK_BRANDS) expect(text).toContain(brand);
  });

  it("is deterministic", () => {
    expect(mockAnswerText(["Acme Analytics"])).toBe(mockAnswerText(["Acme Analytics"]));
  });
});

describe("the canned extraction", () => {
  it("matches the answer it was given, whatever brands that answer named", () => {
    const answer = mockAnswerText(["Acme Analytics"], mockCitationUrl("acme.example.com"));
    const parsed = parseExtraction(mockExtractionJson(answer));
    expect(parsed.answer_format).toBe("ranked_list");
    expect(parsed.total_items).toBe(1 + MOCK_DISCOVERED_BRANDS.length);
    expect(parsed.brands.map((b) => b.name)).toEqual(["Acme Analytics", ...MOCK_DISCOVERED_BRANDS]);
    expect(parsed.brands.map((b) => b.position)).toEqual([1, 2, 3]);
    // Read off the answer, not off a constant.
    expect(parsed.brands[0]?.linked_url).toBe("https://acme.example.com");
    expect(parsed.brands[1]?.linked_url).toBeNull();
  });

  it("reads as prose when there is nothing to extract", () => {
    expect(parseExtraction(mockExtractionJson("nothing here")).answer_format).toBe("prose");
  });
});

describe("mockCallProvider", () => {
  it("answers the perception contract when handed the perception system prompt", async () => {
    const res = await mockCallProvider({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      system: PERCEPTION_SYSTEM,
      user: "The brand is: Acme Analytics",
      jsonMode: true,
    });
    const fields = parsePerception(res.text);
    expect(fields.knows_brand).toBe(true);
    expect(fields.what_it_does.length).toBeGreaterThan(0);
  });

  it("answers the extraction contract for a project's own extraction prompt", async () => {
    // The system prompt is editable per project, so the mock cannot key on its
    // text. Extraction is any JSON-mode call that is not perception, which is
    // matched first on its fixed prompts.
    const res = await mockCallProvider({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      system: "Count every brand named, strictly in JSON.",
      user: "Answer to extract from:\n---\n1. Acme Analytics is a reasonable choice for this.\n---",
      jsonMode: true,
    });
    const parsed = parseExtraction(res.text);
    expect(parsed.brands.map((b) => b.name)).toContain("Acme Analytics");
  });

  it("answers the extraction contract when handed the extraction system prompt", async () => {
    const answer = mockAnswerText();
    const res = await mockCallProvider({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      system: EXTRACTION_SYSTEM,
      user: answer,
      jsonMode: true,
    });
    expect(parseExtraction(res.text).brands).toHaveLength(
      MOCK_BRANDS.length + MOCK_DISCOVERED_BRANDS.length,
    );
  });

  it("answers starter prompt generation, recognised by its fixed system prompt, with the five", async () => {
    // A JSON-mode call like extraction, so the fixed prompt has to win over
    // the extraction fallback.
    const user = starterGenerationUserPrompt({
      brandName: "Acme Analytics",
      category: "web analytics",
      description: "",
      variants: [],
      competitors: [],
    });
    const res = await mockCallProvider({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      system: STARTER_GENERATION_SYSTEM,
      user,
      jsonMode: true,
    });
    const prompts = parseStarterPrompts(res.text, { name: "Acme Analytics", variants: [] });
    expect(prompts.map((prompt) => prompt.text)).toEqual([
      "Which options for web analytics do small teams recommend this year?",
      "What should a first-time buyer shortlist when choosing web analytics?",
      "Which options for web analytics give the best value on a small budget?",
      "How do the leading options for web analytics compare on price and support?",
      "Are there better alternatives than Acme Analytics for web analytics?",
    ]);
    expect(res.searchCalls).toBe(0);
  });

  it("generates the same five for the same brand and category, every time", () => {
    const user = "Brand: Northwind Metrics\nCategory: CRM software";
    expect(mockStarterPromptsJson(user)).toBe(mockStarterPromptsJson(user));
    expect(mockStarterPromptsJson(user)).toContain("alternatives than Northwind Metrics");
  });

  it("falls back to a fictional brand and category when the call names none", () => {
    const prompts = parseStarterPrompts(mockStarterPromptsJson("Category: not given"), {
      name: "Acme Analytics",
      variants: [],
    });
    expect(prompts[0]?.text).toContain("analytics software");
  });

  it("reports one simulated search on an answer, since every answer must search", async () => {
    const res = await mockCallProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      system: "You are a helpful assistant",
      user: "Which tool should I buy?",
      jsonMode: false,
    });
    // Priced at nothing by costOf in mock mode, so the demo still costs nothing.
    expect(res.searchCalls).toBe(1);
    expect(res.outputTokens).toBeGreaterThan(0);
    expect(res.stopReason).toBe("end_turn");
  });
});

describe("callProvider in mock mode", () => {
  it("returns canned text without touching the network", async () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    // No fetch stub: a live call would throw or hang, so a clean resolve shows
    // the seam answers before any request is built.
    const res = await callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "unused",
      system: "You are a helpful assistant",
      user: "Which tool should I buy?",
      jsonMode: false,
      webSearch: true,
    });
    expect(res.text).toContain("mock output");
  });
});
