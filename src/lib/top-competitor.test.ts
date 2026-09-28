import { describe, it, expect } from "vitest";
import { rankCandidates, topCandidate, type PresenceRow } from "./top-competitor";

const brand = (id: string, name = id) => ({ id, name });

/** A run-wide row; `top3` is how many of its `answers` placed the brand in the top three. */
const row = (brand_id: string | null, mentions: number, top3 = 0, answers = 10): PresenceRow => ({
  brand_id,
  mentions,
  answers,
  top3_rate: top3 / answers,
});

describe("topCandidate", () => {
  it("picks the most-mentioned rival", () => {
    const picked = topCandidate(
      [brand("a"), brand("b"), brand("c")],
      [row("a", 3), row("b", 9), row("c", 5)],
    );
    expect(picked?.id).toBe("b");
  });

  it("breaks a tie on mentions by top-3 placements", () => {
    const picked = topCandidate([brand("a"), brand("b")], [row("a", 4, 1), row("b", 4, 3)]);
    expect(picked?.id).toBe("b");
  });

  it("recovers placements from rates rounded to four places", () => {
    // 2 of 3 answers is stored as 0.6667. Unrounded, a's 2.0001 would beat b's
    // 2 on placement; rounded, they tie and the name decides.
    const picked = topCandidate(
      [brand("a", "Beta"), brand("b", "Alpha")],
      [
        { brand_id: "a", mentions: 3, answers: 3, top3_rate: 0.6667 },
        { brand_id: "b", mentions: 3, answers: 2, top3_rate: 1 },
      ],
    );
    expect(picked?.id).toBe("b");
  });

  it("is stable when nothing separates two brands", () => {
    const forwards = topCandidate([brand("z", "Zeta"), brand("a", "Alpha")], []);
    const backwards = topCandidate([brand("a", "Alpha"), brand("z", "Zeta")], []);
    expect(forwards?.id).toBe("a");
    expect(backwards?.id).toBe("a");
  });

  it("still answers when no rows exist at all, a hand-typed competitor counts", () => {
    expect(topCandidate([brand("a", "Acme")], [])?.id).toBe("a");
  });

  it("is null with no candidates, whatever the rows say", () => {
    expect(topCandidate([], [row("a", 12)])).toBeNull();
  });

  it("ignores rows belonging to brands that are not candidates", () => {
    // The dashboard hands it every row it holds, target brand included.
    const picked = topCandidate([brand("a")], [row("target", 99), row("a", 1)]);
    expect(picked?.id).toBe("a");
  });

  it("ignores rows with no brand", () => {
    expect(topCandidate([brand("a")], [row(null, 99), row("a", 2)])?.id).toBe("a");
  });
});

describe("rankCandidates", () => {
  it("sums a brand's rows rather than reading one of them", () => {
    // The dashboard's rows are per model and per prompt, so one brand has many.
    const order = rankCandidates(
      [brand("a"), brand("b")],
      [row("a", 2), row("a", 2), row("a", 2), row("b", 5)],
    );
    expect(order.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("sums top-3 placements across a brand's rows", () => {
    const order = rankCandidates(
      [brand("lucky"), brand("solid")],
      [row("lucky", 5, 1), row("lucky", 5, 0), row("solid", 10, 2)],
    );
    expect(order.map((b) => b.id)).toEqual(["solid", "lucky"]);
  });

  it("returns every candidate, not just the winner", () => {
    expect(rankCandidates([brand("a"), brand("b")], []).length).toBe(2);
  });

  it("does not mutate the array it was given", () => {
    const candidates = [brand("z", "Zeta"), brand("a", "Alpha")];
    rankCandidates(candidates, []);
    expect(candidates.map((b) => b.id)).toEqual(["z", "a"]);
  });
});

describe("a short run where mentions tie", () => {
  it("separates five brands that all tie on mentions", () => {
    // A four-answer run cannot spread mentions far, so rivals land on two
    // apiece. Mentions alone would fall through to the name, and the alphabet
    // would pick Contoso Insights.
    const brands = [
      brand("northwind", "Northwind Metrics"),
      brand("globex", "Globex Search"),
      brand("contoso", "Contoso Insights"),
      brand("fabrikam", "Fabrikam Labs"),
      brand("initech", "Initech Reports"),
    ];
    const rows = [
      row("northwind", 2, 2, 4),
      row("globex", 2, 1, 4),
      row("contoso", 2, 0, 4),
      row("fabrikam", 2, 1, 4),
      row("initech", 1, 1, 4),
    ];
    expect(topCandidate(brands, rows)?.name).toBe("Northwind Metrics");
    expect(rankCandidates(brands, rows).map((b) => b.name)).toEqual([
      "Northwind Metrics",
      "Fabrikam Labs",
      "Globex Search",
      "Contoso Insights",
      "Initech Reports",
    ]);
  });
});
