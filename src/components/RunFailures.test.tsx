// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RunFailures } from "./RunFailures";
import type { FailedTask } from "./types";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

vi.mock("@/components/AppLink", async () => {
  const helpers = await import("./test-helpers");
  return { AppLink: helpers.StubLink };
});

const task = (over: Partial<FailedTask> = {}): FailedTask => ({
  id: "t1",
  status: "failed",
  iteration: 1,
  error: "HTTP 429 rate limit reached",
  failure_code: null,
  question_text: "Best analytics tools for startups",
  prompt_text: null,
  model_name: "Claude Haiku",
  ...over,
});

describe("RunFailures", () => {
  it("renders nothing when nothing failed", () => {
    const { container } = render(<RunFailures tasks={[]} onRetry={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("groups identical failures into one card", () => {
    render(<RunFailures tasks={[task(), task({ id: "t2" })]} onRetry={() => {}} />);
    expect(screen.getByText(/2 answers: The provider rate-limited this call/)).toBeDefined();
  });

  it("renders a coded row exactly like the legacy prose row", () => {
    render(
      <RunFailures
        tasks={[task({ error: "HTTP 429: slow down", failure_code: "HTTP:429" })]}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/1 answer: The provider rate-limited this call/)).toBeDefined();
  });

  it("offers the settings link only when the fault is the user's", () => {
    const { rerender } = render(<RunFailures tasks={[task()]} onRetry={() => {}} />);
    expect(screen.queryByText("Open Account settings")).toBeNull();
    rerender(
      <RunFailures tasks={[task({ error: "MISSING_CREDENTIAL:openai" })]} onRetry={() => {}} />,
    );
    expect(screen.getByText("Open Account settings")).toBeDefined();
  });

  it("hands the retry back to the route", () => {
    const onRetry = vi.fn();
    render(<RunFailures tasks={[task()]} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /Retry 1 failed answer/ }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows the retry locked, with the demo's reason, on a demo run", () => {
    // The demo is browse-only: if a demo run ever shows a failure, the button
    // is visible but never works.
    const onRetry = vi.fn();
    render(
      <RunFailures
        tasks={[task({ error: "TIMEOUT: no answer within 120000 ms" })]}
        onRetry={onRetry}
        locked="The demo project is read-only."
      />,
    );
    const button = screen.getByRole("button", { name: /Retry 1 failed answer/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("The demo project is read-only.");
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("lists the affected prompts behind a disclosure", () => {
    render(<RunFailures tasks={[task()]} onRetry={() => {}} />);
    expect(screen.queryByText(/Best analytics tools/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Which prompts/ }));
    expect(screen.getByText(/Best analytics tools/)).toBeDefined();
  });
});

describe("a deliberate stop", () => {
  it("is shown as a stop, with no fault chip pointing at settings", () => {
    render(
      <RunFailures
        tasks={[task({ error: "CANCELLED_BY_USER: stopped from the run page." })]}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/1 answer: You stopped this run/)).toBeDefined();
    expect(screen.getByText("You stopped it")).toBeDefined();
    expect(screen.queryByText("Open Account settings")).toBeNull();
  });
});

describe("the unreadable-answer card", () => {
  const UNREADABLE =
    "EXTRACTION_UNREADABLE: 3 readers replied in the wrong shape (last: SCHEMA_VIOLATION: answer_format)";

  it("wears no fault-owner chip, while every other card keeps its own", () => {
    render(
      <RunFailures
        tasks={[task({ id: "t1", error: UNREADABLE }), task({ id: "t2" })]}
        onRetry={() => {}}
      />,
    );
    // The rate-limit card next door keeps its chip.
    expect(screen.getByText("Provider's side")).toBeDefined();
    // The unreadable card has none, not "ours" and not anybody's.
    expect(screen.queryByText("Ours to fix")).toBeNull();
    expect(screen.queryByText("Yours to fix")).toBeNull();
    expect(screen.queryByText("You stopped it")).toBeNull();
  });

  it("says little and points at Retry", () => {
    render(<RunFailures tasks={[task({ error: UNREADABLE })]} onRetry={() => {}} />);
    expect(screen.getByText(/1 answer: We could not read this answer/)).toBeDefined();
    expect(
      screen.getByText(
        "The model that reads answers replied in a slightly different format than we asked for. It happens occasionally. Retry reads those answers again.",
      ),
    ).toBeDefined();
    // No settings link: there is nothing for the user to configure.
    expect(screen.queryByText("Open Account settings")).toBeNull();
    expect(screen.getByRole("button", { name: /Retry 1 failed answer/ })).toBeDefined();
  });

  it("keeps the schema-violation chip on a row stored without a failure code", () => {
    render(
      <RunFailures
        tasks={[task({ error: "SCHEMA_VIOLATION: no JSON object" })]}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText("Ours to fix")).toBeDefined();
  });
});
