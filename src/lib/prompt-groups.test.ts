import { describe, expect, it } from "vitest";
import { answerCountLabel, canonicalTag, groupByTag } from "./prompt-groups";

const p = (category: string | null, text = "q") => ({ category, text });

describe("groupByTag", () => {
  it("stacks prompts under their tag", () => {
    const groups = groupByTag([p("visibility", "a"), p("comparison", "b"), p("visibility", "c")]);
    expect(groups.map((g) => [g.tag, g.prompts.map((x) => x.text)])).toEqual([
      ["visibility", ["a", "c"]],
      ["comparison", ["b"]],
    ]);
  });

  it("puts the seeded tags first, in their seeded order", () => {
    // comparison before visibility in the input, and alphabetically too.
    const groups = groupByTag([p("comparison"), p("aardvark"), p("visibility")]);
    expect(groups.map((g) => g.tag)).toEqual(["visibility", "comparison", "aardvark"]);
  });

  it("sorts tags the user invented alphabetically, after the seeded ones", () => {
    const groups = groupByTag([p("zebra"), p("visibility"), p("apple"), p("mango")]);
    expect(groups.map((g) => g.tag)).toEqual(["visibility", "apple", "mango", "zebra"]);
  });

  it("puts untagged prompts last", () => {
    const groups = groupByTag([p(null), p("visibility"), p("zebra")]);
    expect(groups.map((g) => g.tag)).toEqual(["visibility", "zebra", null]);
  });

  it("treats a blank tag as no tag", () => {
    // The column allows "" and "   ". A group with a blank heading would look
    // like the untagged pile while sorting somewhere else entirely.
    const groups = groupByTag([p(""), p("   "), p(null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tag).toBeNull();
    expect(groups[0]!.prompts).toHaveLength(3);
  });

  it("keeps a project with one tag as a single group", () => {
    const groups = groupByTag([p("visibility"), p("visibility")]);
    expect(groups.map((g) => g.tag)).toEqual(["visibility"]);
  });

  it("loses no prompts", () => {
    const prompts = [p("a"), p(null), p("visibility"), p(""), p("a")];
    const groups = groupByTag(prompts);
    expect(groups.flatMap((g) => g.prompts)).toHaveLength(prompts.length);
  });

  it("returns nothing for nothing", () => {
    expect(groupByTag([])).toEqual([]);
  });
});

describe("canonicalTag", () => {
  it("reuses an existing spelling that differs only in case", () => {
    // The splintering this exists to stop: three groups holding one idea.
    expect(canonicalTag("Visibility", ["visibility", "comparison"])).toBe("visibility");
    expect(canonicalTag("COMPARISON", ["visibility", "comparison"])).toBe("comparison");
  });

  it("reuses an existing spelling that differs only in surrounding space", () => {
    expect(canonicalTag("  visibility  ", ["visibility"])).toBe("visibility");
  });

  it("keeps a genuinely new tag as typed, trimmed", () => {
    expect(canonicalTag("  Top of funnel ", ["visibility"])).toBe("Top of funnel");
  });

  it("does not merge tags that merely resemble each other", () => {
    // Only case and whitespace. Merging "comparison" into "comparisons" would
    // lose a distinction the user made, invisibly.
    expect(canonicalTag("comparisons", ["comparison"])).toBe("comparisons");
    expect(canonicalTag("visibility-uk", ["visibility"])).toBe("visibility-uk");
  });

  it("is null for a tag that is only whitespace", () => {
    expect(canonicalTag("   ", ["visibility"])).toBeNull();
    expect(canonicalTag("", [])).toBeNull();
  });
});

describe("answerCountLabel", () => {
  it("says how many answers, with the unit spelled out", () => {
    // "23" alone is ambiguous: runs, or answers?
    expect(answerCountLabel(23)).toBe("23 answers");
    expect(answerCountLabel(1)).toBe("1 answer");
  });

  it("says nothing has run rather than showing a zero", () => {
    // A prompt whose every task failed has told us nothing, and a bare 0 reads
    // as a measurement rather than an absence.
    expect(answerCountLabel(0)).toBe("no answers yet");
    expect(answerCountLabel(undefined)).toBe("no answers yet");
  });
});
