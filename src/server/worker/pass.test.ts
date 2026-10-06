import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Driver } from "../db/driver";
import type { ModelRow, RunTaskRow } from "../db/types";
import type { ClaimedTask } from "../logic/types";

// Every logic function and every raw statement is mocked. This file tests the
// dispatch and the ordering, which is all pass.ts owns. Tests with a real
// database and the real logic layer live elsewhere.
vi.mock("../logic/claim-tasks", () => ({
  claimTasks: vi.fn(),
  failExhaustedTasks: vi.fn(),
  // Mirrored instead of importOriginal'd, so the pass never touches the real
  // claim SQL.
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
  // The retry schedule lives in store-answer, so the mock has to provide it.
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
  getExtractionPrompt: vi.fn(() => null),
  getPreferredExtractionModelId: vi.fn(() => null),
  getStoredAnswerText: vi.fn(() => ""),
  getStoredCaps: vi.fn(),
  insertDiscoveredBrand: vi.fn(() => null),
  listActiveModels: vi.fn(() => []),
  listDonePerceptionTasks: vi.fn(() => []),
  listExtractionCandidates: vi.fn(() => []),
  listFinalisationCandidates: vi.fn(() => []),
  listMatchableBrands: vi.fn(() => []),
  listModelDisplayNames: vi.fn(() => new Map()),
  listPerAssistantSummaries: vi.fn(() => []),
  markTaskDone: vi.fn(),
  targetBrandName: vi.fn(() => "Acme Analytics"),
}));
vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return { ...actual, callProvider: vi.fn(), callExtractionModel: vi.fn() };
});

import { claimTasks } from "../logic/claim-tasks";
import { finalizeRun } from "../logic/finalize-run";
import { reapStuckTasks } from "../logic/recovery";
import { failTask, releaseTaskForRetry, storeAnswer, storeExtraction } from "../logic/store-answer";
import { updateRunProgress } from "../logic/update-run-progress";
import { recordUsageEvent } from "../logic/usage";
import { autoTrackTopCompetitor, enrichNewBrands } from "./brand-enrichment";
import { BATCH_SIZE, costOf, runWorkerPass, worstCaseCost } from "./pass";
import { EXTRACTION_SHAPE } from "./extraction";
import {
  callExtractionModel,
  callProvider,
  ProviderError,
  RAISED_TIMEOUT_MS,
  TIMEOUT_MS,
} from "./providers";
import {
  countPendingTasks,
  getExtractionPrompt,
  getModel,
  getStoredAnswerText,
  getStoredCaps,
  listActiveModels,
  listExtractionCandidates,
  listFinalisationCandidates,
  markTaskDone,
} from "./queries";
import { writePerceptionSummary } from "../logic/perception-summary";
import { INFLIGHT_CAP_MAX } from "@/lib/inflight-caps";

const db = {} as Driver;

const NOTHING_SAVED = { openai: null, anthropic: null, google: null };

const ANSWER_MODEL: ModelRow = {
  id: "model-sonnet",
  provider: "anthropic",
  model_id: "claude-sonnet-5",
  display_name: "Claude Sonnet 5",
  tier: "mid",
  supports_web_search: 1,
  input_price_per_mtok: 3,
  output_price_per_mtok: 15,
  search_price_per_call: 0.01,
  is_extraction_model: 0,
  extraction_rank: null,
  superseded: 0,
  is_active: 1,
  created_at: "2026-01-01T00:00:00.000Z",
};

const EXTRACTION_MODEL: ModelRow = {
  ...ANSWER_MODEL,
  id: "model-luna",
  provider: "openai",
  model_id: "gpt-5.6-luna",
  display_name: "GPT-5.6 Luna",
  tier: "extraction",
  supports_web_search: 0,
  input_price_per_mtok: 0.2,
  output_price_per_mtok: 1.2,
  search_price_per_call: 0,
  is_extraction_model: 1,
  extraction_rank: 1,
};

/** The ladder's second rung: the same provider's next tier up. */
const TERRA_MODEL: ModelRow = {
  ...EXTRACTION_MODEL,
  id: "model-terra",
  model_id: "gpt-5.6-terra",
  display_name: "GPT-5.6 Terra",
  tier: "mid",
  supports_web_search: 1,
  input_price_per_mtok: 2,
  output_price_per_mtok: 12,
  search_price_per_call: 0.01,
  is_extraction_model: 0,
  extraction_rank: null,
};

function task(patch: Partial<RunTaskRow> = {}): RunTaskRow {
  return {
    id: "task-1",
    run_id: "run-1",
    project_id: "project-1",
    prompt_id: "prompt-1",
    model_id: "model-sonnet",
    iteration: 1,
    question_text: "Which analytics tool should a mid-market team buy?",
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

function claimed(patch: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    task: task(),
    phase: "in_flight",
    provider: "anthropic",
    providerModelId: "claude-sonnet-5",
    supportsWebSearch: true,
    ...patch,
  };
}

/** One batch, then nothing, so the loop runs once. */
function claimOnce(batch: ClaimedTask[]) {
  (claimTasks as Mock).mockReturnValueOnce(batch).mockReturnValue([]);
}

const EXTRACTOR_JSON = JSON.stringify({
  answer_format: "ranked_list",
  total_items: 1,
  brands: [{ name: "Acme Analytics", position: 1, mention_type: "ranked", evidence: "First." }],
});

function providerResult(text: string) {
  return { text, inputTokens: 100, outputTokens: 200, tokens: 300, searchCalls: 2 };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
  process.env["OPENAI_API_KEY"] = "sk-test-key";
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  (getModel as Mock).mockReturnValue(ANSWER_MODEL);
  (listExtractionCandidates as Mock).mockReturnValue([EXTRACTION_MODEL]);
  (countPendingTasks as Mock).mockReturnValue(1);
  (listFinalisationCandidates as Mock).mockReturnValue([]);
  (getStoredCaps as Mock).mockReturnValue(NOTHING_SAVED);
});

describe("the pass", () => {
  it("reaps first, then claims BATCH_SIZE tasks under the given lock", async () => {
    claimOnce([]);
    const now = new Date("2026-02-01T00:00:00.000Z");
    await runWorkerPass(db, { lockedBy: "worker-9", now });
    expect(reapStuckTasks).toHaveBeenCalledWith(db, now);
    expect(claimTasks).toHaveBeenCalledWith(
      db,
      BATCH_SIZE,
      "worker-9",
      { openai: 6, anthropic: 6, google: 3 },
      expect.any(Function),
    );
  });

  it("reads the saved caps on every pass, so a change applies with no restart", async () => {
    (claimTasks as Mock).mockReturnValue([]);
    (getStoredCaps as Mock)
      .mockReturnValueOnce({ ...NOTHING_SAVED, openai: 2 })
      .mockReturnValueOnce({ ...NOTHING_SAVED, openai: 2, google: 9 });

    await runWorkerPass(db);
    await runWorkerPass(db);

    expect(getStoredCaps).toHaveBeenCalledWith(db);
    expect((claimTasks as Mock).mock.calls.map((call) => call[3])).toEqual([
      { openai: 2, anthropic: 6, google: 3 },
      { openai: 2, anthropic: 6, google: 9 },
    ]);
  });

  it("claims no more per batch than the highest cap Account settings accepts", () => {
    expect(BATCH_SIZE).toBe(INFLIGHT_CAP_MAX);
  });

  it("stops as soon as a claim comes back empty", async () => {
    (claimTasks as Mock).mockReturnValue([]);
    const result = await runWorkerPass(db, { budgetMs: 5_000 });
    expect(claimTasks).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(0);
  });

  it("counts every claimed task as processed, however it ended", async () => {
    (callProvider as Mock).mockRejectedValue(
      new ProviderError("HTTP 500: upstream", 500, "HTTP:500"),
    );
    claimOnce([claimed(), claimed({ task: task({ id: "task-2" }) })]);
    const result = await runWorkerPass(db);
    expect(result.processed).toBe(2);
  });
});

describe("the answer phase", () => {
  it("persists the answer, logs the call and refreshes the run", async () => {
    (callProvider as Mock).mockResolvedValue({
      ...providerResult("Acme Analytics leads on coverage."),
      model: "answerer-2026-09-22",
    });
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(storeAnswer).toHaveBeenCalledWith(db, "task-1", {
      answerText: "Acme Analytics leads on coverage.",
      answerTokens: 300,
      latencyMs: expect.any(Number),
      providerCostUsd: expect.any(Number),
      // The version the provider reported, stored beside the catalogue model.
      answerModel: "answerer-2026-09-22",
    });
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "answer", outcome: "success", searchCalls: 2 }),
    );
    expect(updateRunProgress).toHaveBeenCalledWith(db, "run-1");
    // Nothing extraction-shaped happens in this phase. The extraction call is
    // bought on a separate claim.
    expect(storeExtraction).not.toHaveBeenCalled();
  });

  it("always asks answers with web search when the catalog supports it", async () => {
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([claimed()]);
    await runWorkerPass(db);
    expect(callProvider).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "sk-ant-test-key",
      system: expect.any(String),
      user: "Which analytics tool should a mid-market team buy?",
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: TIMEOUT_MS,
    });
  });

  it("asks the assistant to cite its sources with URLs", async () => {
    // Anthropic's text-block citations are model-initiated, so an answer
    // carries links only when asked for them. One wording serves all three
    // providers.
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([claimed()]);
    await runWorkerPass(db);
    expect(callProvider).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "sk-ant-test-key",
      system: expect.stringContaining("URL"),
      user: expect.any(String),
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: TIMEOUT_MS,
    });
  });

  it("gives a retry of a timed-out call the raised budget", async () => {
    // The claimed row carries the phase's last failure reason, the same read
    // the Gemini search pressure uses, so a call that ran past 240s once gets
    // 360s.
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([
      claimed({
        task: task({
          status: "queued",
          error: "TIMEOUT after 240004ms of a 240000ms budget: The operation timed out",
        }),
      }),
    ]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: RAISED_TIMEOUT_MS }),
    );
  });

  it("reads a deadline the shared budget ran out of as a timeout too", async () => {
    // Anthropic's pause-turn resumes share one deadline, and running out of it
    // raises DEADLINE_EXCEEDED instead of TIMEOUT. The failure card and the
    // budget picker read both as timeouts.
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([
      claimed({
        task: task({ status: "queued", error: "DEADLINE_EXCEEDED: no time left for this call" }),
      }),
    ]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: RAISED_TIMEOUT_MS }),
    );
  });

  it("fails an answer that came back without a web search, and retries it", async () => {
    (callProvider as Mock).mockResolvedValue({
      ...providerResult("An answer from memory."),
      searchCalls: 0,
    });
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(releaseTaskForRetry).toHaveBeenCalledWith(
      db,
      "task-1",
      "NO_WEB_SEARCH",
      expect.stringMatching(/^NO_WEB_SEARCH/),
      expect.any(String),
    );
    expect(storeAnswer).not.toHaveBeenCalled();
    // The provider generated, so the call is logged as spent.
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "answer", outcome: "failed" }),
    );
  });

  it("does not require a search from a model the catalog says cannot search", async () => {
    (callProvider as Mock).mockResolvedValue({ ...providerResult("text"), searchCalls: 0 });
    claimOnce([claimed({ supportsWebSearch: false })]);
    await runWorkerPass(db);
    expect(storeAnswer).toHaveBeenCalled();
  });

  it("fails the task outright when there is no question to ask", async () => {
    claimOnce([claimed({ task: task({ question_text: null }) })]);
    await runWorkerPass(db);
    expect(failTask).toHaveBeenCalledWith(
      db,
      "task-1",
      "PROMPT_MISSING",
      expect.stringContaining("PROMPT_MISSING"),
    );
    expect(callProvider).not.toHaveBeenCalled();
  });

  it("fails the task outright when the provider has no key", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    claimOnce([claimed()]);
    await runWorkerPass(db);
    expect(failTask).toHaveBeenCalledWith(
      db,
      "task-1",
      "MISSING_CREDENTIAL:anthropic",
      "MISSING_CREDENTIAL:anthropic",
    );
  });

  it("says why an answer was empty, and retries it", async () => {
    (callProvider as Mock).mockResolvedValue({
      ...providerResult("   "),
      stopReason: "max_tokens",
    });
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(releaseTaskForRetry).toHaveBeenCalledWith(
      db,
      "task-1",
      "EMPTY_ANSWER:max_tokens",
      "EMPTY_ANSWER: stop_reason=max_tokens",
      expect.any(String),
    );
    // A turn that generated and returned nothing still cost something.
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "answer", outcome: "failed" }),
    );
    expect(storeAnswer).not.toHaveBeenCalled();
  });

  it("retries a 429 and fails a 400 outright", async () => {
    (callProvider as Mock).mockRejectedValueOnce(
      new ProviderError("HTTP 429: slow down", 429, "HTTP:429"),
    );
    claimOnce([claimed()]);
    await runWorkerPass(db);
    expect(releaseTaskForRetry).toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();

    vi.clearAllMocks();
    (getModel as Mock).mockReturnValue(ANSWER_MODEL);
    (listFinalisationCandidates as Mock).mockReturnValue([]);
    (callProvider as Mock).mockRejectedValueOnce(
      new ProviderError(
        "WEB_SEARCH_FAILED: max_uses_exceeded",
        400,
        "WEB_SEARCH_FAILED:max_uses_exceeded",
      ),
    );
    claimOnce([claimed()]);
    await runWorkerPass(db);
    expect(failTask).toHaveBeenCalledWith(
      db,
      "task-1",
      "WEB_SEARCH_FAILED:max_uses_exceeded",
      "WEB_SEARCH_FAILED: max_uses_exceeded",
    );
    expect(releaseTaskForRetry).not.toHaveBeenCalled();
  });

  it("scrubs a key out of a stored error", async () => {
    (callProvider as Mock).mockRejectedValue(
      new Error("HTTP 401: key sk-abcdefgh12345678 rejected"),
    );
    claimOnce([claimed()]);
    await runWorkerPass(db);
    const stored = (releaseTaskForRetry as Mock).mock.calls[0]?.[3] as string;
    expect(stored).not.toContain("sk-abcdefgh12345678");
    expect(stored).toContain("sk-***");
  });
});

describe("Gemini retry pressure", () => {
  const GEMINI_MODEL: ModelRow = {
    ...ANSWER_MODEL,
    id: "model-flash",
    provider: "google",
    model_id: "gemini-3.6-flash",
    display_name: "Gemini 3.6 Flash",
    search_price_per_call: 0.014,
  };

  const geminiClaimed = (patch: Partial<RunTaskRow> = {}) =>
    claimed({
      task: task({ model_id: "model-flash", ...patch }),
      provider: "google",
      providerModelId: "gemini-3.6-flash",
    });

  beforeEach(() => {
    process.env["GOOGLE_API_KEY"] = "AIza-test-key";
    (getModel as Mock).mockReturnValue(GEMINI_MODEL);
  });

  afterEach(() => {
    delete process.env["GOOGLE_API_KEY"];
  });

  it("prepends explicit pressure to a NO_WEB_SEARCH retry, whose tool is discretionary", async () => {
    // Gemini has no wire-level force mode, so a retry can only push for the
    // skipped search in words.
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([
      geminiClaimed({
        attempts: 2,
        error: "NO_WEB_SEARCH: the assistant answered without searching the web",
      }),
    ]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.6-flash",
      apiKey: "AIza-test-key",
      system: expect.any(String),
      user: expect.stringMatching(
        /^You must use the Google Search tool before answering\.\n\nWhich analytics tool should a mid-market team buy\?$/,
      ),
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: TIMEOUT_MS,
    });
  });

  it("tells a model that cannot be forced to search to search, in the system prompt", async () => {
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([geminiClaimed()]);

    await runWorkerPass(db);

    const sent = (callProvider as Mock).mock.calls[0]?.[0] as { system: string; user: string };
    expect(sent.system).toMatch(/Search the web before you answer\.$/);
    expect(sent.user).toBe("Which analytics tool should a mid-market team buy?");
  });

  it("leaves the system prompt alone for a model whose search is forced", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    (getModel as Mock).mockReturnValue(ANSWER_MODEL);
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([claimed()]);

    await runWorkerPass(db);

    const sent = (callProvider as Mock).mock.calls[0]?.[0] as { system: string };
    expect(sent.system).not.toContain("Search the web before you answer.");
  });

  it("asks a first attempt with the question verbatim", async () => {
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([geminiClaimed()]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.6-flash",
      apiKey: "AIza-test-key",
      system: expect.any(String),
      user: "Which analytics tool should a mid-market team buy?",
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: TIMEOUT_MS,
    });
  });

  it("does not touch a retry that failed for a different reason", async () => {
    // The different reason here is a timeout: no search pressure on the
    // question, but the budget picker reads the same stored reason and raises.
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([geminiClaimed({ attempts: 2, error: "TIMEOUT after 240000ms" })]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.6-flash",
      apiKey: "AIza-test-key",
      system: expect.any(String),
      user: "Which analytics tool should a mid-market team buy?",
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: RAISED_TIMEOUT_MS,
    });
  });

  it("pressures a manually retried task, whose attempts reset but whose reason stays", async () => {
    // retryFailedTasks keeps the last error and resets attempts to 0, so the
    // re-claimed row looks like this: first attempt of the retry, reason
    // NO_WEB_SEARCH. The pressure keys off the reason, not the counter.
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([
      geminiClaimed({
        attempts: 1,
        error: "NO_WEB_SEARCH: the assistant answered without searching the web",
      }),
    ]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.6-flash",
      apiKey: "AIza-test-key",
      system: expect.any(String),
      user: expect.stringMatching(/^You must use the Google Search tool before answering\./),
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: TIMEOUT_MS,
    });
  });

  it("pressures an Anthropic model that rejects forced tools, naming its own tool", async () => {
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([
      claimed({
        task: task({
          attempts: 2,
          error: "NO_WEB_SEARCH: the assistant answered without searching the web",
        }),
        providerModelId: "claude-opus-5-5",
      }),
    ]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        user: "You must use the web search tool before answering.\n\nWhich analytics tool should a mid-market team buy?",
      }),
    );
  });

  it("never pressures an Anthropic model whose wire already forces the search", async () => {
    (callProvider as Mock).mockResolvedValue(providerResult("text"));
    claimOnce([
      claimed({
        task: task({
          attempts: 2,
          error: "NO_WEB_SEARCH: the assistant answered without searching the web",
        }),
      }),
    ]);

    await runWorkerPass(db);

    expect(callProvider).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "sk-ant-test-key",
      system: expect.any(String),
      user: "Which analytics tool should a mid-market team buy?",
      jsonMode: false,
      webSearch: true,
      maxTokens: 8192,
      timeoutMs: TIMEOUT_MS,
    });
  });
});

describe("rejected-answer usage", () => {
  it("logs a NO_WEB_SEARCH rejection's reported usage, not the worst-case estimate", async () => {
    // Worst-case estimates badly overstate a call that reported its real usage.
    (callProvider as Mock).mockResolvedValue({
      ...providerResult("An answer from memory."),
      searchCalls: 0,
    });
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "answer",
        outcome: "failed",
        inputTokens: 100,
        outputTokens: 200,
        searchCalls: 0,
        costUsd: expect.closeTo(0.0033, 8),
      }),
    );
  });

  it("logs an EMPTY_ANSWER rejection's reported usage", async () => {
    (callProvider as Mock).mockResolvedValue({
      ...providerResult("   "),
      stopReason: "max_tokens",
    });
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "answer",
        outcome: "failed",
        inputTokens: 100,
        outputTokens: 200,
        searchCalls: 2,
      }),
    );
  });

  it("logs a failed search's real usage even though a 400 is never an estimate case", async () => {
    // WEB_SEARCH_FAILED with max_uses_exceeded is a 400, which mayHaveBilled
    // treats as unbilled, yet the searches ran and were billed. The error
    // carries the response's usage so the row can be real.
    (callProvider as Mock).mockRejectedValue(
      new ProviderError(
        "WEB_SEARCH_FAILED: max_uses_exceeded",
        400,
        "WEB_SEARCH_FAILED:max_uses_exceeded",
        {
          inputTokens: 5_000,
          outputTokens: 10,
          searchCalls: 5,
        },
      ),
    );
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(failTask).toHaveBeenCalled();
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "answer",
        outcome: "failed",
        inputTokens: 5_000,
        outputTokens: 10,
        searchCalls: 5,
        costUsd: expect.closeTo(0.06515, 8),
      }),
    );
  });

  it("falls back to the worst-case estimate when a billed failure reports no usage", async () => {
    (callProvider as Mock).mockRejectedValue(
      new ProviderError("HTTP 500: upstream", 500, "HTTP:500"),
    );
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "answer",
        outcome: "failed",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: worstCaseCost(ANSWER_MODEL, "answer"),
        costEstimated: true,
      }),
    );
  });

  it("logs a timed-out call at the worst-case estimate, because the provider still bills it", async () => {
    (callProvider as Mock).mockRejectedValue(
      new ProviderError(
        "TIMEOUT after 240004ms of a 240000ms budget: The operation timed out",
        0,
        "TIMEOUT",
      ),
    );
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "answer",
        outcome: "failed",
        costUsd: worstCaseCost(ANSWER_MODEL, "answer"),
        costEstimated: true,
      }),
    );
  });

  it("logs nothing for a network error before any response", async () => {
    (callProvider as Mock).mockRejectedValue(new ProviderError("fetch failed", 0, "NETWORK"));
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).not.toHaveBeenCalled();
  });

  it("reads an all-zero usage report as nothing reported, never as a real $0 call", async () => {
    // Anthropic's adapter defaults missing usage fields to 0 rather than null,
    // so the never-zero floor has to key on "reported anything", not on
    // "reported non-null".
    (callProvider as Mock).mockRejectedValue(
      new ProviderError(
        "WEB_SEARCH_FAILED: too_many_requests",
        429,
        "WEB_SEARCH_FAILED:too_many_requests",
        {
          inputTokens: 0,
          outputTokens: 0,
          searchCalls: 0,
        },
      ),
    );
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        outcome: "failed",
        costUsd: worstCaseCost(ANSWER_MODEL, "answer"),
      }),
    );
  });

  it("never records zero for a rejection whose response reported nothing", async () => {
    (callProvider as Mock).mockResolvedValue({
      text: "From memory.",
      inputTokens: null,
      outputTokens: null,
      tokens: null,
      searchCalls: 0,
    });
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        outcome: "failed",
        costUsd: worstCaseCost(ANSWER_MODEL, "answer"),
      }),
    );
  });

  it("records nothing for a rejection that never reached the provider", async () => {
    (callProvider as Mock).mockRejectedValue(
      new ProviderError("MISSING_CREDENTIAL:anthropic", 400, "MISSING_CREDENTIAL:anthropic"),
    );
    claimOnce([claimed()]);

    await runWorkerPass(db);

    expect(recordUsageEvent).not.toHaveBeenCalled();
  });
});

describe("the extraction phase", () => {
  const extracting = () =>
    claimed({
      task: task({ status: "extracting", attempts: 1 }),
      phase: "extracting",
      provider: "openai",
      providerModelId: "gpt-5.6-luna",
    });

  it("reads the stored answer rather than the claimed row, then stores the rows", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("1. Acme Analytics is best.");
    (callExtractionModel as Mock).mockResolvedValue(providerResult(EXTRACTOR_JSON));
    claimOnce([extracting()]);

    await runWorkerPass(db);

    expect(getStoredAnswerText).toHaveBeenCalledWith(db, "task-1");
    expect(storeExtraction).toHaveBeenCalledWith(db, "task-1", {
      answerFormat: "ranked_list",
      totalItems: 1,
      rawJson: expect.objectContaining({ answer_format: "ranked_list" }),
      modelUsed: "openai/gpt-5.6-luna",
      observations: [
        expect.objectContaining({ rawName: "Acme Analytics", position: 1, brandId: null }),
      ],
    });
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "extraction", outcome: "success" }),
    );
  });

  it("extracts through the shared adapter with the canonical prompt and the enforced shape", async () => {
    // JSON mode, no search and the 2,048-token cap live inside
    // callExtractionModel and are tested in providers.test.ts.
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (callExtractionModel as Mock).mockResolvedValue(providerResult(EXTRACTOR_JSON));
    claimOnce([extracting()]);
    await runWorkerPass(db);
    expect(callExtractionModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model_id: "gpt-5.6-luna" }),
      expect.stringContaining("You extract brand mentions"),
      expect.stringContaining("an answer"),
      { jsonSchema: EXTRACTION_SHAPE, timeoutMs: TIMEOUT_MS },
    );
    expect(callProvider).not.toHaveBeenCalled();
  });

  it("extracts with the project's own prompt when it has one", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (getExtractionPrompt as Mock).mockReturnValue("Count every brand named, strictly in JSON.");
    (callExtractionModel as Mock).mockResolvedValue(providerResult(EXTRACTOR_JSON));
    claimOnce([extracting()]);

    await runWorkerPass(db);

    expect(getExtractionPrompt).toHaveBeenCalledWith(db, "project-1");
    expect(callExtractionModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model_id: "gpt-5.6-luna" }),
      "Count every brand named, strictly in JSON.",
      expect.stringContaining("an answer"),
      { jsonSchema: EXTRACTION_SHAPE, timeoutMs: TIMEOUT_MS },
    );
  });

  it("gives a retry of a timed-out extraction the raised budget, on every rung", async () => {
    // The failure history belongs to the task, not to one reader, so the whole
    // ladder shares the raised budget when the last attempt timed out.
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (callExtractionModel as Mock).mockResolvedValue(providerResult(EXTRACTOR_JSON));
    claimOnce([
      claimed({
        task: task({
          status: "extracting",
          attempts: 1,
          error: "TIMEOUT after 240004ms of a 240000ms budget: The operation timed out",
        }),
        phase: "extracting",
        provider: "openai",
        providerModelId: "gpt-5.6-luna",
      }),
    ]);

    await runWorkerPass(db);

    expect(callExtractionModel).toHaveBeenCalledWith(
      expect.objectContaining({ model_id: "gpt-5.6-luna" }),
      expect.any(String),
      expect.any(String),
      { jsonSchema: EXTRACTION_SHAPE, timeoutMs: RAISED_TIMEOUT_MS },
    );
  });

  it("fails without retry when there is no stored answer to score", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("");
    claimOnce([extracting()]);
    await runWorkerPass(db);
    expect(failTask).toHaveBeenCalledWith(
      db,
      "task-1",
      "NO_ANSWER_TO_EXTRACT",
      "NO_ANSWER_TO_EXTRACT",
    );
    expect(callExtractionModel).not.toHaveBeenCalled();
  });

  it("fails without retry when no configured provider can extract", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (listExtractionCandidates as Mock).mockReturnValue([]);
    claimOnce([extracting()]);
    await runWorkerPass(db);
    expect(failTask).toHaveBeenCalledWith(
      db,
      "task-1",
      "NO_EXTRACTION_CREDENTIAL",
      "NO_EXTRACTION_CREDENTIAL",
    );
  });

  it("re-reads a wrong-shape answer with the next rung, inside the same claim, and logs the discarded one", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    // The ladder's second rung: the same provider's next tier up.
    (listActiveModels as Mock).mockReturnValue([EXTRACTION_MODEL, TERRA_MODEL]);
    (callExtractionModel as Mock)
      .mockResolvedValueOnce(providerResult("not json at all"))
      .mockResolvedValueOnce(providerResult(EXTRACTOR_JSON));
    claimOnce([extracting()]);

    await runWorkerPass(db);

    expect(callExtractionModel).toHaveBeenCalledTimes(2);
    expect(callExtractionModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model_id: "gpt-5.6-terra" }),
      expect.any(String),
      expect.any(String),
      { jsonSchema: EXTRACTION_SHAPE, timeoutMs: TIMEOUT_MS },
    );
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "extraction",
        outcome: "retried",
        modelId: "gpt-5.6-luna",
      }),
    );
    // The extractions row names the reader that actually read it.
    expect(storeExtraction).toHaveBeenCalledWith(
      db,
      "task-1",
      expect.objectContaining({ modelUsed: "openai/gpt-5.6-terra" }),
    );
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "extraction", outcome: "success", modelId: "gpt-5.6-terra" }),
    );
    // The task never left its extracting state on the way: no release, no fail.
    expect(releaseTaskForRetry).not.toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
  });

  it("fails on the unreadable code when the whole ladder violated, and logs every rung", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (listActiveModels as Mock).mockReturnValue([EXTRACTION_MODEL, TERRA_MODEL]);
    (callExtractionModel as Mock).mockResolvedValue(providerResult("still not json"));
    claimOnce([extracting()]);

    await runWorkerPass(db);

    expect(callExtractionModel).toHaveBeenCalledTimes(2);
    expect(storeExtraction).not.toHaveBeenCalled();
    // Non-retryable, because the ladder is the automatic retry. The card's
    // Retry re-queues the task and a fresh claim walks the whole ladder again.
    expect(releaseTaskForRetry).not.toHaveBeenCalled();
    expect(failTask).toHaveBeenCalledWith(
      db,
      "task-1",
      "EXTRACTION_UNREADABLE",
      expect.stringContaining("EXTRACTION_UNREADABLE"),
    );
    // Every discarded rung still gets its usage row: every attempt was billed.
    const retried = (recordUsageEvent as Mock).mock.calls.filter(
      ([, event]) =>
        (event as { kind: string; outcome: string }).kind === "extraction" &&
        (event as { outcome: string }).outcome === "retried",
    );
    expect(retried).toHaveLength(2);
    expect(retried.map(([, event]) => (event as { modelId: string }).modelId)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ]);
  });

  it("leaves a provider error to the task's own retry budget: the ladder is for wrong shapes", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (listActiveModels as Mock).mockReturnValue([EXTRACTION_MODEL, TERRA_MODEL]);
    (callExtractionModel as Mock).mockRejectedValue(
      new ProviderError("HTTP 500: upstream", 500, "HTTP:500"),
    );
    claimOnce([extracting()]);

    await runWorkerPass(db);

    // No escalation onto the next rung for a call error.
    expect(callExtractionModel).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "extraction", outcome: "failed" }),
    );
    expect(releaseTaskForRetry).toHaveBeenCalledWith(
      db,
      "task-1",
      "HTTP:500",
      expect.stringContaining("HTTP 500"),
      expect.any(String),
    );
    expect(failTask).not.toHaveBeenCalled();
  });
});

describe("the perception phase", () => {
  const perception = () =>
    claimed({
      task: task({
        status: "extracting",
        is_perception: 1,
        prompt_id: null,
        question_text: "What do you know about Acme Analytics?",
      }),
      phase: "extracting",
      provider: "openai",
      providerModelId: "gpt-5.6-luna",
    });

  const PERCEPTION_JSON = JSON.stringify({
    knows_brand: true,
    what_it_does: "Tracks how often a brand is named in assistant answers.",
    typical_customers: "Small marketing teams.",
    well_regarded_for: "Running locally.",
    downsides: "Thin documentation.",
  });

  it("writes a summary for this assistant and nothing measurement-shaped", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("Acme Analytics is a visibility tracker.");
    (callExtractionModel as Mock).mockResolvedValue(providerResult(PERCEPTION_JSON));
    claimOnce([perception()]);

    await runWorkerPass(db);

    expect(writePerceptionSummary).toHaveBeenCalledWith(db, "project-1", "model-sonnet", {
      knows_brand: true,
      what_it_does: "Tracks how often a brand is named in assistant answers.",
      typical_customers: "Small marketing teams.",
      well_regarded_for: "Running locally.",
      downsides: "Thin documentation.",
      run_id: "run-1",
      question_text: "What do you know about Acme Analytics?",
      source_answers: 1,
    });
    expect(markTaskDone).toHaveBeenCalledWith(db, "task-1");
    // Perception never writes a measurement.
    expect(storeExtraction).not.toHaveBeenCalled();
  });

  it("uses the same extractor, the same JSON mode and the same one-retry budget", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (callExtractionModel as Mock)
      .mockResolvedValueOnce(providerResult("{}"))
      .mockResolvedValueOnce(providerResult(PERCEPTION_JSON));
    claimOnce([perception()]);

    await runWorkerPass(db);

    expect(callExtractionModel).toHaveBeenCalledTimes(2);
    expect(callExtractionModel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "openai", model_id: "gpt-5.6-luna" }),
      expect.stringContaining("knows_brand"),
      expect.stringContaining("The brand is: Acme Analytics"),
      { timeoutMs: TIMEOUT_MS },
    );
    expect(writePerceptionSummary).toHaveBeenCalled();
  });

  it("never stores a summary from a reply cut off at the output cap", async () => {
    (getStoredAnswerText as Mock).mockReturnValue("an answer");
    (callExtractionModel as Mock)
      .mockResolvedValueOnce({ ...providerResult(PERCEPTION_JSON), truncated: true })
      .mockResolvedValueOnce(providerResult(PERCEPTION_JSON));
    claimOnce([perception()]);

    await runWorkerPass(db);

    expect(callExtractionModel).toHaveBeenCalledTimes(2);
    expect(writePerceptionSummary).toHaveBeenCalledTimes(1);
  });
});

describe("finalisation", () => {
  it("skips a run with work still pending", async () => {
    (claimTasks as Mock).mockReturnValue([]);
    (listFinalisationCandidates as Mock).mockReturnValue([
      { id: "run-1", project_id: "project-1" },
    ]);
    (countPendingTasks as Mock).mockReturnValue(3);

    const result = await runWorkerPass(db);

    expect(finalizeRun).not.toHaveBeenCalled();
    expect(result.finalised).toBe(0);
  });

  it("enriches, finalises, then auto-tracks, in that order", async () => {
    (claimTasks as Mock).mockReturnValue([]);
    (listFinalisationCandidates as Mock).mockReturnValue([
      { id: "run-1", project_id: "project-1" },
    ]);
    (countPendingTasks as Mock).mockReturnValue(0);

    const order: string[] = [];
    (enrichNewBrands as Mock).mockImplementation(() => order.push("enrich"));
    (finalizeRun as Mock).mockImplementation(() => order.push("finalize"));
    (autoTrackTopCompetitor as Mock).mockImplementation(() => order.push("autotrack"));

    const result = await runWorkerPass(db);

    // Enrichment seeds the domains citation attribution needs, finalisation
    // computes the metrics, and auto-tracking reads those metrics back.
    expect(order).toEqual(["enrich", "finalize", "autotrack"]);
    expect(result.finalised).toBe(1);
  });

  it("scores the other runs when one run fails to score", async () => {
    (claimTasks as Mock).mockReturnValue([]);
    (listFinalisationCandidates as Mock).mockReturnValue([
      { id: "run-1", project_id: "project-1" },
      { id: "run-2", project_id: "project-2" },
    ]);
    (countPendingTasks as Mock).mockReturnValue(0);
    (finalizeRun as Mock).mockImplementation((_db: Driver, runId: string) => {
      if (runId === "run-1") throw new Error("RUN_NOT_FOUND: no run run-1");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runWorkerPass(db);

    expect(finalizeRun).toHaveBeenCalledWith(db, "run-2");
    expect(result.finalised).toBe(1);
    expect(logged).toHaveBeenCalledWith("[worker] run scoring failed", {
      run_id: "run-1",
      message: "RUN_NOT_FOUND: no run run-1",
    });
  });
});

describe("costOf", () => {
  const model = {
    input_price_per_mtok: 1,
    output_price_per_mtok: 10,
    search_price_per_call: 0.01,
  } as never;

  afterEach(() => {
    delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  });

  it("prices a real call from the catalog", () => {
    const cost = costOf(model, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      searchCalls: 0,
    });
    expect(cost).toBe(1);
  });

  it("prices a call on a plan at nothing, because the plan bills per month, not per call", () => {
    process.env["OVERHEARD_ANTHROPIC_CLI"] = "claude";
    try {
      const planModel = { ...(model as object), provider: "anthropic" } as never;
      expect(costOf(planModel, { inputTokens: 1_000_000, outputTokens: 0, searchCalls: 1 })).toBe(
        0,
      );
      expect(worstCaseCost(planModel, "answer")).toBe(0);
    } finally {
      delete process.env["OVERHEARD_ANTHROPIC_CLI"];
    }
  });

  it("prices a mock call at nothing, because the seam bills nothing", () => {
    // The usage row is still written. Only the money is zero.
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    const cost = costOf(model, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      searchCalls: 2,
    });
    expect(cost).toBe(0);
    expect(worstCaseCost(model, "answer")).toBe(0);
  });
});
