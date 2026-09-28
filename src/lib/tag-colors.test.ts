/**
 * The tag→colour mapping. The index is a pure function of the tag's canonical
 * spelling, so two fresh databases, two renders and two projects paint
 * "visibility" the same colour, and inserting or renaming other tags never
 * repaints it.
 */
import { describe, expect, it } from "vitest";
import { TAG_COLOR_COUNT, tagColorIndex } from "./tag-colors";

describe("tagColorIndex", () => {
  it("is stable: the same tag always lands on the same index", () => {
    expect(tagColorIndex("visibility")).toBe(tagColorIndex("visibility"));
    expect(tagColorIndex("comparison")).toBe(tagColorIndex("comparison"));
  });

  it("is case- and whitespace-insensitive, matching canonicalTag's dedupe rule", () => {
    expect(tagColorIndex("Visibility")).toBe(tagColorIndex("visibility"));
    expect(tagColorIndex("  VISIBILITY ")).toBe(tagColorIndex("visibility"));
  });

  it("stays inside the palette", () => {
    const tags = ["visibility", "comparison", "pricing", "support", "seo", "ads", "x", "", "a b c"];
    for (const tag of tags) {
      const index = tagColorIndex(tag);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(TAG_COLOR_COUNT);
    }
  });

  it("spreads ordinary tags over more than one colour", () => {
    const seen = new Set(
      ["visibility", "comparison", "pricing", "support", "seo", "ads", "content", "ux"].map(
        tagColorIndex,
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
