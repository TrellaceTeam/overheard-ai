// @vitest-environment jsdom
/**
 * The dashboard's own decisions: the pure functions it exports and its route
 * metadata. Everything else on the screen is library code (applyFilter,
 * aggregateBrand, runOutcome) wired to components, each tested where it lives.
 */
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_KEY,
  mockExcludedNotice,
  nextAssistants,
  planFix,
  Route,
  runRowBadges,
  trendEmptyText,
} from "./projects.$projectId.index";

const ALL = ["anthropic", "openai", "google"];

describe("nextAssistants", () => {
  it("turns one off from the unfiltered state by listing the rest", () => {
    expect(nextAssistants(ALL, null, "google", false)).toEqual(["anthropic", "openai"]);
  });

  it("collapses back to null once everything is on again", () => {
    expect(nextAssistants(ALL, ["anthropic", "openai"], "google", true)).toBeNull();
  });

  it("does not add the same provider twice", () => {
    expect(nextAssistants(ALL, ["anthropic"], "anthropic", true)).toEqual(["anthropic"]);
  });

  it("can select nothing, which is not the same as selecting everything", () => {
    let selection = nextAssistants(ALL, null, "google", false);
    selection = nextAssistants(ALL, selection, "openai", false);
    selection = nextAssistants(ALL, selection, "anthropic", false);
    expect(selection).toEqual([]);
  });

  it("stays null with no assistants known yet, so a later one is included", () => {
    expect(nextAssistants([], null, "openai", true)).toEqual(["openai"]);
  });
});

describe("runRowBadges", () => {
  it("leaves an ordinary measured run bare", () => {
    expect(runRowBadges({ perceptionOnly: false, mock: false })).toEqual([]);
  });

  it("marks a canned run, so it is not read as a measurement", () => {
    expect(runRowBadges({ perceptionOnly: false, mock: true })).toEqual([
      { label: "Mock", tone: "warn" },
    ]);
  });

  it("marks the perception row, which otherwise says only 3/3 answers", () => {
    expect(runRowBadges({ perceptionOnly: true, mock: false })).toEqual([
      { label: "Perception check", tone: "muted" },
    ]);
  });

  it("carries both when the demo path made a perception run", () => {
    expect(runRowBadges({ perceptionOnly: true, mock: true }).map((b) => b.label)).toEqual([
      "Perception check",
      "Mock",
    ]);
  });
});

describe("mockExcludedNotice", () => {
  it("says nothing while nothing was dropped", () => {
    expect(mockExcludedNotice(undefined)).toBeNull();
    expect(mockExcludedNotice(null)).toBeNull();
    expect(mockExcludedNotice({ mockExcluded: false })).toBeNull();
  });

  it("explains a mock run that is in the list below but not in the cards", () => {
    // The run is still in the Runs list, so without a notice the cards look
    // wrong.
    const notice = mockExcludedNotice({ mockExcluded: true });
    expect(notice).toContain("mock providers");
    expect(notice).toContain("left out");
  });
});

describe("trendEmptyText", () => {
  const scored = { runsPending: false, runsError: false, completedRuns: 2, filterNotice: null };

  it("does not blame a filter when none is narrowing the page", () => {
    // Completed runs with nothing in them that counts, and no filter set.
    expect(trendEmptyText({ ...scored, runsInScope: 0 })).toBe("No statistics to show yet.");
  });

  it("names the filter when one emptied the page", () => {
    const notice = "No runs in the last 7 days.";
    expect(trendEmptyText({ ...scored, runsInScope: 0, filterNotice: notice })).toBe(notice);
  });
});

describe("planFix", () => {
  it("sends a project with no assistant to the Runner on the Prompts tab", () => {
    expect(planFix(new Error("NO_MODELS: select at least one assistant"))).toBe("prompts");
  });

  it("sends an empty prompt library to the Prompts tab", () => {
    expect(planFix(new Error("NO_PROMPTS: add at least one active prompt"))).toBe("prompts");
  });

  it("sends a plan over the call ceiling to the app Settings run size limit", () => {
    expect(
      planFix(
        new Error(
          "RUN_TOO_LARGE: this run plans 1,040 provider calls. Your run size limit is 1,000. Raise it in Account settings, or switch off prompts or assistants",
        ),
      ),
    ).toBe("limit");
  });

  it("offers nowhere to go for a refusal it does not recognise", () => {
    expect(planFix(new Error("Failed to fetch"))).toBeNull();
    expect(planFix(undefined)).toBeNull();
  });
});

describe("route metadata", () => {
  it("names Overheard AI and nothing else", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Visibility dashboard - Overheard AI"]);
  });

  it("keeps the attribution flag out of any per project key", () => {
    // One dismissal for the install, not one per project. ADR 0004 allows one
    // dismissible attribution line.
    expect(ATTRIBUTION_KEY).toBe("overheard:attribution-dismissed");
  });
});
