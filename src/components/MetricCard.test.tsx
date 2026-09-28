// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MetricCard, pct } from "./MetricCard";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

describe("pct", () => {
  it("renders n/a for a missing rate, never a dash", () => {
    expect(pct(null)).toBe("n/a");
    expect(pct(undefined)).toBe("n/a");
  });

  it("rounds a rate to whole percent", () => {
    expect(pct(0.067)).toBe("7%");
  });
});

describe("MetricCard", () => {
  it("renders the label, the value and the hint", () => {
    render(<MetricCard label="Mention rate" value="42%" hint="Answers that named you" />);
    expect(screen.getByText("Mention rate")).toBeDefined();
    expect(screen.getByText("42%")).toBeDefined();
    expect(screen.getByText("Answers that named you")).toBeDefined();
  });
});
