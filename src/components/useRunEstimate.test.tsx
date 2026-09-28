// @vitest-environment jsdom
/**
 * The shared estimate the Runner line and both Run now dialogs read. The
 * arithmetic itself is lib/run-estimate's and is tested there. This pins the
 * hook's own promises: nothing is priced until the plan exists, nothing is
 * priced until every input has resolved, and perception is counted only while
 * the planner says the next run adds it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunPlan } from "@/components/types";

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(async () => [
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
  ]),
  listProjectModels: vi.fn(async () => [
    { modelId: "claude-mid", provider: "anthropic", displayName: "Claude Mid" },
    { modelId: "gpt-mid", provider: "openai", displayName: "GPT Mid" },
  ]),
  listExtractionModels: vi.fn(async () => [
    {
      id: "haiku",
      provider: "anthropic",
      display_name: "Claude Haiku",
      tier: "small",
      input_price_per_mtok: 1,
      output_price_per_mtok: 5,
      search_price_per_call: 0,
    },
  ]),
  getProjectSettings: vi.fn(async () => ({
    extractionModelId: "haiku",
    extractionPrompt: "read",
    extractionPromptDefault: "read",
  })),
}));

vi.mock("@/server/api/models", () => ({
  listModels: mocks.listModels,
  listProjectModels: mocks.listProjectModels,
  listExtractionModels: mocks.listExtractionModels,
}));
vi.mock("@/server/api/projects", () => ({
  getProjectSettings: mocks.getProjectSettings,
}));

import { useRunEstimate, type EstimatePrompt } from "./useRunEstimate";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PROMPTS: EstimatePrompt[] = [
  { is_active: 1, archived: 0, iterations: 5 },
  { is_active: 1, archived: 0, iterations: 5 },
  { is_active: 1, archived: 0, iterations: 5 },
  { is_active: 0, archived: 0, iterations: 5 },
  { is_active: 1, archived: 1, iterations: 5 },
];

const PLAN: RunPlan = { prompts: 3, assistants: 2, answers: 30, calls: 60, perceptionCalls: 0 };

function renderEstimate(plan: RunPlan | undefined, prompts: readonly EstimatePrompt[] | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useRunEstimate({ projectId: "proj-1", prompts, plan }), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
}

describe("useRunEstimate", () => {
  it("prices nothing, and fetches nothing, until the plan exists", () => {
    const { result } = renderEstimate(undefined, PROMPTS);
    expect(result.current).toBeNull();
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(mocks.getProjectSettings).not.toHaveBeenCalled();
  });

  it("prices the wizard's way once every input has resolved", async () => {
    // Two selected assistants over 15 active unarchived iterations with the
    // haiku extractor, at the mocked list prices: the same $3.675 the Runner
    // line rounds to $3.67.
    const { result } = renderEstimate(PLAN, PROMPTS);
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBeCloseTo(3.675, 3);
  });

  it("holds back while an input is missing, rather than pricing without it", async () => {
    const { result } = renderEstimate(PLAN, undefined);
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("counts perception only while the planner says the next run adds it", async () => {
    const withoutPerception = renderEstimate(PLAN, PROMPTS);
    await waitFor(() => expect(withoutPerception.result.current).not.toBeNull());
    const withPerception = renderEstimate({ ...PLAN, perceptionCalls: 6 }, PROMPTS);
    await waitFor(() => expect(withPerception.result.current).not.toBeNull());
    expect(withPerception.result.current ?? 0).toBeGreaterThan(
      withoutPerception.result.current ?? 0,
    );
  });
});
