import { describe, expect, it } from "vitest";
import {
  clearSetupDraft,
  type DraftStorage,
  draftHasContent,
  readSetupDraft,
  SETUP_DRAFT_KEY,
  type SetupDraft,
  writeSetupDraft,
} from "./setup-draft";

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const DRAFT: Omit<SetupDraft, "version" | "savedAt"> = {
  step: 1,
  brandName: "Acme Analytics",
  category: "product analytics",
  description: "Event analytics for small SaaS teams.",
  variants: ["Acme"],
  domains: ["acme.example"],
  competitors: ["Northwind"],
  competitorDomains: { Northwind: "northwind.example" },
  prompts: [
    { text: "Best analytics tool for a small SaaS team?", tag: "visibility", iterations: 3 },
  ],
  promptOrigin: {
    source: "template",
    inputs: { brand: "Acme Analytics", category: "product analytics", description: "" },
    prompts: [{ text: "Best analytics tool?", tag: "visibility", iterations: 3 }],
  },
  perceptionPrompt: "What do you know about Acme Analytics?",
  perceptionDirty: false,
  chosenModelIds: ["model-1"],
};

describe("the setup draft", () => {
  it("comes back exactly as it was written, under the overheard: prefix", () => {
    const storage = memoryStorage();
    writeSetupDraft(storage, DRAFT, new Date("2026-09-28T01:00:00Z"));
    expect([...storage.data.keys()]).toEqual([SETUP_DRAFT_KEY]);
    expect(SETUP_DRAFT_KEY.startsWith("overheard:")).toBe(true);
    expect(readSetupDraft(storage)).toEqual({
      version: 1,
      savedAt: "2026-09-28T01:00:00.000Z",
      ...DRAFT,
    });
  });

  it("is gone once cleared", () => {
    const storage = memoryStorage();
    writeSetupDraft(storage, DRAFT);
    clearSetupDraft(storage);
    expect(readSetupDraft(storage)).toBeNull();
  });

  it("drops anything it did not write rather than breaking the screen", () => {
    const storage = memoryStorage();
    storage.setItem(SETUP_DRAFT_KEY, "{not json");
    expect(readSetupDraft(storage)).toBeNull();

    const written = { version: 1, savedAt: "2026-09-28T01:00:00Z", ...DRAFT };
    for (const broken of [
      { ...written, version: 2 },
      { ...written, step: 2 },
      { ...written, domains: "acme.example" },
      { ...written, prompts: [{ text: "q", tag: null, iterations: 0 }] },
      { ...written, promptOrigin: { source: "somewhere", inputs: {}, prompts: [] } },
      { ...written, competitorDomains: { Northwind: 3 } },
      { ...written, chosenModelIds: "model-1" },
    ]) {
      storage.setItem(SETUP_DRAFT_KEY, JSON.stringify(broken));
      expect(readSetupDraft(storage)).toBeNull();
    }
  });

  it("survives storage that is missing or refuses writes", () => {
    expect(readSetupDraft(null)).toBeNull();
    expect(() => writeSetupDraft(null, DRAFT)).not.toThrow();
    const full: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => writeSetupDraft(full, DRAFT)).not.toThrow();
    expect(() => clearSetupDraft(full)).not.toThrow();
  });

  it("is not worth keeping until something was typed", () => {
    const empty = {
      ...DRAFT,
      brandName: " ",
      category: "",
      description: "",
      variants: [],
      domains: [],
      competitors: [],
    };
    expect(draftHasContent(empty)).toBe(false);
    expect(draftHasContent({ ...empty, category: "analytics" })).toBe(true);
    expect(draftHasContent({ ...empty, domains: ["acme.example"] })).toBe(true);
  });
});
