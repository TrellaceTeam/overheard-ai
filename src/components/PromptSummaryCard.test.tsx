// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PromptSummaryCard, summarizeLabel, type PromptSummaryRow } from "./PromptSummaryCard";

afterEach(cleanup);

const row: PromptSummaryRow = {
  promptId: "q1",
  promptText: "best analytics tools",
  answerCount: 10,
  feedCount: 10,
  costUsd: 0.0023,
  saved: null,
};

describe("summarizeLabel", () => {
  it("puts the rough cost on the button before any spend", () => {
    expect(summarizeLabel(10, 0.0023, false)).toBe("Summarize 10 answers, about $0.0023");
    expect(summarizeLabel(10, 0.0023, true)).toBe("Re-ask 10 answers, about $0.0023");
  });

  it("leaves the price out when there is nothing to price", () => {
    // The mock seam bills nothing, and a button saying "about $0.00" would
    // still read as a charge.
    expect(summarizeLabel(4, 0, false)).toBe("Summarize 4 answers");
  });

  it("stays singular for one answer", () => {
    expect(summarizeLabel(1, 0.001, false)).toBe("Summarize 1 answer, about $0.0010");
  });
});

describe("PromptSummaryCard", () => {
  it("offers the summary with its cost while nothing is stored", () => {
    render(<PromptSummaryCard row={row} onSummarize={() => {}} />);
    expect(screen.getByText("best analytics tools")).toBeDefined();
    expect(screen.getByText("10 answers in this run")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Summarize 10 answers, about \$0.0023/ }),
    ).toBeDefined();
    expect(screen.queryByText(/Written/)).toBeNull();
  });

  it("shows the stored summary in the button's place, with a way to ask again", () => {
    const saved = {
      summary: "8 of 10 answers recommend Acme; two prefer Globex.",
      answerCount: 10,
      createdAt: "2026-09-25T01:00:00.000Z",
    };
    render(<PromptSummaryCard row={{ ...row, saved }} onSummarize={() => {}} />);
    expect(screen.getByText(saved.summary)).toBeDefined();
    expect(screen.getByRole("button", { name: /Re-ask/ })).toBeDefined();
    // The counting rule is explained where it matters (the Prompts tab's fold),
    // not repeated on every card of the run page.
    expect(screen.queryByText(/never counted in statistics/)).toBeNull();
    expect(screen.getByText(/^Written /)).toBeDefined();
    // The first-ask button is gone: one card, one action.
    expect(screen.queryByRole("button", { name: /^Summarize/ })).toBeNull();
  });

  it("says when the stored summary was built from fewer answers than the run now has", () => {
    const saved = {
      summary: "Earlier pass.",
      answerCount: 4,
      createdAt: "2026-09-25T01:00:00.000Z",
    };
    render(<PromptSummaryCard row={{ ...row, saved }} onSummarize={() => {}} />);
    expect(screen.getByText(/summarized from 4/)).toBeDefined();
  });

  it("promises only the answers a summary would read, and says so", () => {
    render(
      <PromptSummaryCard row={{ ...row, answerCount: 60, feedCount: 50 }} onSummarize={() => {}} />,
    );
    expect(screen.getByText("60 answers in this run · a summary reads the first 50")).toBeDefined();
    expect(screen.getByRole("button", { name: /^Summarize 50 answers/ })).toBeDefined();
  });

  it("disables and explains on the demo project", () => {
    render(
      <PromptSummaryCard
        row={row}
        locked="The demo project is browse-only."
        onSummarize={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: /Summarize/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("The demo project is browse-only.");
  });

  it("spins while its call is in flight and fires the callback once", () => {
    const onSummarize = vi.fn();
    render(<PromptSummaryCard row={row} busy onSummarize={onSummarize} />);
    const button = screen.getByRole("button", { name: /Summarizing/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onSummarize).not.toHaveBeenCalled();
  });
});
