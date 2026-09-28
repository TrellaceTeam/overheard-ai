import { describe, it, expect } from "vitest";
import { commitEntries } from "./badge-input.logic";

describe("commitEntries", () => {
  it("adds a single trimmed entry", () => {
    expect(commitEntries([], "  Acme Analytics  ", Infinity)).toEqual(["Acme Analytics"]);
  });

  it("splits on commas and trims each fragment", () => {
    expect(
      commitEntries([], "Acme Analytics, Northwind Metrics ,Contoso Insights", Infinity),
    ).toEqual(["Acme Analytics", "Northwind Metrics", "Contoso Insights"]);
  });

  it("splits on newlines too, so a list pasted from a spreadsheet works", () => {
    expect(commitEntries([], "acme.example.com\nwww.acme.example.com\n", Infinity)).toEqual([
      "acme.example.com",
      "www.acme.example.com",
    ]);
  });

  it("ignores empty fragments", () => {
    expect(commitEntries([], " , ,Acme Analytics,", Infinity)).toEqual(["Acme Analytics"]);
  });

  it("de-duplicates case-insensitively, keeping the first casing", () => {
    expect(commitEntries(["Acme Analytics"], "acme analytics, ACME ANALYTICS", Infinity)).toEqual([
      "Acme Analytics",
    ]);
  });

  it("respects the limit and drops the overflow", () => {
    expect(commitEntries(["a", "b"], "c, d", 3)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const current = ["a"];
    const next = commitEntries(current, "b", Infinity);
    expect(next).toEqual(["a", "b"]);
    expect(current).toEqual(["a"]);
  });

  it("returns the same contents when raw is blank", () => {
    expect(commitEntries(["a"], "   ", Infinity)).toEqual(["a"]);
  });
});
