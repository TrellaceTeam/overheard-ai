// @vitest-environment jsdom
/**
 * The prompt library's own rules: the filter strip, where "Untagged" is a tag
 * choice and not the absence of one, the twin hint, and when the new-prompt
 * form may submit.
 */
import { describe, expect, it } from "vitest";
import {
  ALL,
  UNTAGGED,
  canAddPrompt,
  identicalInactiveIds,
  matchesFilters,
  Route,
} from "./projects.$projectId.prompts";
import type { PromptFilters } from "./projects.$projectId.prompts";

const ANY: PromptFilters = { status: "all", tag: ALL, answers: "all" };

const active = { category: "visibility", is_active: 1 };
const paused = { category: "visibility", is_active: 0 };
const untagged = { category: null, is_active: 1 };
const blankTag = { category: "   ", is_active: 1 };

describe("matchesFilters", () => {
  it("lets everything through by default", () => {
    expect(matchesFilters(active, 0, ANY)).toBe(true);
    expect(matchesFilters(paused, 0, ANY)).toBe(true);
    expect(matchesFilters(untagged, 0, ANY)).toBe(true);
  });

  it("splits active from inactive", () => {
    expect(matchesFilters(active, 0, { ...ANY, status: "active" })).toBe(true);
    expect(matchesFilters(paused, 0, { ...ANY, status: "active" })).toBe(false);
    expect(matchesFilters(paused, 0, { ...ANY, status: "inactive" })).toBe(true);
  });

  it("matches a tag by name", () => {
    expect(matchesFilters(active, 0, { ...ANY, tag: "visibility" })).toBe(true);
    expect(matchesFilters(active, 0, { ...ANY, tag: "comparison" })).toBe(false);
  });

  it("counts a whitespace tag as untagged, the way groupByTag does", () => {
    expect(matchesFilters(blankTag, 0, { ...ANY, tag: UNTAGGED })).toBe(true);
    expect(matchesFilters(untagged, 0, { ...ANY, tag: UNTAGGED })).toBe(true);
    expect(matchesFilters(active, 0, { ...ANY, tag: UNTAGGED })).toBe(false);
  });

  it("separates prompts that have been answered from ones that have not", () => {
    expect(matchesFilters(active, 3, { ...ANY, answers: "has" })).toBe(true);
    expect(matchesFilters(active, 0, { ...ANY, answers: "has" })).toBe(false);
    expect(matchesFilters(active, 0, { ...ANY, answers: "none" })).toBe(true);
    expect(matchesFilters(active, 1, { ...ANY, answers: "none" })).toBe(false);
  });

  it("applies all three at once", () => {
    const filters: PromptFilters = { status: "active", tag: "visibility", answers: "has" };
    expect(matchesFilters(active, 2, filters)).toBe(true);
    expect(matchesFilters(paused, 2, filters)).toBe(false);
    expect(matchesFilters(active, 0, filters)).toBe(false);
  });
});

describe("route metadata", () => {
  it("names Overheard AI", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Prompts - Overheard AI"]);
  });
});

describe("identicalInactiveIds", () => {
  const row = (id: string, text: string, is_active: number) => ({ id, text, is_active });

  it("flags an inactive prompt whose text matches another, however it is cased or padded", () => {
    const ids = identicalInactiveIds([
      row("a", "best analytics tools", 1),
      row("b", "  BEST Analytics TOOLS ", 0),
      row("c", "which tool is cheapest?", 0),
    ]);
    expect([...ids]).toEqual(["b"]);
  });

  it("leaves active prompts alone, because the switch that would be refused is the off one", () => {
    const ids = identicalInactiveIds([row("a", "same question", 1), row("b", "same question", 1)]);
    expect(ids.size).toBe(0);
  });

  it("counts archived rows in the comparison: a hidden twin still blocks the switch", () => {
    const ids = identicalInactiveIds([row("a", "same question", 1), row("b", "same question", 0)]);
    expect([...ids]).toEqual(["b"]);
  });

  it("is empty for a library without twins", () => {
    expect(identicalInactiveIds([row("a", "one", 0), row("b", "two", 1)]).size).toBe(0);
  });
});

describe("canAddPrompt", () => {
  it("waits for a question and a tag, which the server requires to create one", () => {
    expect(canAddPrompt("which tool?", "visibility")).toBe(true);
    expect(canAddPrompt("which tool?", null)).toBe(false);
    expect(canAddPrompt("", "visibility")).toBe(false);
    expect(canAddPrompt("   ", "visibility")).toBe(false);
    expect(canAddPrompt("", null)).toBe(false);
  });
});
