// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CompareTrend, SERIES_COLORS, seriesColor } from "./CompareTrend";
import { installDomStubs } from "./test-helpers";
import type { ComparePoint, CompareSeries } from "./types";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

beforeAll(installDomStubs);

const series: CompareSeries[] = [{ key: "acme", label: "Acme Analytics", color: seriesColor(0) }];

describe("CompareTrend", () => {
  it("renders the empty string for a single point", () => {
    const data: ComparePoint[] = [{ date: "2026-09-01", acme: 40 }];
    render(<CompareTrend data={data} series={series} />);
    expect(screen.getByText("Two completed runs are needed before a trend appears.")).toBeDefined();
  });

  it("renders the empty string when no series are selected", () => {
    const data: ComparePoint[] = [
      { date: "2026-09-01", acme: 40 },
      { date: "2026-09-08", acme: 45 },
    ];
    render(<CompareTrend data={data} series={[]} empty="Pick a brand." />);
    expect(screen.getByText("Pick a brand.")).toBeDefined();
  });

  it("mounts the chart once there are two points", () => {
    const data: ComparePoint[] = [
      { date: "2026-09-01", acme: 40 },
      { date: "2026-09-08", acme: 45 },
    ];
    const { container } = render(<CompareTrend data={data} series={series} />);
    expect(container.querySelector(".panel")).not.toBeNull();
    expect(screen.queryByText(/Two completed runs/)).toBeNull();
  });
});

describe("seriesColor", () => {
  it("is a theme token, never a raw hex", () => {
    expect(seriesColor(0)).toBe("var(--chart-1)");
    expect(SERIES_COLORS.every((c) => c.startsWith("var(--"))).toBe(true);
  });

  it("never hands a second brand the colour of the first", () => {
    // Cycling the ramp would paint the sixth brand in your own brand's green.
    expect(seriesColor(SERIES_COLORS.length)).toBe("var(--chart-other)");
    expect(seriesColor(SERIES_COLORS.length + 3)).toBe("var(--chart-other)");
  });
});
