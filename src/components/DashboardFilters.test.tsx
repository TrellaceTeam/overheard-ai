// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DashboardFilters } from "./DashboardFilters";
import { installDomStubs } from "./test-helpers";
import { NO_FILTER, type DashboardFilter } from "@/lib/dashboard-filters";
import type { PromptOption } from "./types";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

beforeAll(installDomStubs);

const prompts: PromptOption[] = [{ id: "p1", text: "Best analytics tools for startups" }];

function renderStrip(filter: DashboardFilter, notice: string | null = null) {
  return render(
    <DashboardFilters
      filter={filter}
      allAssistants={["anthropic", "openai"]}
      prompts={prompts}
      notice={notice}
      onAssistantToggle={() => {}}
      onPeriodChange={() => {}}
      onPromptChange={() => {}}
    />,
  );
}

describe("DashboardFilters", () => {
  it("summarises an unnarrowed assistant filter as all assistants", () => {
    renderStrip(NO_FILTER);
    expect(screen.getByText("All assistants")).toBeDefined();
  });

  it("names the assistants when one or two are chosen", () => {
    renderStrip({ ...NO_FILTER, assistants: ["anthropic"] });
    expect(screen.getByText("Claude")).toBeDefined();
  });

  it("says so plainly when every assistant is switched off", () => {
    renderStrip({ ...NO_FILTER, assistants: [] });
    expect(screen.getByText("No assistants")).toBeDefined();
  });

  it("offers no switch for self-referenced prompts, which never count", () => {
    renderStrip(NO_FILTER);
    expect(screen.queryByText(/self-referenced/i)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders the notice line when a filter emptied the page", () => {
    renderStrip(NO_FILTER, "No runs in the last 7 days.");
    expect(screen.getByText("No runs in the last 7 days.")).toBeDefined();
  });
});
