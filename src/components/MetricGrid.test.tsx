// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MetricGrid } from "./MetricGrid";
import type { Agg } from "@/lib/metrics";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

const agg: Agg = {
  answers: 10,
  mentions: 4,
  ranked: 3,
  citations: 1,
  mention_rate: 0.4,
  rank_rate: 0.3,
  citation_rate: 0.1,
  top3_rate: 0.2,
  top_pick_share: 0.1,
  share_of_voice: 0.25,
};

describe("MetricGrid", () => {
  it("renders the three headline rates and nothing else", () => {
    render(<MetricGrid agg={agg} />);
    expect(screen.getByText("Mention rate")).toBeDefined();
    expect(screen.getByText("Top 3 rate")).toBeDefined();
    expect(screen.getByText("Citation rate")).toBeDefined();
    expect(screen.queryByText("Share of voice")).toBeNull();
    expect(screen.getByText("40%")).toBeDefined();
  });

  it("carries the tour attribute by default and drops it when reused", () => {
    const { container, rerender } = render(<MetricGrid agg={agg} />);
    expect(container.querySelector('[data-tour="metrics"]')).not.toBeNull();
    rerender(<MetricGrid agg={agg} tourId={null} />);
    expect(container.querySelector('[data-tour="metrics"]')).toBeNull();
  });

  it("uses the scope hint when one is given", () => {
    render(<MetricGrid agg={agg} scopeHint="Answers from Claude" />);
    expect(screen.getByText("Answers from Claude")).toBeDefined();
  });
});
