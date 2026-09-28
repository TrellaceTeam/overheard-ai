import { describe, expect, it } from "vitest";
import {
  fieldsOf,
  hasContent,
  parsePerception,
  perceptionSynthesisPrompt,
  perceptionUserPrompt,
  PERCEPTION_SECTIONS,
  type PerceptionFields,
} from "./perception-extract";

// Fixture brands are fictional. Keep them that way: no real company, domain or
// customer name in test data.

const json = (fields: Record<string, unknown>) => JSON.stringify(fields);

const FULL = {
  knows_brand: true,
  what_it_does: "Acme Analytics tracks how often a brand is named in AI assistant answers.",
  typical_customers: "Small marketing teams running their own measurement.",
  well_regarded_for: "Fast setup.",
  downsides: "Thin public documentation.",
};

describe("parsePerception", () => {
  it("reads the four fields and the recognition flag", () => {
    expect(parsePerception(json(FULL))).toEqual(FULL);
  });

  it("survives a fenced code block, which models add unprompted", () => {
    expect(parsePerception(`\`\`\`json\n${json(FULL)}\n\`\`\``)).toEqual(FULL);
  });

  it("survives commentary either side of the object", () => {
    expect(parsePerception(`Here you go:\n${json(FULL)}\nHope that helps!`)).toEqual(FULL);
  });

  it("throws when knows_brand is missing, so the caller retries once", () => {
    // knows_brand cannot be defaulted: guessing true would report a brand as
    // recognised when the assistant said the opposite.
    expect(() => parsePerception(json({ what_it_does: "something" }))).toThrow(
      /SCHEMA_VIOLATION: knows_brand/,
    );
    expect(() => parsePerception("not json at all")).toThrow(/SCHEMA_VIOLATION/);
  });

  it("treats a field that says nothing as empty", () => {
    // Models often answer the field instead of leaving it blank. Rendered as
    // content, "N/A" reads as a finding about the brand.
    const parsed = parsePerception(
      json({
        knows_brand: true,
        what_it_does: "N/A",
        typical_customers: "(not covered)",
        well_regarded_for: "  ",
        downsides: "None",
      }),
    );
    expect(parsed.what_it_does).toBe("");
    expect(parsed.typical_customers).toBe("");
    expect(parsed.well_regarded_for).toBe("");
    expect(parsed.downsides).toBe("");
  });

  it("does not mistake real content for a nothing-to-say marker", () => {
    const parsed = parsePerception(
      json({ knows_brand: true, downsides: "None of the reviews mention support quality." }),
    );
    expect(parsed.downsides).toBe("None of the reviews mention support quality.");
  });

  it("keeps every field empty when the assistant does not know the brand", () => {
    const parsed = parsePerception(json({ knows_brand: false }));
    expect(parsed.knows_brand).toBe(false);
    expect(hasContent(parsed)).toBe(false);
  });

  it("ignores a non-string field rather than rendering it", () => {
    const parsed = parsePerception(
      json({ knows_brand: true, what_it_does: { nested: "object" }, downsides: 42 }),
    );
    expect(parsed.what_it_does).toBe("");
    expect(parsed.downsides).toBe("");
  });

  it("clips a runaway field rather than storing it whole", () => {
    const parsed = parsePerception(json({ knows_brand: true, what_it_does: "x".repeat(4000) }));
    expect(parsed.what_it_does).toHaveLength(1200);
  });
});

describe("hasContent", () => {
  it("is false for a summary with nothing in any section", () => {
    expect(hasContent(parsePerception(json({ knows_brand: true })))).toBe(false);
  });

  it("is true as soon as one section says something", () => {
    expect(hasContent(parsePerception(json({ knows_brand: true, downsides: "Pricing." })))).toBe(
      true,
    );
  });
});

describe("fieldsOf", () => {
  it("reads a stored row back, with SQLite's 0 and 1 for the flag", () => {
    expect(
      fieldsOf({
        knows_brand: 0,
        what_it_does: null,
        typical_customers: null,
        well_regarded_for: null,
        downsides: null,
      }),
    ).toEqual({
      knows_brand: false,
      what_it_does: "",
      typical_customers: "",
      well_regarded_for: "",
      downsides: "",
    });
    expect(
      fieldsOf({
        knows_brand: 1,
        what_it_does: "Tracks visibility.",
        typical_customers: null,
        well_regarded_for: null,
        downsides: null,
      }).knows_brand,
    ).toBe(true);
  });
});

describe("perceptionUserPrompt", () => {
  it("names the brand, so the extractor knows which one is the subject", () => {
    // The answer mentions rivals too. Without the brand named, the extractor has
    // to guess which company the fields are about.
    const prompt = perceptionUserPrompt(
      "Acme Analytics",
      "Acme Analytics competes with Northwind Metrics.",
    );
    expect(prompt).toContain("The brand is: Acme Analytics");
    expect(prompt).toContain("Acme Analytics competes with Northwind Metrics.");
  });

  it("caps a pathological answer rather than sending it whole", () => {
    const prompt = perceptionUserPrompt("Acme Analytics", "x".repeat(50_000));
    expect(prompt.length).toBeLessThan(35_000);
  });
});

describe("perceptionSynthesisPrompt", () => {
  const fields = (patch: Partial<PerceptionFields> = {}): PerceptionFields => ({
    ...FULL,
    ...patch,
  });

  it("labels each assistant, so disagreement can be attributed", () => {
    const prompt = perceptionSynthesisPrompt("Acme Analytics", [
      { assistant: "Claude Sonnet 5", fields: fields({ typical_customers: "Enterprise." }) },
      { assistant: "Gemini 3.6 Flash", fields: fields({ typical_customers: "Mid-market." }) },
    ]);
    expect(prompt).toContain("Assistant: Claude Sonnet 5");
    expect(prompt).toContain("Assistant: Gemini 3.6 Flash");
    expect(prompt).toContain("Enterprise.");
    expect(prompt).toContain("Mid-market.");
  });

  it("marks an empty section rather than leaving a blank line", () => {
    // A blank value would read as the previous field running on.
    const prompt = perceptionSynthesisPrompt("Acme Analytics", [
      { assistant: "Claude Sonnet 5", fields: fields({ downsides: "" }) },
    ]);
    expect(prompt).toContain("Downsides: (not covered)");
  });
});

describe("PERCEPTION_SECTIONS", () => {
  it("is the four sections, in the order the dashboard reads them", () => {
    expect(PERCEPTION_SECTIONS.map((s) => s.key)).toEqual([
      "what_it_does",
      "typical_customers",
      "well_regarded_for",
      "downsides",
    ]);
  });
});
