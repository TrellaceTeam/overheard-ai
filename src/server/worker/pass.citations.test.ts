/**
 * The pass with the real provider adapters and a stubbed transport: the
 * grounding URLs a Gemini answer carries must reach the stored answer text,
 * because extraction only credits a link that appears in the answer.
 * Everything else (claims, storage, usage) is mocked as in pass.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Driver } from "../db/driver";
import type { ModelRow, RunTaskRow } from "../db/types";
import type { ClaimedTask } from "../logic/types";

vi.mock("../logic/claim-tasks", () => ({
  claimTasks: vi.fn(),
  failExhaustedTasks: vi.fn(),
  DEFAULT_PROVIDER_CAPS: { openai: 6, anthropic: 6, google: 3 },
}));
vi.mock("../logic/recovery", () => ({ reapStuckTasks: vi.fn(), bootRecovery: vi.fn() }));
vi.mock("../logic/finalize-run", () => ({ finalizeRun: vi.fn() }));
vi.mock("../logic/update-run-progress", () => ({ updateRunProgress: vi.fn() }));
vi.mock("../logic/usage", () => ({ recordUsageEvent: vi.fn() }));
vi.mock("../logic/store-answer", () => ({
  storeAnswer: vi.fn(),
  storeExtraction: vi.fn(),
  failTask: vi.fn(),
  releaseTaskForRetry: vi.fn(),
  backoffAt: vi.fn(() => "2026-01-01T00:00:00.000Z"),
}));
vi.mock("./brand-enrichment", () => ({
  enrichNewBrands: vi.fn(),
  autoTrackTopCompetitor: vi.fn(),
}));
vi.mock("../logic/perception-summary", () => ({ writePerceptionSummary: vi.fn() }));
vi.mock("./queries", () => ({
  countPendingTasks: vi.fn(() => 1),
  countPerceptionTasks: vi.fn(() => 0),
  getModel: vi.fn(),
  getPreferredExtractionModelId: vi.fn(() => null),
  getStoredAnswerText: vi.fn(() => ""),
  getStoredCaps: vi.fn(() => ({ openai: null, anthropic: null, google: null })),
  insertDiscoveredBrand: vi.fn(() => null),
  listDonePerceptionTasks: vi.fn(() => []),
  listExtractionCandidates: vi.fn(() => []),
  listFinalisationCandidates: vi.fn(() => []),
  listMatchableBrands: vi.fn(() => []),
  listModelDisplayNames: vi.fn(() => new Map()),
  listPerAssistantSummaries: vi.fn(() => []),
  markTaskDone: vi.fn(),
  targetBrandName: vi.fn(() => "Acme Analytics"),
}));

import { claimTasks } from "../logic/claim-tasks";
import { storeAnswer } from "../logic/store-answer";
import { runWorkerPass } from "./pass";
import { getModel } from "./queries";

const db = {} as Driver;

const GEMINI_MODEL: ModelRow = {
  id: "b9e060b8-0fc3-4bb2-8b67-a43518acd777",
  provider: "google",
  model_id: "gemini-3.6-flash",
  display_name: "Gemini 3.6 Flash",
  tier: "mid",
  supports_web_search: 1,
  input_price_per_mtok: 2,
  output_price_per_mtok: 12,
  search_price_per_call: 0.014,
  is_extraction_model: 0,
  extraction_rank: null,
  is_active: 1,
  created_at: "2026-01-01T00:00:00.000Z",
};

function task(patch: Partial<RunTaskRow> = {}): RunTaskRow {
  return {
    id: "task-1",
    run_id: "run-1",
    project_id: "project-1",
    prompt_id: "prompt-1",
    model_id: GEMINI_MODEL.id,
    iteration: 1,
    question_text: "Which CRM should a small consulting team buy?",
    is_perception: 0,
    status: "in_flight",
    attempts: 1,
    next_attempt_at: "2026-01-01T00:00:00.000Z",
    locked_at: "2026-01-01T00:00:00.000Z",
    locked_by: "worker-1",
    answer_text: null,
    answer_tokens: null,
    latency_ms: null,
    provider_cost_usd: null,
    error: null,
    failure_code: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function claimedGemini(): ClaimedTask {
  return {
    task: task(),
    phase: "in_flight",
    provider: "google",
    providerModelId: "gemini-3.6-flash",
    supportsWebSearch: true,
  };
}

/** Shaped like a real Gemini grounding response. Fixture brands are fictional. */
function geminiResponse(candidate: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      candidates: [candidate],
      usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 683, totalTokenCount: 753 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["GOOGLE_API_KEY"] = "AIza-test-key";
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  (getModel as Mock).mockReturnValue(GEMINI_MODEL);
  (claimTasks as Mock).mockImplementation(() => []);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["GOOGLE_API_KEY"];
});

describe("Gemini citations reaching the stored answer", () => {
  it("stores the grounding sources beside the claims they support", async () => {
    const answer =
      "Acme Analytics suits visual pipeline work. Northwind Metrics suits inbound teams.";
    const acmeEnd = answer.indexOf(".") + 1;
    vi.stubGlobal("fetch", async () =>
      geminiResponse({
        content: { parts: [{ text: answer }] },
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["best CRM for small consulting teams"],
          groundingChunks: [
            {
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA",
                title: "acme-analytics.example",
              },
            },
            {
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB",
                title: "northwind-metrics.example",
              },
            },
          ],
          groundingSupports: [
            { segment: { endIndex: acmeEnd }, groundingChunkIndices: [0] },
            { segment: { endIndex: answer.length }, groundingChunkIndices: [1] },
          ],
        },
      }),
    );
    (claimTasks as Mock).mockReturnValueOnce([claimedGemini()]).mockReturnValue([]);

    await runWorkerPass(db);

    // The opaque redirect URI is never stored. The chunk's source domain is,
    // as a URL, beside the segment groundingSupports ties it to.
    expect(storeAnswer).toHaveBeenCalledWith(
      db,
      "task-1",
      expect.objectContaining({
        answerText:
          "Acme Analytics suits visual pipeline work. [https://acme-analytics.example] Northwind Metrics suits inbound teams. [https://northwind-metrics.example]",
      }),
    );
  });
});
