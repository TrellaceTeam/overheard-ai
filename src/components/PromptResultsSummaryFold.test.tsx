// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  askLabel,
  feedDisclosure,
  PromptResultsSummaryFold,
  type PromptResultsFoldRow,
} from "./PromptResultsSummaryFold";
import { installDomStubs } from "./test-helpers";

afterEach(cleanup);

beforeAll(installDomStubs);

/** Eighty answers over four runs, of which the budget reads fifty from three. */
const unasked: PromptResultsFoldRow = {
  promptId: "q1",
  totalAnswers: 80,
  feed: { runCount: 3, answerCount: 50 },
  costUsd: 0.1018,
  saved: null,
  outdated: null,
};

const saved = {
  summary: "30 of the 50 answers recommend Acme Analytics; Northwind Metrics gained ground.",
  runCount: 3,
  answerCount: 50,
  totalAnswers: 80,
  createdAt: "2026-09-25T01:00:00.000Z",
};

function openFold() {
  fireEvent.click(screen.getByRole("button", { name: /Prompt results summary/ }));
}

describe("feedDisclosure", () => {
  it("names the runs and the answers the summary reads", () => {
    expect(feedDisclosure({ runCount: 3, answerCount: 50, totalAnswers: 80 })).toBe(
      "Summarizes the last 3 runs of this prompt (50 of 80 answers)",
    );
  });

  it("reads naturally for a single run and a single answer", () => {
    expect(feedDisclosure({ runCount: 1, answerCount: 1, totalAnswers: 1 })).toBe(
      "Summarizes the last run of this prompt (1 of 1 answer)",
    );
  });
});

describe("askLabel", () => {
  it("puts the count it reads and the rough cost on the button", () => {
    expect(askLabel(50, 0.1018, false)).toBe("Summarize 50 answers, about $0.10");
    expect(askLabel(62, 0.0023, true)).toBe("Re-ask 62 answers, about $0.0023");
  });

  it("leaves the price out when there is nothing to price, and stays singular for one answer", () => {
    expect(askLabel(1, 0, false)).toBe("Summarize 1 answer");
  });
});

describe("PromptResultsSummaryFold", () => {
  it("starts folded, and opens onto what it would read and what asking costs", () => {
    render(<PromptResultsSummaryFold row={unasked} onAsk={() => {}} />);
    expect(screen.queryByRole("button", { name: /Summarize 50 answers/ })).toBeNull();

    openFold();

    expect(
      screen.getByText("Summarizes the last 3 runs of this prompt (50 of 80 answers)"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Summarize 50 answers, about $0.10" })).toBeDefined();
    expect(screen.queryByText(/Outdated summary/)).toBeNull();
  });

  it("explains the newest-first budget behind an info button", async () => {
    render(<PromptResultsSummaryFold row={unasked} onAsk={() => {}} />);
    openFold();

    await act(async () => {
      screen.getByRole("button", { name: "How the answers are chosen" }).focus();
    });

    const rule = screen.getByRole("tooltip").textContent;
    expect(rule).toMatch(/newest run first, until it has about 400,000 characters/);
    expect(rule).toMatch(/oldest runs are left out first/);
  });

  it("shows the stored paragraph under what it read when it was written, with a quiet re-ask", () => {
    const row = { ...unasked, feed: { runCount: 3, answerCount: 50 }, saved };
    render(<PromptResultsSummaryFold row={row} onAsk={() => {}} />);
    openFold();

    expect(screen.getByText(saved.summary)).toBeDefined();
    expect(
      screen.getByText("Summarizes the last 3 runs of this prompt (50 of 80 answers)"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /^Re-ask 50 answers/ })).toBeDefined();
    expect(screen.getByText(/never counted in statistics/)).toBeDefined();
    expect(screen.queryByText(/Outdated summary/)).toBeNull();
  });

  it("flags an outdated summary while folded, and offers the re-ask with the new count", () => {
    const row: PromptResultsFoldRow = {
      ...unasked,
      totalAnswers: 92,
      feed: { runCount: 4, answerCount: 62 },
      costUsd: 0.1234,
      saved,
      outdated: { newAnswers: 12 },
    };
    render(<PromptResultsSummaryFold row={row} onAsk={() => {}} />);
    expect(screen.getByText("Outdated summary")).toBeDefined();

    openFold();

    expect(screen.getByText("12 new answers since it was written.")).toBeDefined();
    // The disclosure still describes the stored paragraph, not the new pile.
    expect(
      screen.getByText("Summarizes the last 3 runs of this prompt (50 of 80 answers)"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Re-ask 62 answers, about $0.12" })).toBeDefined();
  });

  it("says a run finished since, when no answer was added to count", () => {
    const row = { ...unasked, saved, outdated: { newAnswers: 0 } };
    render(<PromptResultsSummaryFold row={row} onAsk={() => {}} />);
    openFold();

    expect(
      screen.getByText("A run finished with answers for this prompt since it was written."),
    ).toBeDefined();
  });

  it("asks once per click", () => {
    const onAsk = vi.fn();
    render(<PromptResultsSummaryFold row={unasked} onAsk={onAsk} />);
    openFold();

    fireEvent.click(screen.getByRole("button", { name: /Summarize 50 answers/ }));

    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("spins and ignores clicks while its call is in flight", () => {
    const onAsk = vi.fn();
    render(<PromptResultsSummaryFold row={unasked} busy onAsk={onAsk} />);
    openFold();

    const button = screen.getByRole("button", { name: /Summarizing/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("locks the button with the reason on the demo project", () => {
    render(
      <PromptResultsSummaryFold
        row={unasked}
        locked="The demo project is browse-only."
        onAsk={() => {}}
      />,
    );
    openFold();

    const button = screen.getByRole("button", { name: /Summarize 50 answers/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("The demo project is browse-only.");
  });
});
