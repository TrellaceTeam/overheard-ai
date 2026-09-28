import { describe, expect, it } from "vitest";
import { assistantChangeLine, assistantChanges } from "./assistant-changes";

const RUNS = [
  ["r1", "2026-07-01T12:00:00.000Z"],
  ["r2", "2026-07-08T12:00:00.000Z"],
  ["r3", "2026-07-15T12:00:00.000Z"],
  ["r4", "2026-07-22T12:00:00.000Z"],
] as const;

describe("assistantChanges", () => {
  it("finds nothing while every run asks the same assistants", () => {
    const same = { r1: ["a", "b"], r2: ["b", "a"], r3: ["a", "b"] };
    expect(assistantChanges(RUNS, same)).toEqual([]);
  });

  it("names the first run of each new set, with what came and went", () => {
    const changes = assistantChanges(RUNS, {
      r1: ["old", "keep"],
      r2: ["old", "keep"],
      r3: ["new", "keep"],
      r4: ["new", "keep", "extra"],
    });
    expect(changes).toEqual([
      { at: "2026-07-15T12:00:00.000Z", added: ["new"], removed: ["old"] },
      { at: "2026-07-22T12:00:00.000Z", added: ["extra"], removed: [] },
    ]);
  });

  it("skips a run with no known assistants instead of reading it as all removed", () => {
    expect(assistantChanges(RUNS, { r1: ["a"], r3: ["a"], r4: ["a"] })).toEqual([]);
  });
});

describe("assistantChangeLine", () => {
  const names: Record<string, string> = {
    a: "GPT-6 Sol",
    b: "Claude Opus 5.5",
    c: "Gemini 3.8 Flash",
    old: "GPT-5.6 Terra",
  };
  const nameOf = (id: string) => names[id] ?? id;

  it("says instead of when one set replaced another", () => {
    expect(
      assistantChangeLine({ at: "x", added: ["a"], removed: ["old"] }, nameOf, "Sep 28, 2026"),
    ).toBe("From Sep 28, 2026, runs ask GPT-6 Sol instead of GPT-5.6 Terra.");
  });

  it("lists several names the way a person would", () => {
    expect(
      assistantChangeLine({ at: "x", added: ["a", "b", "c"], removed: [] }, nameOf, "Sep 28, 2026"),
    ).toBe("From Sep 28, 2026, runs also ask GPT-6 Sol, Claude Opus 5.5 and Gemini 3.8 Flash.");
  });

  it("says what stopped being asked", () => {
    expect(
      assistantChangeLine({ at: "x", added: [], removed: ["b"] }, nameOf, "Sep 28, 2026"),
    ).toBe("From Sep 28, 2026, runs no longer ask Claude Opus 5.5.");
  });
});
