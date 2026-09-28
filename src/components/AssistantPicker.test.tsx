// @vitest-environment jsdom
/**
 * The picker as rendered. What may be ticked is lib/assistant-menu's, tested
 * there. These pin what the rows show and that the menu hands a toggle back.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { assistantMenus, type MenuModel } from "@/lib/assistant-menu";
import { AssistantPicker } from "./AssistantPicker";
import { installDomStubs } from "./test-helpers";

afterEach(cleanup);
beforeAll(installDomStubs);

const OPENAI: MenuModel[] = [
  {
    id: "old",
    provider: "openai",
    model_id: "gpt-old",
    display_name: "GPT Old",
    tier: "mid",
    superseded: 1,
  },
  {
    id: "mid",
    provider: "openai",
    model_id: "gpt-mid",
    display_name: "GPT Mid",
    tier: "mid",
    superseded: 0,
  },
  {
    id: "top",
    provider: "openai",
    model_id: "gpt-top",
    display_name: "GPT Top",
    tier: "frontier",
    superseded: 0,
  },
];
const GOOGLE: MenuModel[] = [
  {
    id: "flash",
    provider: "google",
    model_id: "gemini-flash",
    display_name: "Gemini Flash",
    tier: "mid",
  },
];

function renderPicker(patch: Partial<Parameters<typeof assistantMenus>[0]> = {}, locked = false) {
  const onToggle = vi.fn();
  const menus = assistantMenus({
    groups: [
      { provider: "openai", models: OPENAI },
      { provider: "google", models: GOOGLE },
    ],
    selectedIds: new Set(["mid"]),
    keyedProviders: new Set(["openai"]),
    keysUnresolved: false,
    locked,
    availability: {
      openai: { status: "ok", available: ["gpt-mid", "gpt-old"], missing: ["gpt-top"] },
    },
    ...patch,
  });
  render(<AssistantPicker menus={menus} locked={locked} onToggle={onToggle} note="A note." />);
  return onToggle;
}

function open(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("AssistantPicker", () => {
  it("shows each provider's choice on its closed dropdown", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "OpenAI models: GPT Mid" })).toBeTruthy();
  });

  it("is a plain line, not a dropdown, for a provider with no key and nothing ticked", () => {
    renderPicker();
    expect(screen.queryByRole("button", { name: /Gemini models/ })).toBeNull();
    expect(screen.getByText(/No Google key\. Add GOOGLE_API_KEY/)).toBeTruthy();
  });

  it("keeps a dropdown on a keyless provider whose model is ticked, and says it will fail", () => {
    renderPicker({ selectedIds: new Set(["flash"]) });
    expect(screen.getByRole("button", { name: "Gemini models: Gemini Flash" })).toBeTruthy();
    expect(screen.getByText(/will fail until you add one or switch it off/)).toBeTruthy();
  });

  it("lists current models, then older ones, and names what cannot be ticked", async () => {
    renderPicker();
    open(screen.getByRole("button", { name: "OpenAI models: GPT Mid" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((item) => item.textContent)).toEqual([
      "GPT Midmid",
      "GPT Topnot on your key",
      "GPT Oldmid",
    ]);
    expect(within(menu).getByText("Older, kept for past runs")).toBeTruthy();
    expect(within(menu).getByText(/Only models checked to answer with web search/)).toBeTruthy();
    expect(items[1]?.getAttribute("aria-disabled")).toBe("true");
  });

  it("hands a toggle back and stays open, so several can be ticked in one go", async () => {
    const onToggle = renderPicker();
    open(screen.getByRole("button", { name: "OpenAI models: GPT Mid" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /GPT Old/ }));
    expect(onToggle).toHaveBeenCalledWith("old", true);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("locks the dropdown on the demo", () => {
    renderPicker({}, true);
    expect(
      (screen.getByRole("button", { name: "OpenAI models: GPT Mid" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("tells nobody to switch a model off where nothing can be changed", () => {
    renderPicker({ selectedIds: new Set(["flash"]) }, true);
    expect(screen.getByRole("button", { name: "Gemini models: Gemini Flash" })).toBeTruthy();
    expect(screen.queryByText(/switch it off/)).toBeNull();
  });

  it("prints the note under the rows", () => {
    renderPicker();
    expect(screen.getByText("A note.")).toBeTruthy();
  });
});
