// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CompareMetricGrid } from "./CompareMetricGrid";
import { installDomStubs } from "./test-helpers";
import type { BrandAgg } from "./types";
import type { Agg } from "@/lib/metrics";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

beforeAll(installDomStubs);

const agg = (mention: number): Agg => ({
  answers: 10,
  mentions: mention * 10,
  ranked: 1,
  citations: 1,
  mention_rate: mention,
  rank_rate: 0.1,
  citation_rate: 0.1,
  top3_rate: 0.2,
  top_pick_share: 0.1,
  share_of_voice: 0.3,
});

const target: BrandAgg = { id: "b1", name: "Acme Analytics", agg: agg(0.4) };

describe("CompareMetricGrid", () => {
  it("renders the empty string with no competitors", () => {
    render(<CompareMetricGrid target={target} competitors={[]} />);
    expect(screen.getByText("Select competitors to compare against your brand.")).toBeDefined();
  });

  it("renders vs cards for a single competitor", () => {
    const competitors: BrandAgg[] = [{ id: "b2", name: "Northwind Metrics", agg: agg(0.6) }];
    render(<CompareMetricGrid target={target} competitors={competitors} />);
    expect(screen.getAllByText("Acme Analytics").length).toBe(3);
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
  });

  it("renders one chart card per metric for several competitors", () => {
    const competitors: BrandAgg[] = [
      { id: "b2", name: "Northwind Metrics", agg: agg(0.6) },
      { id: "b3", name: "Contoso Insights", agg: agg(0.2) },
    ];
    const { container } = render(<CompareMetricGrid target={target} competitors={competitors} />);
    expect(container.querySelectorAll(".panel").length).toBe(3);
    expect(screen.getAllByText("Mention rate").length).toBe(1);
  });
});
