import { describe, it, expect } from "vitest";
import {
  COMPETITOR_TABLE_LIMIT,
  hiddenDiscoveredSentence,
  rankByMention,
  selectVisibleCompetitors,
} from "./competitor-list";
import type { BrandRole, CompetitorRow } from "@/components/types";
import type { Agg } from "@/lib/metrics";

const agg = (over: Partial<Agg> = {}): Agg => ({
  answers: 8,
  mentions: 2,
  ranked: 1,
  citations: 0,
  mention_rate: 0.25,
  rank_rate: 0.125,
  citation_rate: 0,
  top3_rate: 0.125,
  top_pick_share: 0,
  share_of_voice: 0.4,
  ...over,
});

const row = (id: string, name: string, role: BrandRole, rate: number | null): CompetitorRow => ({
  brand: { id, name, role },
  agg: agg({ mention_rate: rate }),
});

/** Fifteen discovered rivals, rates 15% down to 1%, plus fixtures per test. */
const discoveredFifteen = (): CompetitorRow[] =>
  Array.from({ length: 15 }, (_, i) =>
    row(`d${i + 1}`, `Discovered ${String.fromCharCode(65 + i)}`, "discovered", (15 - i) / 100),
  );

describe("rankByMention", () => {
  it("orders by mention rate, most mentioned first", () => {
    const ranked = rankByMention([
      row("a", "Low", "discovered", 0.1),
      row("b", "High", "discovered", 0.9),
      row("c", "Mid", "discovered", 0.5),
    ]);
    expect(ranked.map((r) => r.brand.name)).toEqual(["High", "Mid", "Low"]);
  });

  it("breaks ties by name so two screens cannot order them differently", () => {
    const ranked = rankByMention([
      row("a", "Zephyr", "discovered", 0.5),
      row("b", "Acme", "discovered", 0.5),
    ]);
    expect(ranked.map((r) => r.brand.name)).toEqual(["Acme", "Zephyr"]);
  });

  it("puts brands with no measured rate last", () => {
    const ranked = rankByMention([
      row("a", "Unmeasured", "discovered", null),
      row("b", "Measured", "discovered", 0.01),
    ]);
    expect(ranked.map((r) => r.brand.name)).toEqual(["Measured", "Unmeasured"]);
  });
});

describe("selectVisibleCompetitors", () => {
  it("shows everything when the list is under the cap", () => {
    const rows = [
      row("t", "Your Brand", "target", 0.8),
      row("c1", "Tracked One", "competitor", 0.5),
      ...discoveredFifteen().slice(0, 5),
    ];
    const { visible, shownDiscovered, hiddenDiscovered } = selectVisibleCompetitors(rows);
    expect(visible).toHaveLength(rows.length);
    expect(shownDiscovered).toBe(5);
    expect(hiddenDiscovered).toBe(0);
  });

  it("caps discovered at the limit minus the tracked rows, and names what it hid", () => {
    const rows = [
      row("c1", "Tracked One", "competitor", 0.02),
      row("c2", "Tracked Two", "competitor", 0.01),
      ...discoveredFifteen(),
    ];
    const { visible, shownDiscovered, hiddenDiscovered } = selectVisibleCompetitors(rows);
    // Two tracked hold two of the ten places; the top eight discovered fill
    // the rest, whatever the tracked rates are.
    expect(visible).toHaveLength(10);
    expect(shownDiscovered).toBe(8);
    expect(hiddenDiscovered).toBe(7);
    expect(visible.some((r) => r.brand.name === "Tracked One")).toBe(true);
    expect(visible.some((r) => r.brand.name === "Discovered A")).toBe(true);
    expect(visible.some((r) => r.brand.name === "Discovered I")).toBe(false);
  });

  it("never hides a tracked competitor, however low its rate", () => {
    const rows = [row("c1", "Tracked Bottom", "competitor", 0), ...discoveredFifteen()];
    const { visible } = selectVisibleCompetitors(rows);
    expect(visible.some((r) => r.brand.name === "Tracked Bottom")).toBe(true);
  });

  it("shows every tracked competitor even when they alone exceed the limit", () => {
    const tracked = Array.from({ length: 12 }, (_, i) =>
      row(`c${i}`, `Tracked ${i}`, "competitor", i / 100),
    );
    const rows = [...tracked, ...discoveredFifteen()];
    const { visible, shownDiscovered, hiddenDiscovered } = selectVisibleCompetitors(rows);
    expect(visible).toHaveLength(12);
    expect(shownDiscovered).toBe(0);
    expect(hiddenDiscovered).toBe(15);
  });

  it("always keeps your own brand", () => {
    const rows = [row("t", "Your Brand", "target", 0.001), ...discoveredFifteen()];
    const { visible } = selectVisibleCompetitors(rows);
    expect(visible.some((r) => r.brand.name === "Your Brand")).toBe(true);
    // Target plus ten discovered places.
    expect(visible).toHaveLength(11);
  });

  it("returns the visible rows in ranking order", () => {
    const rows = [row("c1", "Tracked One", "competitor", 0.02), ...discoveredFifteen()];
    const { visible } = selectVisibleCompetitors(rows);
    const rates = visible.map((r) => r.agg.mention_rate ?? -1);
    expect(rates).toEqual([...rates].sort((a, b) => b - a));
  });

  it("defaults to the shipped limit of ten places", () => {
    expect(COMPETITOR_TABLE_LIMIT).toBe(10);
  });

  it("honours a smaller limit, tracked still eating the places", () => {
    const rows = [row("c1", "Tracked One", "competitor", 0.02), ...discoveredFifteen()];
    const { visible, shownDiscovered, hiddenDiscovered } = selectVisibleCompetitors(rows, 3);
    expect(visible).toHaveLength(3);
    expect(shownDiscovered).toBe(2);
    expect(hiddenDiscovered).toBe(13);
  });
});

describe("hiddenDiscoveredSentence", () => {
  it("is silent when nothing was hidden", () => {
    expect(hiddenDiscoveredSentence(5, 0)).toBeNull();
    expect(hiddenDiscoveredSentence(0, 0)).toBeNull();
  });

  it("names the shown and total counts and points at the Competitors tab", () => {
    expect(hiddenDiscoveredSentence(8, 7)).toBe(
      "Showing the top 8 of 15 discovered competitors; the rest are in the Competitors tab.",
    );
  });

  it('never says "top 0" when tracked competitors took every place', () => {
    expect(hiddenDiscoveredSentence(0, 15)).toBe(
      "Every place is taken by a tracked competitor. The 15 discovered ones are in the Competitors tab.",
    );
    expect(hiddenDiscoveredSentence(0, 1)).toBe(
      "Every place is taken by a tracked competitor. The 1 discovered one is in the Competitors tab.",
    );
  });
});
