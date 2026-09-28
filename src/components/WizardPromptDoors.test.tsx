// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TOUR_SELECTORS } from "./TutorialTour";
import { WizardPromptDoors } from "./WizardPromptDoors";

afterEach(cleanup);

const DOORS =
  "These prompts are a starting point. Keep them, edit them by hand, or generate a set tailored to your brand on your own keys.";

function renderIn(state: Parameters<typeof WizardPromptDoors>[0]["button"]) {
  return render(<WizardPromptDoors button={state} />);
}

describe("WizardPromptDoors", () => {
  it("names the three doors under the library, where the tour rings it", () => {
    renderIn(null);
    const line = screen.getByText(DOORS);
    expect(line.closest(`[data-tour="${TOUR_SELECTORS.wizardDoors}"]`)).not.toBeNull();
  });

  it("shows no button at all in the tutorial", () => {
    renderIn(null);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("armed: offers the call with its rough cost, and presses once", () => {
    const onGenerate = vi.fn();
    renderIn({ state: "armed", costUsd: 0.014, onGenerate });
    const button = screen.getByRole("button", {
      name: "Generate custom prompts ~ $0.01 on your key",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("generating: says so and takes no second press", () => {
    const onGenerate = vi.fn();
    renderIn({ state: "generating", costUsd: 0.014, onGenerate });
    const button = screen.getByRole("button", { name: "Generating…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("generated: ends disabled, one shot per input set", () => {
    renderIn({ state: "generated", costUsd: 0.014, onGenerate: () => {} });
    const button = screen.getByRole("button", { name: "Prompts generated" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("no key: disabled, with the fix beside it and no price", () => {
    renderIn({ state: "no-key", costUsd: 0, onGenerate: () => {} });
    const button = screen.getByRole("button", { name: "Generate custom prompts" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Needs a provider key. Add one in Account settings.")).toBeDefined();
  });

  it("edited: disabled, and says why on the button", () => {
    renderIn({ state: "edited", costUsd: 0.014, onGenerate: () => {} });
    const button = screen.getByRole("button", { name: /Generate custom prompts ~/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "You edited these prompts, so they stay as you wrote them.",
    );
  });
});
