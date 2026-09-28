// @vitest-environment jsdom
/**
 * The project settings screen: the sections it holds (the assistant selection
 * lives in the Runner on the Prompts tab), and the brand section's chips. Both
 * variant lists are chips, and the domain one saves behind the re-score confirm.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("@/server/api/projects", () => ({
  getProject: async () => ({ id: "p1", name: "Acme", isDemo: false }),
  getProjectSettings: async () => ({
    extractionModelId: "haiku",
    extractionPrompt: "read the answer",
    extractionPromptDefault: "read the answer",
  }),
  updateProject: async () => ({ ok: true }),
  deleteProject: async () => ({ ok: true }),
  mostRecentProject: async () => ({ projectId: null }),
}));
vi.mock("@/server/api/brands", () => ({
  getTargetBrand: async () => ({
    id: "b1",
    name: "Acme",
    variants: ["Acme Analytics"],
    domains: ["acme.example.com", "www.acme.example.com"],
    suggestedDomains: [],
  }),
  updateBrand: async () => ({ ok: true }),
  recomputeCitations: async () => ({ changed: 0, runs: 0 }),
}));
vi.mock("@/server/api/perception", () => ({
  getPerceptionState: async () => ({ prompt: "What do you know about Acme?", stale: false }),
}));
vi.mock("@/server/api/schedules", () => ({
  getSchedule: async () => null,
  nextOccurrence: async () => ({ nextRunAt: "2026-09-29T08:00:00.000Z" }),
  saveSchedule: async () => ({ ok: true }),
  disableSchedule: async () => ({ ok: true }),
}));
vi.mock("@/server/api/models", () => ({
  listExtractionModels: async () => [
    { id: "haiku", provider: "anthropic", display_name: "Claude Haiku", tier: "small" },
  ],
}));
vi.mock("@/server/api/settings", () => ({
  keyStatus: async () => [
    { provider: "anthropic", configured: true, source: "env" },
    { provider: "openai", configured: false, source: "none" },
    { provider: "google", configured: false, source: "none" },
  ],
}));
vi.mock("@/server/api/runs", () => ({
  createPerceptionRun: async () => ({ answers: 1 }),
  kickWorker: async () => ({ ok: true }),
}));

import { Route } from "./projects.$projectId.settings";

afterEach(cleanup);

describe("route metadata", () => {
  it("names Overheard AI", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Project settings - Overheard AI"]);
  });
});

describe("the screen", () => {
  function renderSettings() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Settings = Route.options.component;
    if (!Settings) throw new Error("the route has no component");
    return render(createElement(QueryClientProvider, { client }, createElement(Settings)));
  }

  it("keeps the brand, the perception prompt, the schedule, the extractor and the deletion", async () => {
    renderSettings();
    expect(await screen.findByText("Your brand")).toBeTruthy();
    expect(screen.getByText("Perception prompt")).toBeTruthy();
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.getByText("Extractor")).toBeTruthy();
    expect(screen.getByText("Delete this project")).toBeTruthy();
  });

  it("leaves the assistant selection to the Runner", async () => {
    renderSettings();
    expect(await screen.findByText("Extractor")).toBeTruthy();
    expect(screen.queryByText("Monitored assistants")).toBeNull();
    expect(
      screen.queryByText(/Only providers whose key is in your environment can be selected/),
    ).toBeNull();
  });

  it("renders the domain variants as chips, like the name variants", async () => {
    renderSettings();
    expect(await screen.findByLabelText("Remove www.acme.example.com")).toBeTruthy();
    expect(screen.getByLabelText("Remove Acme Analytics")).toBeTruthy();
    // No free-text field is labelled "Other domains": the chips carry the list.
    expect(screen.queryByLabelText("Other domains")).toBeNull();
  });

  it("splits a pasted comma list into chips on commit, as a draft Save then carries", async () => {
    renderSettings();
    await screen.findByLabelText("Remove www.acme.example.com");
    const box = document.getElementById("domain-variants") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "shop.acme.example.com, acme.example.invalid" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByLabelText("Remove shop.acme.example.com")).toBeTruthy();
    expect(screen.getByLabelText("Remove acme.example.invalid")).toBeTruthy();
    // Nothing is written yet: the chips are a draft the Save button carries,
    // behind the confirm, because a domain change re-scores every past run.
    const save = screen.getByRole("button", { name: /Save domains/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});
