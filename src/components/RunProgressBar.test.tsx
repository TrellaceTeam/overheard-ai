// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RunProgressBar } from "./RunProgressBar";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

describe("RunProgressBar", () => {
  it("counts in answers, not in provider calls", () => {
    render(
      <RunProgressBar
        progress={{ status: "running", plannedCalls: 20, completedCalls: 10, failedCalls: 0 }}
      />,
    );
    expect(screen.getByText("50%")).toBeDefined();
    expect(screen.getByText("5 of 10 answers collected so far.")).toBeDefined();
  });

  it("never renders an internal status name", () => {
    render(
      <RunProgressBar
        progress={{ status: "partial", plannedCalls: 20, completedCalls: 14, failedCalls: 6 }}
      />,
    );
    expect(screen.getByText("Run finished with failures")).toBeDefined();
    expect(screen.queryByText("partial")).toBeNull();
  });

  it("reconciles every outstanding answer in one sentence while running", () => {
    render(
      <RunProgressBar
        progress={{
          status: "running",
          plannedCalls: 150,
          completedCalls: 110,
          failedCalls: 8,
          fresh: 6,
          retrying: 24,
          working: 10,
        }}
      />,
    );
    // In answers the plan is 75. 16 still to come back (6 fresh, 10 working),
    // 24 being retried and 4 failed leave 31 collected: the sentence derives
    // collected from the breakdown, not from completedCalls.
    expect(
      screen.getByText(
        "31 of 75 answers collected so far: 16 still to come back, 24 being retried, 4 failed.",
      ),
    ).toBeDefined();
  });

  it("says when the run has become its own retry", () => {
    render(
      <RunProgressBar
        progress={{
          status: "running",
          plannedCalls: 24,
          completedCalls: 16,
          failedCalls: 0,
          fresh: 0,
          retrying: 4,
          working: 0,
        }}
      />,
    );
    expect(screen.getByText("Running retry")).toBeDefined();
    expect(screen.getByText("8 of 12 answers collected so far: 4 being retried.")).toBeDefined();
  });

  it("does not divide by zero when nothing is planned", () => {
    render(
      <RunProgressBar
        progress={{ status: "queued", plannedCalls: 0, completedCalls: 0, failedCalls: 0 }}
      />,
    );
    expect(screen.getByText("0%")).toBeDefined();
  });
});
