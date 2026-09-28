import { describe, expect, it } from "vitest";
import { newProjectPlan, perceptionCallsFor, planCounts } from "./run-plan";
import { CALLS_PER_ANSWER } from "./run-progress";

describe("planCounts", () => {
  it("multiplies the iterations by the assistants, and doubles the answers into calls", () => {
    expect(planCounts(5, 15, 2)).toEqual({ prompts: 5, assistants: 2, answers: 30, calls: 60 });
  });

  it("is zero answers with no assistant chosen", () => {
    expect(planCounts(5, 15, 0)).toEqual({ prompts: 5, assistants: 0, answers: 0, calls: 0 });
  });
});

describe("newProjectPlan", () => {
  const prompts = (...iterations: number[]) => iterations.map((n) => ({ iterations: n }));

  it("counts every prompt at its own iterations on every assistant", () => {
    const plan = newProjectPlan(prompts(5, 1), 2);
    expect(plan.answers).toBe(6 * 2);
    expect(plan.prompts).toBe(2);
    expect(plan.calls).toBe(plan.answers * CALLS_PER_ANSWER);
  });

  it("adds the perception question a first run asks each assistant", () => {
    const plan = newProjectPlan(prompts(5, 5, 5, 5, 5), 3);
    expect(plan.calls).toBe(150);
    expect(plan.perceptionCalls).toBe(perceptionCallsFor(3));
    expect(plan.perceptionCalls).toBe(6);
  });
});
