// @vitest-environment jsdom
/**
 * The setup screen: its default assistant picks, and the screen itself in both
 * modes, rendered against mocked server functions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampIterations,
  DEFAULT_WIZARD_ITERATIONS,
  MAX_WIZARD_ITERATIONS,
  MIN_WIZARD_ITERATIONS,
} from "@/lib/onboarding";
import { defaultAssistantIds, oneMidPerProvider, Route } from "./start";

const CATALOGUE = [
  { id: "claude-mid", provider: "anthropic", tier: "mid" },
  { id: "claude-frontier", provider: "anthropic", tier: "frontier" },
  { id: "gpt-mid", provider: "openai", tier: "mid" },
  { id: "gpt-mid-2", provider: "openai", tier: "mid" },
  { id: "gemini-mid", provider: "google", tier: "mid" },
  { id: "gpt-small", provider: "openai", tier: "small" },
];

describe("defaultAssistantIds", () => {
  it("takes one mid tier model per provider with a key", () => {
    expect(defaultAssistantIds(CATALOGUE, ["anthropic", "openai"])).toEqual([
      "claude-mid",
      "gpt-mid",
    ]);
  });

  it("never picks a provider with no key", () => {
    expect(defaultAssistantIds(CATALOGUE, ["google"])).toEqual(["gemini-mid"]);
  });

  it("is empty when nothing is configured, rather than guessing", () => {
    expect(defaultAssistantIds(CATALOGUE, [])).toEqual([]);
  });

  it("ignores tiers either side of mid", () => {
    const onlyEdges = CATALOGUE.filter((model) => model.tier !== "mid");
    expect(defaultAssistantIds(onlyEdges, ["anthropic", "openai"])).toEqual([]);
  });

  it("never preselects a superseded model, even one listed first", () => {
    const withOld = [
      { id: "gpt-old-mid", provider: "openai", tier: "mid", superseded: 1 },
      { id: "gpt-mid", provider: "openai", tier: "mid", superseded: 0 },
    ];
    expect(defaultAssistantIds(withOld, ["openai"])).toEqual(["gpt-mid"]);
    expect(oneMidPerProvider(withOld)).toEqual(["gpt-mid"]);
  });
});

describe("clampIterations", () => {
  it("keeps a number inside the create operation's range", () => {
    expect(clampIterations("7")).toBe(7);
    expect(clampIterations(String(MIN_WIZARD_ITERATIONS))).toBe(MIN_WIZARD_ITERATIONS);
    expect(clampIterations(String(MAX_WIZARD_ITERATIONS))).toBe(MAX_WIZARD_ITERATIONS);
  });

  it("clamps rather than refuses, so the box can never hold an unusable value", () => {
    expect(clampIterations("0")).toBe(MIN_WIZARD_ITERATIONS);
    expect(clampIterations("99")).toBe(MAX_WIZARD_ITERATIONS);
    expect(clampIterations("-2")).toBe(MIN_WIZARD_ITERATIONS);
  });

  it("falls back to the default for something that is not a number", () => {
    expect(clampIterations("")).toBe(DEFAULT_WIZARD_ITERATIONS);
    expect(clampIterations("abc")).toBe(DEFAULT_WIZARD_ITERATIONS);
  });
});

describe("route metadata", () => {
  it("names Overheard AI in the page title", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Start watching a brand - Overheard AI"]);
  });
});

describe("oneMidPerProvider (the tutorial's locked selection)", () => {
  it("takes one mid tier model per provider, keys or no keys", () => {
    expect(oneMidPerProvider(CATALOGUE)).toEqual(["claude-mid", "gpt-mid", "gemini-mid"]);
  });
});

/* ------------------------------------------------------- tutorial mode */

// The screen reads and writes through its server functions, the boundary a
// browser test stands in for. The demo's own values never appear here: the
// prefill is mocked with fictional brands like every other fixture.
const tutorialMocks = vi.hoisted(() => ({
  state: { tutorial: "not_started" as string, openaiKey: true },
  generated: [
    {
      text: "Which web analytics tools suit a small shop in Leeds?",
      tag: "visibility",
      iterations: 3,
    },
    {
      text: "What do Leeds retailers use to see which pages sell?",
      tag: "visibility",
      iterations: 3,
    },
    {
      text: "Which analytics tool is cheapest for a one-person shop?",
      tag: "visibility",
      iterations: 3,
    },
    {
      text: "How do analytics tools for small shops compare on setup time?",
      tag: "comparison",
      iterations: 3,
    },
    {
      text: "Are there better alternatives than Acme Analytics for a small shop in Leeds?",
      tag: "comparison",
      iterations: 3,
    },
  ],
  generateStarterPrompts: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  restoreDemoProject: vi.fn(async () => ({ projectId: "demo-1", showcaseRunId: "run-showcase" })),
  setTutorial: vi.fn(async () => ({ ok: true as const })),
  createProject: vi.fn(async () => ({ projectId: "p1" })),
  createRun: vi.fn(async () => ({
    runId: "r1",
    plannedCalls: 2,
    perceptionCalls: 2,
    perceptionSkipped: null,
  })),
  modelsSetupCheck: vi.fn(async () => ({
    checkedAt: new Date().toISOString(),
    rows: [{ result: { status: "ok" as const } }],
  })),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => tutorialMocks.navigate,
}));
vi.mock("@/server/api/tutorial", () => ({
  tutorialState: async () => tutorialMocks.state.tutorial,
  setTutorial: tutorialMocks.setTutorial,
}));
vi.mock("@/server/api/demo", () => ({
  demoPrefill: async () => ({
    brandName: "Acme Analytics",
    category: "web analytics",
    variants: [],
    domains: ["acme.example.com"],
    competitors: ["Northwind Metrics"],
    prompts: [{ text: "What are the best web analytics options?", tag: "visibility" }],
    perceptionPrompt: "What do you know about Acme Analytics?",
  }),
  restoreDemoProject: tutorialMocks.restoreDemoProject,
}));
vi.mock("@/server/api/models", () => {
  // Priced like catalogue rows, so the generate button has a model to price.
  const priced = (input: number, output: number) => ({
    is_active: 1,
    input_price_per_mtok: input,
    output_price_per_mtok: output,
    search_price_per_call: 0.01,
  });
  return {
    listModels: async () => [
      {
        id: "m1",
        provider: "anthropic",
        tier: "mid",
        display_name: "Assistant One",
        ...priced(3, 15),
      },
      {
        id: "m2",
        provider: "openai",
        tier: "mid",
        display_name: "Assistant Two",
        ...priced(2, 12),
      },
      {
        id: "m3",
        provider: "google",
        tier: "mid",
        display_name: "Assistant Three",
        ...priced(2, 12),
      },
    ],
    listExtractionModels: async () => [
      {
        id: "x2",
        provider: "openai",
        tier: "extraction",
        display_name: "Reader Two",
        ...priced(0.2, 1.2),
      },
    ],
  };
});
vi.mock("@/server/api/starter-prompts", () => ({
  generateStarterPrompts: tutorialMocks.generateStarterPrompts,
}));
vi.mock("sonner", () => ({ toast: tutorialMocks.toast }));
vi.mock("@/server/api/settings", () => ({
  keyStatus: async () => [
    {
      provider: "openai",
      configured: tutorialMocks.state.openaiKey,
      source: tutorialMocks.state.openaiKey ? "env" : "none",
    },
    { provider: "anthropic", configured: false, source: "none" },
    { provider: "google", configured: false, source: "none" },
  ],
  workerStatus: async () => ({
    running: true,
    lastPass: null,
    scheduler: { running: true, lastSummary: null, lastError: null },
    mockProviders: false,
  }),
  setupCheck: () => new Promise<never>(() => {}),
  modelsSetupCheck: tutorialMocks.modelsSetupCheck,
}));
vi.mock("@/server/api/projects", () => ({ createProject: tutorialMocks.createProject }));
vi.mock("@/server/api/runs", () => ({ createRun: tutorialMocks.createRun }));

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { FIRST_RESULTS_STEP, TOUR_STEP_KEY, TourProvider } from "@/components/TutorialTour";

afterEach(cleanup);

/** The line under the prompt library, in both modes. */
const DOORS =
  "These prompts are a starting point. Keep them, edit them by hand, or generate a set tailored to your brand on your own keys.";

/** Every key in storage, for asserting what a flow left behind. */
function storedKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
}

/**
 * Keys a tour end flag would use: a Settings re-run flag and a per-project end
 * flag. Every tour ends on the demo dashboard, so nothing may read or write
 * either of them.
 */
function isRetiredKey(key: string): boolean {
  return key === "tutorial:rerun" || key.endsWith(":end");
}

function renderStart() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Start = Route.options.component;
  if (!Start) throw new Error("the route has no component");
  // The wizard is rendered inside the tour the way the app root renders it:
  // in tutorial mode the popups guide it and its screen follows their step.
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        TourProvider,
        {
          navigate: (opts: { to: string; params?: Record<string, string> }) =>
            tutorialMocks.navigate(opts),
          pathname: "/start",
        },
        createElement(Start),
      ),
    ),
  );
}

/** Clears every mock, the toasts included, and puts the default generation back. */
function resetMocks() {
  tutorialMocks.state.openaiKey = true;
  for (const value of [...Object.values(tutorialMocks), ...Object.values(tutorialMocks.toast)]) {
    const callable = typeof value === "function" || (typeof value === "object" && value !== null);
    if (callable && "mockClear" in value) {
      (value as { mockClear: () => void }).mockClear();
    }
  }
  // mockReset drops a mockImplementationOnce a failed test left behind.
  tutorialMocks.generateStarterPrompts.mockReset();
  tutorialMocks.generateStarterPrompts.mockImplementation(async () => ({
    prompts: tutorialMocks.generated,
    costUsd: 0.013,
  }));
}

describe("tutorial mode", () => {
  beforeEach(() => {
    tutorialMocks.state.tutorial = "not_started";
    localStorage.clear();
    resetMocks();
    // mockClear leaves a mockImplementationOnce in place, and a hanging stub
    // from an aborted test must not leak into the next one.
    tutorialMocks.restoreDemoProject.mockImplementation(async () => ({
      projectId: "demo-1",
      showcaseRunId: "run-showcase",
    }));
  });

  it("prefills, locks and is guided by the tour, and never offers a paid check", async () => {
    renderStart();

    // The tour's first popup and the seeded brand arrive once the state and
    // prefill land. There is no screen-level banner: the popups explain.
    expect(await screen.findByText("The brand block")).toBeTruthy();
    expect(screen.queryByText("Tutorial. Demo setup, simulated data")).toBeNull();
    const brand = (await screen.findByLabelText("Brand name (required)")) as HTMLInputElement;
    await waitFor(() => expect(brand.value).toBe("Acme Analytics"));
    expect(brand.matches(":disabled")).toBe(true);
    expect(screen.getAllByText("Filled by the tutorial")).toHaveLength(1);

    // Opening the tutorial marks it in setup, so closing restarts it.
    await waitFor(() =>
      expect(tutorialMocks.setTutorial).toHaveBeenCalledWith({ data: { state: "in_setup" } }),
    );

    // Locked but walkable: Continue is outside the fieldset and enabled, and
    // the tour follows to the step for that screen.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Starter prompts")).toBeTruthy();

    // Screen 2: the question is locked, and nothing on this screen can spend.
    const question = (await screen.findByLabelText("Prompt 1")) as HTMLTextAreaElement;
    expect(question.matches(":disabled")).toBe(true);
    expect(screen.getAllByText("Filled by the tutorial")).toHaveLength(3);
    expect(screen.queryByText("Prove it will work")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Check$/ })).toBeNull();

    // The tour rings the three-doors line. The tutorial never shows the
    // generate button, so the line stands alone and nothing here can spend.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Keep, edit or generate")).toBeTruthy();
    expect(screen.getByText(DOORS)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Generate custom prompts/ })).toBeNull();
    expect(tutorialMocks.generateStarterPrompts).not.toHaveBeenCalled();

    // Then to the keys, then to the create step, whose Next presses the
    // wizard's final button.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Your keys")).toBeTruthy();
    expect(screen.getByText(/your own project needs at least one that works/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Build the demo")).toBeTruthy();

    const final = screen.getByRole("button", {
      name: "Open the demo project",
    });
    expect(final.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(tutorialMocks.restoreDemoProject).toHaveBeenCalled());
    expect(tutorialMocks.createProject).not.toHaveBeenCalled();
    expect(tutorialMocks.createRun).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(tutorialMocks.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId: "demo-1", runId: "run-showcase" },
      }),
    );
    await waitFor(() =>
      expect(tutorialMocks.setTutorial).toHaveBeenCalledWith({ data: { state: "done" } }),
    );

    // The tour is armed for the showcase run at the first results step, with
    // the run id the server named beside the flag, and no end flag: every tour
    // ends where the reader stands, whoever opened it.
    expect(localStorage.getItem("overheard:tour:demo-1")).toBe("pending");
    expect(localStorage.getItem("overheard:tour:demo-1:run")).toBe("run-showcase");
    expect(localStorage.getItem(TOUR_STEP_KEY)).toBe(String(FIRST_RESULTS_STEP));
    expect(storedKeys().filter(isRetiredKey)).toEqual([]);
  });

  it("locks at full contrast with one line per section, and no callout cards", async () => {
    // No per-section callout cards. The tour's popups carry the explanations,
    // and each locked section keeps one small lock line.
    tutorialMocks.restoreDemoProject.mockImplementationOnce(() => new Promise<never>(() => {}));
    renderStart();

    expect(await screen.findByText("The brand block")).toBeTruthy();
    for (const gone of [
      "This tutorial fills the setup with a real brand and simulated data",
      "Starter prompts generated from the brand and category.",
      "in a generic fashion",
      "read from the environment",
      "Creates simulated project and walks you through it",
    ]) {
      expect(screen.queryByText(gone, { exact: false })).toBeNull();
    }
    // The brand guidance lives in the popup.
    expect(screen.getByText(/Your brand goes here/)).toBeTruthy();

    const brand = (await screen.findByLabelText("Brand name (required)")) as HTMLInputElement;
    await waitFor(() => expect(brand.value).toBe("Acme Analytics"));
    // Disabled but not greyed: the tutorial wants these values read.
    const fieldset = brand.closest("fieldset");
    expect(fieldset?.className).not.toContain("opacity");
    expect(screen.getAllByText("Filled by the tutorial")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Prompt 1");
    expect(screen.getAllByText("Filled by the tutorial")).toHaveLength(3);

    // While the demo is built, the overlay is its title and nothing else.
    fireEvent.click(screen.getByRole("button", { name: "Open the demo project" }));
    const building = await screen.findByRole("heading", { name: "Building the demo" });
    expect(building.parentElement?.textContent).toBe("Building the demo");
  });

  it("a re-run from Settings replays the tour on the tutorial state alone", async () => {
    // Settings reopens the tutorial by setting its state back to in setup and
    // nothing else. The first tour was finished long ago, and no flag in
    // storage says this is a second pass.
    tutorialMocks.state.tutorial = "in_setup";
    localStorage.setItem("overheard:tour:demo-1", "done");
    const spies = [
      vi.spyOn(Storage.prototype, "getItem"),
      vi.spyOn(Storage.prototype, "setItem"),
      vi.spyOn(Storage.prototype, "removeItem"),
    ];
    renderStart();

    // Wait for the prefill to land before advancing, as a real reader would.
    const brand = (await screen.findByLabelText("Brand name (required)")) as HTMLInputElement;
    await waitFor(() => expect(brand.value).toBe("Acme Analytics"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open the demo project",
      }),
    );

    await waitFor(() => expect(localStorage.getItem("overheard:tour:demo-1")).toBe("pending"));
    expect(localStorage.getItem(TOUR_STEP_KEY)).toBe(String(FIRST_RESULTS_STEP));
    const touched = spies.flatMap((spy) => spy.mock.calls.map(([key]) => String(key)));
    for (const spy of spies) spy.mockRestore();
    expect(touched.filter(isRetiredKey)).toEqual([]);
    expect(tutorialMocks.setTutorial).toHaveBeenCalledWith({ data: { state: "done" } });
  });
});

describe("normal mode (tutorial done)", () => {
  beforeEach(() => {
    tutorialMocks.state.tutorial = "done";
    localStorage.clear();
    resetMocks();
  });

  it("creates and runs without arming any tour", async () => {
    renderStart();

    // No banner, no locks: the ordinary wizard.
    expect(await screen.findByLabelText("Brand name (required)")).toBeTruthy();
    expect(screen.queryByText("Tutorial. Demo setup, simulated data")).toBeNull();

    fireEvent.change(screen.getByLabelText("Brand name (required)"), {
      target: { value: "Acme Analytics" },
    });
    fireEvent.change(screen.getByLabelText("Category (required)"), {
      target: { value: "web analytics" },
    });
    const domain = screen.getByPlaceholderText("acme.example.com");
    fireEvent.change(domain, { target: { value: "acme.example.com" } });
    fireEvent.keyDown(domain, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // The gate: run the (mocked, passing) selection check, then create.
    fireEvent.click(await screen.findByRole("button", { name: /Run setup check/ }));
    const create = await screen.findByRole("button", { name: /Create project and run/ });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);

    await waitFor(() => expect(tutorialMocks.createProject).toHaveBeenCalled());
    expect(tutorialMocks.restoreDemoProject).not.toHaveBeenCalled();
    await waitFor(() => expect(tutorialMocks.createRun).toHaveBeenCalled());
    expect(localStorage.getItem("overheard:tour:p1")).toBeNull();
    expect(localStorage.getItem(TOUR_STEP_KEY)).toBeNull();
  });

  /** The text of the first <p> whose whole content matches, spans included. */
  function paragraph(text: string) {
    return screen.getByText(
      (_, element) => element?.tagName === "P" && element.textContent === text,
    );
  }

  function fillBrand(domainValue = "acme.example.com") {
    fireEvent.change(screen.getByLabelText("Brand name (required)"), {
      target: { value: "  Acme Analytics " },
    });
    fireEvent.change(screen.getByLabelText("Category (required)"), {
      target: { value: "web analytics" },
    });
    const domain = screen.getByPlaceholderText("acme.example.com");
    fireEvent.change(domain, { target: { value: domainValue } });
    fireEvent.keyDown(domain, { key: "Enter" });
  }

  it("holds Continue until the brand has a name, a category and a usable domain", async () => {
    renderStart();
    await screen.findByLabelText("Brand name (required)");
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(true);

    fillBrand("acme");
    expect(screen.getByText(/acme does not look like a domain/)).toBeTruthy();
    expect(continueButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Remove acme/i }));
    const domain = screen.getByPlaceholderText("acme.example.com");
    fireEvent.change(domain, { target: { value: "ACME.example.com" } });
    fireEvent.keyDown(domain, { key: "Enter" });
    await waitFor(() => expect(continueButton.hasAttribute("disabled")).toBe(false));
  });

  it("plans, gates and sends exactly the prompts, domains and assistants on screen", async () => {
    renderStart();
    await screen.findByLabelText("Brand name (required)");
    fillBrand("ACME.example.com");
    const competitor = screen.getByPlaceholderText(
      "Northwind Metrics, Contoso Insights, Globex Search",
    );
    fireEvent.change(competitor, { target: { value: "Northwind Metrics" } });
    fireEvent.keyDown(competitor, { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Domain for Northwind Metrics"), {
      target: { value: "northwind.example.com" },
    });
    fireEvent.change(screen.getByLabelText("What does your brand do? (optional)"), {
      target: { value: " Web analytics for\nsmall shops in Leeds. " },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // Five starter prompts at the default iterations, on the one keyed provider's mid model.
    expect(await screen.findByLabelText("Prompt 5")).toBeTruthy();
    const perPrompt = DEFAULT_WIZARD_ITERATIONS;
    expect(paragraph(`${5 * perPrompt} answers from 1 assistant across 5 prompts.`)).toBeTruthy();

    // Edit the list: fewer iterations on the first, drop the last, add one left blank.
    fireEvent.change(screen.getByLabelText("Iterations for prompt 1"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove prompt 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Add your own prompt" }));
    expect(screen.getByText(/Prompt 5 is empty and will not be saved/)).toBeTruthy();
    const answers = 1 + 3 * perPrompt;
    expect(paragraph(`${answers} answers from 1 assistant across 4 prompts.`)).toBeTruthy();

    // A written prompt with no tag blocks create, whatever the check says.
    fireEvent.change(screen.getByLabelText("Prompt 5"), {
      target: { value: "Who leads in web analytics?" },
    });
    expect(screen.getByText(/Prompt 5 has no tag\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Run setup check/ }));
    const create = await screen.findByRole("button", { name: /Create project and run/ });
    await waitFor(() =>
      expect(tutorialMocks.modelsSetupCheck).toHaveBeenCalledWith({
        data: { assistantModelIds: ["m2"] },
      }),
    );
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove prompt 5" }));
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);

    await waitFor(() => expect(tutorialMocks.createProject).toHaveBeenCalledOnce());
    expect(tutorialMocks.createProject).toHaveBeenCalledWith({
      data: {
        brandName: "Acme Analytics",
        category: "web analytics",
        description: "Web analytics for small shops in Leeds.",
        variants: [],
        domains: ["acme.example.com"],
        competitors: [{ name: "Northwind Metrics", domains: ["northwind.example.com"] }],
        prompts: [
          {
            text: "What are the best options for web analytics?",
            tag: "visibility",
            iterations: 1,
          },
          {
            text: "Which web analytics would you recommend, and why?",
            tag: "visibility",
            iterations: perPrompt,
          },
          {
            text: "What are the best options for web analytics on a tight budget?",
            tag: "visibility",
            iterations: perPrompt,
          },
          {
            text: "What should I consider when comparing options for web analytics?",
            tag: "comparison",
            iterations: perPrompt,
          },
        ],
        perceptionPrompt: expect.stringContaining("{brand}"),
        monitoredModelIds: ["m2"],
      },
    });
    await waitFor(() =>
      expect(tutorialMocks.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId: "p1", runId: "r1" },
      }),
    );
  });
});

/* ------------------------------------------------ generating starter prompts */

describe("generating starter prompts", () => {
  beforeEach(() => {
    tutorialMocks.state.tutorial = "done";
    localStorage.clear();
    resetMocks();
  });

  /** The brand step filled in, the description included, and on to the prompts. */
  async function toPrompts(description = "Web analytics for small shops in Leeds.") {
    renderStart();
    await screen.findByLabelText("Brand name (required)");
    fireEvent.change(screen.getByLabelText("Brand name (required)"), {
      target: { value: "Acme Analytics" },
    });
    fireEvent.change(screen.getByLabelText("Category (required)"), {
      target: { value: "web analytics" },
    });
    fireEvent.change(screen.getByLabelText("What does your brand do? (optional)"), {
      target: { value: description },
    });
    const domain = screen.getByPlaceholderText("acme.example.com");
    fireEvent.change(domain, { target: { value: "acme.example.com" } });
    fireEvent.keyDown(domain, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Prompt 5");
  }

  function promptText(row: number): string {
    return (screen.getByLabelText(`Prompt ${row}`) as HTMLTextAreaElement).value;
  }

  const ARMED = /^Generate custom prompts ~ \$0\.01 on your key$/;

  function backAndChangeCategory(category: string) {
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("Category (required)"), {
      target: { value: category },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  it("shows the generic five first, with the three doors under them", async () => {
    await toPrompts();
    expect(promptText(1)).toBe("What are the best options for web analytics?");
    expect(screen.getByText(DOORS)).toBeTruthy();
    // The one keyed provider's mid-tier model prices the button.
    const button = await screen.findByRole("button", { name: ARMED });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("sends the brand, replaces the five with the generated set, and ends disabled", async () => {
    let release: (value: unknown) => void = () => {};
    tutorialMocks.generateStarterPrompts.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    await toPrompts();
    fireEvent.click(await screen.findByRole("button", { name: ARMED }));

    // While it is out: the button says so, and nothing it would replace can move.
    const working = await screen.findByRole("button", { name: "Generating…" });
    expect(working.hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Prompt 1").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(tutorialMocks.generateStarterPrompts).toHaveBeenCalledWith({
      data: {
        brandName: "Acme Analytics",
        category: "web analytics",
        description: "Web analytics for small shops in Leeds.",
        variants: [],
        competitors: [],
      },
    });

    release({ prompts: tutorialMocks.generated, costUsd: 0.013 });
    const done = await screen.findByRole("button", { name: "Prompts generated" });
    expect(done.hasAttribute("disabled")).toBe(true);
    expect(promptText(1)).toBe("Which web analytics tools suit a small shop in Leeds?");
    expect(promptText(5)).toBe(
      "Are there better alternatives than Acme Analytics for a small shop in Leeds?",
    );
    expect(screen.getByLabelText("Iterations for prompt 1")).toHaveProperty("value", "3");
    expect(tutorialMocks.generateStarterPrompts).toHaveBeenCalledOnce();
  });

  it("on a failure, toasts the reason, keeps the list exactly as it was and re-arms", async () => {
    tutorialMocks.generateStarterPrompts.mockImplementationOnce(async () => {
      throw new Error("GENERATION_FAILED: That OpenAI key was rejected.");
    });
    await toPrompts();
    const before = [1, 2, 3, 4, 5].map(promptText);
    fireEvent.click(await screen.findByRole("button", { name: ARMED }));

    await waitFor(() =>
      expect(tutorialMocks.toast.error).toHaveBeenCalledWith(
        "That OpenAI key was rejected. Your prompts are unchanged",
      ),
    );
    expect([1, 2, 3, 4, 5].map(promptText)).toEqual(before);
    const again = await screen.findByRole("button", { name: ARMED });
    expect(again.hasAttribute("disabled")).toBe(false);
  });

  it("resets an untouched generated set to the templates on an input change, and re-arms", async () => {
    await toPrompts();
    fireEvent.click(await screen.findByRole("button", { name: ARMED }));
    await screen.findByRole("button", { name: "Prompts generated" });

    backAndChangeCategory("product analytics");
    await screen.findByLabelText("Prompt 5");
    expect(promptText(1)).toBe("What are the best options for product analytics?");
    expect(screen.getByRole("button", { name: ARMED }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps a list edited by hand through an input change, with the button left off", async () => {
    await toPrompts();
    fireEvent.change(screen.getByLabelText("Prompt 1"), {
      target: { value: "Which analytics tool do Leeds shops trust?" },
    });
    const off = screen.getByRole("button", { name: ARMED });
    expect(off.hasAttribute("disabled")).toBe(true);
    expect(off.getAttribute("title")).toBe(
      "You edited these prompts, so they stay as you wrote them.",
    );

    backAndChangeCategory("product analytics");
    await screen.findByLabelText("Prompt 5");
    expect(promptText(1)).toBe("Which analytics tool do Leeds shops trust?");
    // Untouched rows of an edited list are the user's list too.
    expect(promptText(2)).toBe("Which web analytics would you recommend, and why?");
    expect(screen.getByRole("button", { name: ARMED }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps an edited generated set through an input change too", async () => {
    await toPrompts();
    fireEvent.click(await screen.findByRole("button", { name: ARMED }));
    await screen.findByRole("button", { name: "Prompts generated" });
    fireEvent.change(screen.getByLabelText("Iterations for prompt 2"), { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("What does your brand do? (optional)"), {
      target: { value: "Web analytics for market stalls in York." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Prompt 5");
    expect(promptText(1)).toBe("Which web analytics tools suit a small shop in Leeds?");
    expect(screen.getByRole("button", { name: ARMED }).hasAttribute("disabled")).toBe(true);
  });

  it("with no provider key, is disabled and says what to do", async () => {
    tutorialMocks.state.openaiKey = false;
    await toPrompts("");
    const button = await screen.findByRole("button", { name: "Generate custom prompts" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Needs a provider key. Add one in Account settings.")).toBeTruthy();
  });
});
