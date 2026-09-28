// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SetupCheckRows } from "./SetupCheckRows";
import type { SetupCheckReport } from "@/server/api/settings";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

function report(
  rows: SetupCheckReport["rows"],
  checkedAt = "2026-09-24T12:00:00.000Z",
): SetupCheckReport {
  return { checkedAt, rows };
}

const assistantRow = {
  kind: "assistant" as const,
  provider: "anthropic" as const,
  modelId: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
};

describe("SetupCheckRows", () => {
  it("says every model passed, and shows each row with what was probed", () => {
    render(
      <SetupCheckRows
        report={report([
          {
            ...assistantRow,
            result: { status: "ok", message: "Web search works with this key and model." },
          },
          {
            kind: "extractor",
            provider: "openai",
            modelId: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            result: { status: "mocked", message: "Mock providers are on." },
          },
        ])}
      />,
    );
    expect(screen.getByText(/every model passed/)).toBeDefined();
    expect(screen.getByText("Claude Sonnet 5")).toBeDefined();
    // The point of the check is that it probed the exact model: say which.
    expect(screen.getByText(/assistant · claude-sonnet-5/)).toBeDefined();
    expect(screen.getByText(/extractor · gpt-5.6-luna/)).toBeDefined();
  });

  it("says some models did not pass, and shows the reason and the fix hint", () => {
    render(
      <SetupCheckRows
        report={report([
          {
            ...assistantRow,
            result: {
              status: "billing_not_enabled",
              message: "This Google project cannot search the web: billing is not enabled.",
              hint: "Link a billing account at aistudio.google.com/projects.",
            },
          },
        ])}
      />,
    );
    expect(screen.getByText(/some models did not pass/)).toBeDefined();
    expect(
      screen.getByText("This Google project cannot search the web: billing is not enabled."),
    ).toBeDefined();
    expect(
      screen.getByText("Link a billing account at aistudio.google.com/projects."),
    ).toBeDefined();
  });

  it("shows when the check ran", () => {
    render(
      <SetupCheckRows
        report={report([{ ...assistantRow, result: { status: "ok", message: "Works." } }])}
      />,
    );
    expect(screen.getByText(/Checked at/)).toBeDefined();
  });
});
