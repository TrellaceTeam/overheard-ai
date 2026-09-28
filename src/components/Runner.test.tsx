// @vitest-environment jsdom
/**
 * The Runner: the block at the top of the Prompts tab that decides and starts
 * the next run. The pure helpers pin the arithmetic the plan line promises.
 * The render tests pin the selector (chips, keyless providers, the held key
 * check) and the demo lock over all of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const runnerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setProjectModel: vi.fn(async () => ({ ok: true as const })),
  createRun: vi.fn(async () => ({
    runId: "run-1",
    plannedCalls: 60,
    perceptionCalls: 0,
    perceptionRunId: null,
    perceptionSkipped: null,
  })),
  kickWorker: vi.fn(async () => ({ ok: true as const })),
  plan: {
    value: { prompts: 3, assistants: 2, answers: 30, calls: 60, perceptionCalls: 0 } as
      | {
          prompts: number;
          assistants: number;
          answers: number;
          calls: number;
          perceptionCalls: number;
        }
      | Error,
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => runnerMocks.navigate,
}));
vi.mock("@/server/api/models", () => ({
  listModels: async () => [
    {
      id: "claude-mid",
      provider: "anthropic",
      display_name: "Claude Mid",
      tier: "mid",
      input_price_per_mtok: 3,
      output_price_per_mtok: 15,
      search_price_per_call: 0.01,
    },
    {
      id: "gpt-mid",
      provider: "openai",
      display_name: "GPT Mid",
      tier: "mid",
      input_price_per_mtok: 2.5,
      output_price_per_mtok: 10,
      search_price_per_call: 0.03,
    },
    {
      id: "gemini-mid",
      provider: "google",
      display_name: "Gemini Mid",
      tier: "mid",
      input_price_per_mtok: 0.075,
      output_price_per_mtok: 0.3,
      search_price_per_call: 0.035,
    },
  ],
  listProjectModels: async () => [
    { modelId: "claude-mid", provider: "anthropic", displayName: "Claude Mid" },
    { modelId: "gpt-mid", provider: "openai", displayName: "GPT Mid" },
  ],
  listExtractionModels: async () => [
    {
      id: "haiku",
      provider: "anthropic",
      display_name: "Claude Haiku",
      tier: "small",
      input_price_per_mtok: 1,
      output_price_per_mtok: 5,
      search_price_per_call: 0,
    },
  ],
  setProjectModel: runnerMocks.setProjectModel,
}));
vi.mock("@/server/api/projects", () => ({
  getProjectSettings: async () => ({
    extractionModelId: "haiku",
    extractionPrompt: "read",
    extractionPromptDefault: "read",
  }),
}));
vi.mock("@/server/api/runs", () => ({
  planRun: async () => {
    if (runnerMocks.plan.value instanceof Error) throw runnerMocks.plan.value;
    return runnerMocks.plan.value;
  },
  createRun: runnerMocks.createRun,
  kickWorker: runnerMocks.kickWorker,
}));
vi.mock("@/server/api/settings", () => ({
  keyStatus: async () => [
    { provider: "anthropic", configured: true, source: "env" },
    { provider: "openai", configured: true, source: "env" },
    { provider: "google", configured: false, source: "none" },
  ],
  callLimit: async () => ({ limit: 1000 }),
}));

import {
  AssistantRows,
  Runner,
  groupModels,
  heldLine,
  planLine,
  type RunnerModel,
  type RunnerPrompt,
} from "./Runner";
import { DEMO_READONLY_REASON } from "./DemoReadOnlyNote";

afterEach(cleanup);

const PROMPTS: RunnerPrompt[] = [
  { id: "p1", is_active: 1, archived: 0, iterations: 5 },
  { id: "p2", is_active: 1, archived: 0, iterations: 5 },
  { id: "p3", is_active: 1, archived: 0, iterations: 5 },
  { id: "p4", is_active: 0, archived: 0, iterations: 5 },
  { id: "p5", is_active: 1, archived: 1, iterations: 5 },
];

function renderRunner(locked: string | null = null, prompts: RunnerPrompt[] = PROMPTS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Runner, {
        projectId: "proj-1",
        locked,
        prompts,
      }),
    ),
  );
}

/* --------------------------------------------------------------- pure parts */

describe("groupModels", () => {
  const model = (id: string, provider: string): RunnerModel => ({
    id,
    provider,
    display_name: id,
    tier: "mid",
  });

  it("groups by provider in the shared order, whatever order the catalog arrives in", () => {
    const groups = groupModels([
      model("g1", "google"),
      model("c1", "anthropic"),
      model("o1", "openai"),
      model("c2", "anthropic"),
    ]);
    expect(groups.map((group) => group.provider)).toEqual(["anthropic", "openai", "google"]);
    expect(groups[0]?.models.map((entry) => entry.id)).toEqual(["c1", "c2"]);
  });
});

describe("planLine", () => {
  it("reconciles answers = assistants × prompts × iterations when every prompt repeats alike", () => {
    expect(planLine({ assistants: 2, prompts: 3, answers: 30, iterations: [5, 5, 5] })).toBe(
      "2 assistants × 3 prompts × 5 iterations = 30 answers",
    );
  });

  it("prints the iterations factor only when every active prompt repeats alike", () => {
    expect(planLine({ assistants: 2, prompts: 2, answers: 12, iterations: [3, 3] })).toBe(
      "2 assistants × 2 prompts × 3 iterations = 12 answers",
    );
    expect(planLine({ assistants: 2, prompts: 2, answers: 14, iterations: [3, 4] })).toBe(
      "2 assistants × 2 prompts = 14 answers",
    );
  });

  it("singularises every factor", () => {
    expect(planLine({ assistants: 1, prompts: 1, answers: 1, iterations: [1] })).toBe(
      "1 assistant × 1 prompt × 1 iteration = 1 answer",
    );
  });

  it("falls back to the totals when the library has not loaded", () => {
    expect(planLine({ assistants: 2, prompts: 3, answers: 30, iterations: [] })).toBe(
      "2 assistants × 3 prompts = 30 answers",
    );
  });

  it("never prints a factor that does not multiply out to the planner's answers", () => {
    // Two queries feed this line. While they disagree the equation is dropped,
    // not shown arithmetically false.
    expect(planLine({ assistants: 2, prompts: 3, answers: 28, iterations: [5, 5, 5] })).toBe(
      "2 assistants × 3 prompts = 28 answers",
    );
  });
});

describe("the held line", () => {
  it("holds rather than denies while the key check is in flight, and admits a failure", () => {
    expect(heldLine("checking")).toContain("Checking");
    expect(heldLine("failed")).toContain("could not check");
  });
});

/* ------------------------------------------------------------- selector rows */

describe("AssistantRows", () => {
  const groups = [
    {
      provider: "anthropic",
      models: [{ id: "c1", provider: "anthropic", display_name: "Claude One", tier: "mid" }],
    },
    {
      provider: "google",
      models: [{ id: "g1", provider: "google", display_name: "Gemini One", tier: "mid" }],
    },
  ];

  it("toggles a chip through the callback, marking the selected one pressed", () => {
    const onToggle = vi.fn();
    render(
      createElement(AssistantRows, {
        groups,
        selectedIds: new Set(["c1"]),
        keyedProviders: new Set(["anthropic", "google"]),
        keysUnresolved: false,
        keyCheckFailed: false,
        locked: null,
        onToggle,
      }),
    );
    expect(screen.getByRole("button", { name: /Claude One/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Gemini One/ }));
    expect(onToggle).toHaveBeenCalledWith("g1", true);
    fireEvent.click(screen.getByRole("button", { name: /Claude One/ }));
    expect(onToggle).toHaveBeenCalledWith("c1", false);
  });

  it("carries the tier in visible text on every chip", () => {
    render(
      createElement(AssistantRows, {
        groups,
        selectedIds: new Set(["c1"]),
        keyedProviders: new Set(["anthropic", "google"]),
        keysUnresolved: false,
        keyCheckFailed: false,
        locked: null,
        onToggle: vi.fn(),
      }),
    );
    expect(screen.getByRole("button", { name: "Claude One · mid" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gemini One · mid" })).toBeTruthy();
  });

  it("is one greyed row with the reason for a provider with no key", () => {
    render(
      createElement(AssistantRows, {
        groups,
        selectedIds: new Set<string>(),
        keyedProviders: new Set(["anthropic"]),
        keysUnresolved: false,
        keyCheckFailed: false,
        locked: null,
        onToggle: vi.fn(),
      }),
    );
    expect(screen.queryByRole("button", { name: /Gemini One/ })).toBeNull();
    expect(screen.getByText(/No Google key\. Set GOOGLE_API_KEY/)).toBeTruthy();
  });

  it("keeps a selected chip on a keyless row, so a model whose key disappeared can be switched off", () => {
    const onToggle = vi.fn();
    render(
      createElement(AssistantRows, {
        groups,
        selectedIds: new Set(["g1"]),
        keyedProviders: new Set(["anthropic"]),
        keysUnresolved: false,
        keyCheckFailed: false,
        locked: null,
        onToggle,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Gemini One/ }));
    expect(onToggle).toHaveBeenCalledWith("g1", false);
  });

  it("holds unselected models while the key check is in flight, but lets selected ones off", () => {
    render(
      createElement(AssistantRows, {
        groups,
        selectedIds: new Set(["c1"]),
        keyedProviders: new Set<string>(),
        keysUnresolved: true,
        keyCheckFailed: false,
        locked: null,
        onToggle: vi.fn(),
      }),
    );
    expect((screen.getByRole("button", { name: /Gemini One/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /Claude One/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // The held state is a visible line, not a tooltip nobody can reach.
    expect(screen.getByText(/Checking which provider keys are set/)).toBeTruthy();
  });

  it("disables everything when locked, with the demo reason", () => {
    render(
      createElement(AssistantRows, {
        groups,
        selectedIds: new Set(["c1"]),
        keyedProviders: new Set(["anthropic", "google"]),
        keysUnresolved: false,
        keyCheckFailed: false,
        locked: DEMO_READONLY_REASON,
        onToggle: vi.fn(),
      }),
    );
    expect((screen.getByRole("button", { name: /Claude One/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /Gemini One/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

/* ---------------------------------------------------------------- the block */

describe("Runner", () => {
  beforeEach(() => {
    runnerMocks.navigate.mockClear();
    runnerMocks.setProjectModel.mockClear();
    runnerMocks.createRun.mockClear();
    runnerMocks.plan.value = {
      prompts: 3,
      assistants: 2,
      answers: 30,
      calls: 60,
      perceptionCalls: 0,
    };
  });

  it("reconciles the plan, prices it, and lists the assistants it will ask", async () => {
    const { container } = renderRunner();
    expect(
      await screen.findByText(/2 assistants × 3 prompts × 5 iterations = 30 answers/),
    ).toBeTruthy();
    // Two selected assistants and a keyless provider row share the block.
    expect(screen.getByRole("button", { name: "Claude Mid · mid" })).toBeTruthy();
    expect(screen.getByText(/No Google key/)).toBeTruthy();
    // The estimate is the wizard's arithmetic (lib/run-estimate): two selected
    // assistants over 15 total iterations with the haiku extractor, at the
    // typical call sizes and the mocked list prices ($3.675, rounded down by
    // floating point like every other money figure in the app).
    await waitFor(() => expect(container.textContent).toMatch(/about \$3\.67 at list prices/));
  });

  it("starts the run through the confirmation and follows it to the run page", async () => {
    renderRunner();
    const run = await screen.findByRole("button", { name: /Run now/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    expect(await screen.findByRole("button", { name: /Start run/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start run/ }));
    await waitFor(() => expect(runnerMocks.createRun).toHaveBeenCalled());
    await waitFor(() =>
      expect(runnerMocks.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId: "proj-1", runId: "run-1" },
      }),
    );
  });

  it("carries the line's money sentence into the confirmation", async () => {
    const { container } = renderRunner();
    const run = await screen.findByRole("button", { name: /Run now/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    // The dialog quotes the same estimate the line above it already showed, so
    // the decision point and the lead-up cannot disagree.
    await waitFor(() => expect(container.textContent).toMatch(/about \$3\.67 at list prices/));
    fireEvent.click(run);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toMatch(/This run will cost about \$3\.67/));
  });

  it("shows the planner's refusal as a sentence and refuses to launch", async () => {
    runnerMocks.plan.value = new Error("NO_PROMPTS: add at least one active prompt");
    renderRunner();
    expect(await screen.findByText(/Add at least one active prompt/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Run now/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("locks every control with the demo reason on the demo project", async () => {
    renderRunner(DEMO_READONLY_REASON);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Claude Mid · mid" })).toBeTruthy(),
    );
    expect(
      (screen.getByRole("button", { name: "Claude Mid · mid" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const run = screen.getByRole("button", { name: /Run now/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.getAttribute("title")).toBe(DEMO_READONLY_REASON);
    expect(screen.getByText(DEMO_READONLY_REASON)).toBeTruthy();
  });

  it("saves an assistant toggle against the project", async () => {
    renderRunner();
    fireEvent.click(await screen.findByRole("button", { name: "Claude Mid · mid" }));
    await waitFor(() =>
      expect(runnerMocks.setProjectModel).toHaveBeenCalledWith({
        data: { projectId: "proj-1", modelId: "claude-mid", on: false },
      }),
    );
  });
});
