import { describe, expect, it } from "vitest";
import { errorText, stripCode } from "./error-text";

describe("stripCode", () => {
  it("removes the machine-readable prefix the server layer raises", () => {
    expect(stripCode("NO_MODELS: select at least one assistant")).toBe(
      "select at least one assistant",
    );
    expect(stripCode("BAD_DOMAIN: these do not look like domains: acme")).toBe(
      "these do not look like domains: acme",
    );
  });

  it("leaves an HTTP status line alone", () => {
    expect(stripCode("HTTP 500: upstream exploded")).toBe("HTTP 500: upstream exploded");
  });

  it("leaves ordinary prose alone", () => {
    expect(stripCode("Cancelled by user")).toBe("Cancelled by user");
    expect(stripCode("We could not reach the provider: try again")).toBe(
      "We could not reach the provider: try again",
    );
  });
});

describe("errorText", () => {
  it("shows the sentence, capitalised, without the code", () => {
    expect(errorText(new Error("NO_PROMPTS: add at least one active prompt"), "fallback")).toBe(
      "Add at least one active prompt",
    );
  });

  it("falls back when the value is not an error", () => {
    expect(errorText("boom", "Could not start the run")).toBe("Could not start the run");
    expect(errorText(undefined, "Could not start the run")).toBe("Could not start the run");
  });

  it("falls back when the message is only a code", () => {
    expect(errorText(new Error("RUN_NOT_FOUND:"), "Could not open that run")).toBe(
      "Could not open that run",
    );
  });

  it("turns a ZodError's issues JSON into the sentence a person needs", () => {
    // The shape a zod validator's thrown message carries: the issues array,
    // stringified. Pasted into a toast as is, it reads as a stack trace.
    const zod = new Error(
      JSON.stringify([
        {
          origin: "number",
          code: "too_big",
          maximum: 20,
          inclusive: true,
          path: ["iterations"],
          message: "Too big: expected number to be <=20",
        },
      ]),
    );
    expect(errorText(zod, "That did not save.")).toBe("Iterations must be at most 20.");
  });

  it("names the lower bound too, and joins several issues", () => {
    const zod = new Error(
      JSON.stringify([
        { code: "too_small", minimum: 1, path: ["iterations"], message: "Too small" },
        { code: "invalid_type", path: ["name"], message: "Required" },
      ]),
    );
    expect(errorText(zod, "That did not save.")).toBe(
      "Iterations must be at least 1. Name: Required.",
    );
  });

  it("leaves a JSON-looking message that is not an issues array alone", () => {
    expect(errorText(new Error('["not","issues"]'), "fallback")).toBe('["not","issues"]');
  });
});
