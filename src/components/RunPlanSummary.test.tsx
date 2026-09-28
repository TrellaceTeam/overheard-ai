// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RunPlanSummary, MAX_PLANNED_CALLS, planWithEstimate } from "./RunPlanSummary";
import { CALLS_PER_ANSWER } from "@/lib/run-progress";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

describe("RunPlanSummary", () => {
  it("shows answers and provider calls side by side", () => {
    render(
      <RunPlanSummary
        plan={{ answers: 10, calls: 10 * CALLS_PER_ANSWER, assistants: 2, prompts: 5 }}
      />,
    );
    expect(screen.getByText(/10 answers/)).toBeDefined();
    expect(screen.getByText(/2 assistants/)).toBeDefined();
    expect(screen.getByText(/5 prompts/)).toBeDefined();
    expect(screen.getByText(/20 provider calls/)).toBeDefined();
  });

  it("uses the singular for a run of one", () => {
    render(<RunPlanSummary plan={{ answers: 1, calls: 2, assistants: 1, prompts: 1 }} />);
    expect(screen.getByText(/from 1 assistant across 1 prompt\./)).toBeDefined();
    expect(screen.getByText("1 answer")).toBeDefined();
  });

  it("stays quiet under the ceiling", () => {
    render(
      <RunPlanSummary
        plan={{ answers: 100, calls: MAX_PLANNED_CALLS, assistants: 3, prompts: 9 }}
      />,
    );
    expect(screen.queryByText(/ceiling/)).toBeNull();
  });

  it("says nothing about perception when there is none to pay for", () => {
    render(<RunPlanSummary plan={{ answers: 10, calls: 20, assistants: 2, prompts: 5 }} />);
    expect(screen.queryByText(/already knows/)).toBeNull();
  });

  it("names the extra calls the first run spends on the perception question", () => {
    // Without this line the wizard would promise 150 calls and the run would
    // make 156.
    render(
      <RunPlanSummary
        plan={{ answers: 75, calls: 150, assistants: 3, prompts: 5, perceptionCalls: 6 }}
      />,
    );
    expect(screen.getByText(/Plus 6 calls to ask each assistant/)).toBeDefined();
  });

  it("warns once the plan passes the ceiling", () => {
    render(
      <RunPlanSummary
        plan={{ answers: 6000, calls: MAX_PLANNED_CALLS + 2, assistants: 3, prompts: 400 }}
      />,
    );
    expect(
      screen.getByText(new RegExp(`over your run size limit of ${MAX_PLANNED_CALLS} calls`)),
    ).toBeDefined();
  });

  it("shows the money sentence when the caller can price the plan", () => {
    render(
      <RunPlanSummary
        plan={{ answers: 10, calls: 20, assistants: 2, prompts: 5, estimateUsd: 3.675 }}
      />,
    );
    expect(screen.getByText(/This run will cost about/)).toBeDefined();
    expect(screen.getByText("$3.67")).toBeDefined();
  });

  it("says nothing about money when the caller cannot price the plan", () => {
    render(<RunPlanSummary plan={{ answers: 10, calls: 20, assistants: 2, prompts: 5 }} />);
    expect(screen.queryByText(/cost about/)).toBeNull();
  });
});

describe("planWithEstimate", () => {
  const plan = { answers: 30, calls: 60, assistants: 2, prompts: 3 };

  it("carries a resolved estimate onto the plan, keeping its counts", () => {
    expect(planWithEstimate(plan, 3.675)).toEqual({ ...plan, estimateUsd: 3.675 });
  });

  it("drops the dollar line for a null estimate rather than showing zero", () => {
    expect(planWithEstimate(plan, null).estimateUsd).toBeUndefined();
  });

  it("drops the dollar line while the estimate is still undefined", () => {
    expect(planWithEstimate(plan, undefined).estimateUsd).toBeUndefined();
  });

  it("renders the money sentence end to end from a resolved estimate", () => {
    render(<RunPlanSummary plan={planWithEstimate(plan, 3.675)} />);
    expect(screen.getByText(/This run will cost about/)).toBeDefined();
    expect(screen.getByText("$3.67")).toBeDefined();
  });
});
