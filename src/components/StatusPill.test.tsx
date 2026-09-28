// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusPill, statusToneClass } from "./StatusPill";
import type { RunTone } from "@/lib/run-outcome";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

const TONES: RunTone[] = ["waiting", "running", "success", "partial", "failed", "cancelled"];

describe("StatusPill", () => {
  it("shows the word, so the state is never colour alone", () => {
    render(<StatusPill tone="partial" label="Run finished with failures" />);
    expect(screen.getByText("Run finished with failures")).toBeDefined();
  });

  it("has a class for every tone the outcome helper can return", () => {
    for (const tone of TONES) {
      expect(statusToneClass(tone)).toMatch(/^text-status-/);
    }
  });

  it("gives every state its own token rather than one shared muted class", () => {
    const classes = TONES.map(statusToneClass);
    expect(new Set(classes).size).toBe(TONES.length);
  });
});
