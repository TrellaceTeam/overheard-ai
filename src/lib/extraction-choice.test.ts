import { describe, expect, it } from "vitest";
import { pickExtraction } from "./extraction-choice";

const LUNA = { id: "luna", provider: "openai" };
const FLASH = { id: "flash", provider: "google" };
const HAIKU = { id: "haiku", provider: "anthropic" };
const CANDIDATES = [LUNA, FLASH, HAIKU]; // cheapest first

describe("pickExtraction", () => {
  it("takes the preferred model when it is a candidate and its provider has a key", () => {
    expect(pickExtraction(CANDIDATES, HAIKU, ["anthropic"])).toBe(HAIKU);
  });

  it("skips a preferred model whose provider has no key", () => {
    expect(pickExtraction(CANDIDATES, HAIKU, ["openai"])).toBe(LUNA);
  });

  it("falls back to the cheapest keyed candidate with no preference", () => {
    expect(pickExtraction(CANDIDATES, null, ["google", "anthropic"])).toBe(FLASH);
    expect(pickExtraction(CANDIDATES, undefined, ["anthropic"])).toBe(HAIKU);
  });

  it("returns null when no candidate's provider has a key", () => {
    expect(pickExtraction(CANDIDATES, HAIKU, [])).toBeNull();
    expect(pickExtraction([], HAIKU, ["anthropic"])).toBeNull();
  });

  it("ignores a preference that is not among the candidates", () => {
    const retired = { id: "old", provider: "anthropic" };
    expect(pickExtraction(CANDIDATES, retired, ["openai", "anthropic"])).toBe(LUNA);
  });
});
