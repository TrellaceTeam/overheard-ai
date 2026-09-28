import { describe, expect, it } from "vitest";
import { perceptionEnabled, resolvePerceptionPrompt } from "./perception";

describe("resolvePerceptionPrompt", () => {
  it("resolves every occurrence of the token, not just the first", () => {
    // The canonical prompt names the brand three times. String.replace would
    // substitute one and leave the other two, and the settings preview would
    // disagree with what the run asked.
    const prompt = "What do you know about {brand}? What does {brand} do? Is {brand} any good?";
    expect(resolvePerceptionPrompt(prompt, "Northwind Metrics")).toBe(
      "What do you know about Northwind Metrics? What does Northwind Metrics do? Is Northwind Metrics any good?",
    );
  });

  it("leaves the token visible when there is no target brand", () => {
    // Not an empty string. "What do you know about ?" reads as a mistake in
    // the prompt; an unresolved {brand} reads as a missing brand, which is
    // what it is. The server's interpolateBrand does the same.
    const prompt = "What do you know about {brand}?";
    for (const brand of [null, undefined, "", "   "]) {
      expect(resolvePerceptionPrompt(prompt, brand)).toBe(prompt);
    }
  });

  it("trims the brand name before inserting it", () => {
    expect(resolvePerceptionPrompt("About {brand}.", "  Northwind Metrics  ")).toBe(
      "About Northwind Metrics.",
    );
  });

  it("leaves a prompt with no token alone", () => {
    const prompt = "What do you know about our company?";
    expect(resolvePerceptionPrompt(prompt, "Northwind Metrics")).toBe(prompt);
  });

  it("does not touch a token that is only nearly right", () => {
    const prompt = "About {Brand} and {brands} and {brand}.";
    expect(resolvePerceptionPrompt(prompt, "Acme")).toBe("About {Brand} and {brands} and Acme.");
  });

  it("survives a brand name that looks like the token", () => {
    // Pathological, but split/join replaces against the original string rather
    // than rescanning its own output, so this terminates and is exact.
    expect(resolvePerceptionPrompt("Hi {brand}.", "{brand}")).toBe("Hi {brand}.");
  });
});

describe("perceptionEnabled", () => {
  it("is off for a blank prompt, which is the off switch", () => {
    for (const prompt of [null, undefined, "", "   ", "\n\n"]) {
      expect(perceptionEnabled(prompt)).toBe(false);
    }
  });

  it("is on for any real prompt", () => {
    expect(perceptionEnabled("What do you know about {brand}?")).toBe(true);
  });
});
