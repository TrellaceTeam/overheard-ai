import { describe, expect, it } from "vitest";
import { trendLabels } from "./trend-labels";

describe("trendLabels", () => {
  it("uses the day alone when every run is on a different day", () => {
    const labels = trendLabels(["2026-09-20T09:00:00.000Z", "2026-09-21T09:00:00.000Z"]);
    expect(labels).toHaveLength(2);
    expect(labels[0]).not.toEqual(labels[1]);
    expect(labels[0]).not.toMatch(/:/);
  });

  it("adds the time when a day carries more than one run", () => {
    // The first trend a new user sees: several runs in one sitting. Three ticks
    // reading the same date is an axis that says nothing.
    const labels = trendLabels([
      "2026-09-22T09:00:00.000Z",
      "2026-09-22T13:30:00.000Z",
      "2026-09-22T17:45:00.000Z",
    ]);
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label).toMatch(/:/);
  });

  it("leaves the days that are unique alone when only one day repeats", () => {
    const labels = trendLabels([
      "2026-09-20T09:00:00.000Z",
      "2026-09-22T09:00:00.000Z",
      "2026-09-22T17:45:00.000Z",
    ]);
    expect(labels[0]).not.toMatch(/:/);
    expect(labels[1]).toMatch(/:/);
    expect(labels[2]).toMatch(/:/);
  });

  it("returns the raw value rather than Invalid Date", () => {
    expect(trendLabels(["not a date"])).toEqual(["not a date"]);
  });

  it("handles an empty series", () => {
    expect(trendLabels([])).toEqual([]);
  });
});
