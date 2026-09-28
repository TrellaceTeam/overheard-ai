// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { CountingInfo } from "./CountingInfo";
import { installDomStubs } from "./test-helpers";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

beforeAll(installDomStubs);

describe("CountingInfo", () => {
  it("explains that self-referenced prompts never count", async () => {
    render(<CountingInfo />);
    const trigger = screen.getByRole("button", { name: "How is this counted?" });

    await act(async () => {
      trigger.focus();
    });

    expect(screen.getByRole("tooltip").textContent).toBe(
      "Prompts that name your own brand are asked and kept, but never count in statistics, so they cannot inflate your results.",
    );
  });
});
