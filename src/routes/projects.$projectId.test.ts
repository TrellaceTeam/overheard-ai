// @vitest-environment jsdom
/**
 * The project layout's own decision: the tab strip, and the data-tour hooks the
 * guided tour selects on. A tab that loses its attribute strands the tour on
 * whichever step points at it.
 */
import { describe, expect, it } from "vitest";
import { TOUR_SELECTORS } from "@/components/TutorialTour";
import { TABS } from "./projects.$projectId";

describe("TABS", () => {
  it("lists the four project screens in order", () => {
    expect(TABS.map((tab) => tab.label)).toEqual([
      "Dashboard",
      "Prompts",
      "Competitors",
      "Project settings",
    ]);
  });

  it("matches only the dashboard exactly, so a child route does not light it up", () => {
    expect(TABS.filter((tab) => tab.exact).map((tab) => tab.to)).toEqual(["/projects/$projectId"]);
  });

  it("carries the four tab hooks the tour steps onto", () => {
    const hooks = TABS.map((tab) => tab.tour);
    expect(hooks).toContain(TOUR_SELECTORS.tabDashboard);
    expect(hooks).toContain(TOUR_SELECTORS.tabPrompts);
    expect(hooks).toContain(TOUR_SELECTORS.tabCompetitors);
    expect(hooks).toContain(TOUR_SELECTORS.tabSettings);
  });

  it("gives every tab a distinct path", () => {
    expect(new Set(TABS.map((tab) => tab.to)).size).toBe(TABS.length);
  });
});
