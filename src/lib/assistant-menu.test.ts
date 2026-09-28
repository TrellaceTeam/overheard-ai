import { describe, expect, it } from "vitest";
import { assistantMenus, type MenuModel } from "./assistant-menu";

const OPENAI: MenuModel[] = [
  {
    id: "old-mid",
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
const GROUPS = [
  { provider: "openai", models: OPENAI },
  { provider: "google", models: GOOGLE },
];

function menus(patch: Partial<Parameters<typeof assistantMenus>[0]> = {}) {
  return assistantMenus({
    groups: GROUPS,
    selectedIds: new Set(["mid"]),
    keyedProviders: new Set(["openai", "google"]),
    keysUnresolved: false,
    locked: false,
    ...patch,
  });
}

describe("assistantMenus", () => {
  it("lists current models before superseded ones, and marks the older ones", () => {
    const openai = menus()[0]!;
    expect(openai.items.map((item) => item.id)).toEqual(["mid", "top", "old-mid"]);
    expect(openai.items.map((item) => item.older)).toEqual([false, false, true]);
  });

  it("summarises the ticked models the way the closed dropdown shows them", () => {
    expect(menus()[0]?.summary).toBe("GPT Mid");
    expect(menus({ selectedIds: new Set(["mid", "top"]) })[0]?.summary).toBe("GPT Mid, GPT Top");
    expect(menus({ selectedIds: new Set(["mid", "top", "old-mid"]) })[0]?.summary).toBe("3 models");
    expect(menus()[1]?.summary).toBe("None");
  });

  it("holds unticked models while the key check is in flight, but lets a ticked one off", () => {
    const openai = menus({ keysUnresolved: true, keyedProviders: new Set() })[0]!;
    expect(openai.items.find((item) => item.id === "mid")?.disabled).toBe(false);
    expect(openai.items.find((item) => item.id === "top")?.disabled).toBe(true);
    expect(openai.noKey).toBe(false);
  });

  it("offers nothing new on a provider with no key, and keeps a ticked model switchable off", () => {
    const openai = menus({ keyedProviders: new Set(["google"]) })[0]!;
    expect(openai.noKey).toBe(true);
    expect(openai.items.find((item) => item.id === "mid")?.disabled).toBe(false);
    expect(openai.items.find((item) => item.id === "top")).toMatchObject({
      disabled: true,
      note: "no key",
    });
  });

  it("will not tick a model the key does not list, and says why", () => {
    const openai = menus({
      availability: {
        openai: { status: "ok", available: ["gpt-mid", "gpt-old"], missing: ["gpt-top"] },
      },
    })[0]!;
    expect(openai.items.find((item) => item.id === "top")).toMatchObject({
      disabled: true,
      note: "not on your key",
    });
  });

  it("still lets a ticked model the key stopped listing be switched off", () => {
    const openai = menus({
      selectedIds: new Set(["top"]),
      availability: { openai: { status: "ok", available: [], missing: ["gpt-top"] } },
    })[0]!;
    expect(openai.items.find((item) => item.id === "top")).toMatchObject({
      checked: true,
      disabled: false,
      note: "not on your key",
    });
  });

  it("does not block anything when the model list could not be read, and says so", () => {
    const openai = menus({
      availability: { openai: { status: "error", message: "The list could not be read." } },
    })[0]!;
    expect(openai.items.every((item) => !item.disabled)).toBe(true);
    expect(openai.listProblem).toBe("The list could not be read.");
  });

  it("locks every item on the demo, ticked or not", () => {
    expect(
      menus({ locked: true })
        .flatMap((menu) => menu.items)
        .every((item) => item.disabled),
    ).toBe(true);
  });
});
