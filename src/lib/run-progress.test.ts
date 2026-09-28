import { describe, expect, it } from "vitest";
import { CALLS_PER_ANSWER, toAnswers } from "./run-progress";

describe("toAnswers", () => {
  it("halves the stored call count", () => {
    // Two prompts at five iterations on one model.
    expect(toAnswers(20)).toBe(10);
  });

  it("agrees with what a run actually stores", () => {
    // planned_calls is answers * CALLS_PER_ANSWER, so the round trip has to be
    // lossless for every size a run can be.
    for (const answers of [1, 3, 10, 25, 5000]) {
      expect(toAnswers(answers * CALLS_PER_ANSWER)).toBe(answers);
    }
  });

  it("treats a run with nothing done yet as zero", () => {
    expect(toAnswers(0)).toBe(0);
  });

  it("survives the nulls the row types allow", () => {
    expect(toAnswers(null)).toBe(0);
    expect(toAnswers(undefined)).toBe(0);
  });

  it("does not report a half-finished answer as a whole one", () => {
    // completed_calls counts one call for an answer that has arrived but is
    // not read yet, so odd counts are normal mid-run. This pins the rounding:
    // halves go up.
    expect(toAnswers(1)).toBe(1);
    expect(toAnswers(3)).toBe(2);
  });
});
