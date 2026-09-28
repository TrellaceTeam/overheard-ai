import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, seedProject, setProviderKeys } from "../../logic/test-support";
import { ProviderError, type ProviderResult } from "../../worker/providers";
import { readPromptResultsSummaries } from "../../logic/prompt-results-summary";
import { listPromptResultsSummaries, summarizePromptResults } from "./prompt-results";
import { updatePrompt } from "./prompts";
import { SUMMARY_SYSTEM, type SummaryCall } from "./summaries";

// The extractor resolution filters by key, so the buy paths need keys in the
// environment even though every call in these suites is injected. Fake
// values: nothing here reaches a network.
let restoreKeys: (() => void) | undefined;

beforeEach(() => {
  restoreKeys = setProviderKeys("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY");
});

afterEach(() => {
  restoreKeys?.();
  restoreKeys = undefined;
});

let db: Driver | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function open(): Driver {
  db = freshDb();
  seedProject(db, {
    models: [HAIKU],
    prompts: [
      { id: "q1", text: "best analytics tools", iterations: 1 },
      { id: "q2", text: "which analytics tool for a startup", iterations: 1 },
      { id: "q3", text: "analytics tools with a free plan", iterations: 1 },
    ],
  });
  return db;
}

interface SeedRun {
  id: string;
  createdAt: string;
  /** Null for a run that is still going. */
  finishedAt: string | null;
  /** Done answers per prompt, in the order they were asked. */
  answers: Record<string, string[]>;
}

/** A run with finished answers, dated, straight into the tables the op reads. */
function seedRun(database: Driver, run: SeedRun): void {
  const total = Object.values(run.answers).reduce((sum, texts) => sum + texts.length, 0);
  database
    .prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, started_at, finished_at, created_at)
       VALUES (?, 'p1', ?, ?, '{}', ?, ?, ?)`,
    )
    .run(
      run.id,
      run.finishedAt ? "completed" : "running",
      total * 2,
      run.createdAt,
      run.finishedAt,
      run.createdAt,
    );
  const task = database.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text,
                            status, answer_text, created_at)
     VALUES (?, ?, 'p1', ?, ?, ?, 'question', 'done', ?, ?)`,
  );
  for (const [promptId, texts] of Object.entries(run.answers)) {
    texts.forEach((text, index) => {
      const id = `${run.id}-${promptId}-${String(index).padStart(3, "0")}`;
      task.run(id, run.id, promptId, HAIKU, index + 1, text, run.createdAt);
    });
  }
}

/** One more done answer in a run that already exists. */
function seedRunTask(database: Driver, runId: string, promptId: string, text: string): void {
  database
    .prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text,
                              status, answer_text)
       VALUES (?, ?, 'p1', ?, ?, 99, 'question', 'done', ?)`,
    )
    .run(`${runId}-${promptId}-late`, runId, promptId, HAIKU, text);
}

function okCall(text = "Across both runs, Acme Analytics leads."): () => Promise<ProviderResult> {
  return async () => ({
    text,
    inputTokens: 1_000,
    outputTokens: 100,
    tokens: 1_100,
    searchCalls: 0,
  });
}

/** An answer that fills one whole per-answer slice, with a findable marker. */
function longAnswer(runId: string, n: number): string {
  return `${runId} answer ${n} `.padEnd(8_000, ".");
}

/**
 * Four weekly runs of 20 answers to q1 at 8,000 characters each: 640,000
 * characters in all, of which the 400,000-character budget holds 50: the
 * newest two runs whole and half of the one before.
 */
function seedFourWeeks(database: Driver): void {
  ["2026-08-04", "2026-08-11", "2026-08-18", "2026-08-25"].forEach((day, week) => {
    const id = `r${week + 1}`;
    seedRun(database, {
      id,
      createdAt: `${day}T09:00:00.000Z`,
      finishedAt: `${day}T09:10:00.000Z`,
      answers: { q1: Array.from({ length: 20 }, (_, n) => longAnswer(id, n)) },
    });
  });
}

/** A call that keeps the prompt it was sent. */
function capturingCall(): { call: SummaryCall; sent: () => string } {
  let user = "";
  return {
    call: async (_model, _system, prompt) => {
      user = prompt;
      return {
        text: "Summary.",
        inputTokens: 1_000,
        outputTokens: 100,
        tokens: 1_100,
        searchCalls: 0,
      };
    },
    sent: () => user,
  };
}

function viewOf(database: Driver, promptId: string) {
  return listPromptResultsSummaries(database, "p1").find((row) => row.promptId === promptId);
}

/** One finished run with two answers to q1. */
function seedWeekOne(database: Driver): void {
  seedRun(database, {
    id: "r1",
    createdAt: "2026-09-01T09:00:00.000Z",
    finishedAt: "2026-09-01T09:10:00.000Z",
    answers: { q1: ["Acme Analytics first.", "Northwind Metrics first."] },
  });
}

/** The spend log. A prompt results summary belongs to no run, so this reads it whole. */
function usageRows(database: Driver) {
  return database
    .prepare("SELECT run_id, kind, outcome, input_tokens, cost_usd FROM usage_events")
    .all<{
      run_id: string | null;
      kind: string;
      outcome: string;
      input_tokens: number;
      cost_usd: number;
    }>();
}

describe("listPromptResultsSummaries", () => {
  it("lists only the prompts that have answers", () => {
    const db = open();
    seedRun(db, {
      id: "r1",
      createdAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:10:00.000Z",
      answers: {
        q1: ["Acme Analytics first.", "Northwind Metrics first."],
        q2: ["Globex Search."],
      },
    });
    // A perception answer belongs to no prompt and gives none a fold.
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, is_perception, status, answer_text)
       VALUES ('perception', 'r1', 'p1', NULL, ?, 1, 1, 'done', 'Acme Analytics is an analytics tool.')`,
    ).run(HAIKU);

    const views = listPromptResultsSummaries(db, "p1");

    expect(views.map((row) => row.promptId).sort()).toEqual(["q1", "q2"]);
    expect(viewOf(db, "q1")).toMatchObject({ totalAnswers: 2, saved: null, outdated: null });
  });

  it("counts the feed the budget allows: the newest runs, and how many of the answers", () => {
    const db = open();
    seedFourWeeks(db);

    expect(viewOf(db, "q1")).toMatchObject({
      totalAnswers: 80,
      feed: { runCount: 3, answerCount: 50 },
    });
  });
});

describe("summarizePromptResults, the feed", () => {
  it("sends the newest runs first and leaves the oldest out at the budget", async () => {
    const db = open();
    seedFourWeeks(db);
    const { call, sent } = capturingCall();

    const result = await summarizePromptResults(db, "q1", call);

    expect(result).toMatchObject({ answerCount: 50, runCount: 3, totalAnswers: 80 });
    const prompt = sent();
    expect(prompt.indexOf("r4 answer 0 ")).toBeLessThan(prompt.indexOf("r3 answer 0 "));
    expect(prompt.indexOf("r3 answer 0 ")).toBeLessThan(prompt.indexOf("r2 answer 0 "));
    // The third run is cut part-way, and the oldest run is not read at all.
    expect(prompt).toContain("r2 answer 9 ");
    expect(prompt).not.toContain("r2 answer 10 ");
    expect(prompt).not.toContain("r1 answer");
  });

  it("slices a runaway answer instead of letting it eat the budget", async () => {
    const db = open();
    // Sixty 20,000-character answers. Whole, twenty would fit. Sliced, fifty do.
    seedRun(db, {
      id: "r1",
      createdAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:10:00.000Z",
      answers: {
        q1: Array.from({ length: 60 }, (_, n) => `${`head ${n} `.padEnd(19_995, ".")} TAIL`),
      },
    });
    const { call, sent } = capturingCall();

    expect(viewOf(db, "q1")?.feed.answerCount).toBe(50);
    await summarizePromptResults(db, "q1", call);
    expect(sent()).not.toContain("TAIL");
  });

  it("prices the answers it will read, not the whole pile", () => {
    const db = open();
    seedFourWeeks(db); // q1: 80 answers, of which the budget reads 50
    seedRun(db, {
      id: "r5",
      createdAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:10:00.000Z",
      answers: {
        q2: Array.from({ length: 50 }, (_, n) => longAnswer("r5", n)),
        q3: Array.from({ length: 10 }, (_, n) => longAnswer("r5", n)),
      },
    });

    const cost = (promptId: string) => viewOf(db, promptId)?.costUsd ?? Number.NaN;
    expect(cost("q1")).toBeCloseTo(cost("q2"), 10);
    expect(cost("q3")).toBeGreaterThan(0);
    expect(cost("q3")).toBeLessThan(cost("q2"));
  });
});

describe("listPromptResultsSummaries, outdated summaries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Buys q1's summary as if it were this moment, so run times can fall either side of it. */
  async function summarizeAt(database: Driver, iso: string, text?: string): Promise<void> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    await summarizePromptResults(database, "q1", okCall(text));
    vi.useRealTimers();
  }

  /** The first week, answered and finished, then summarized the next day. */
  async function summarizedWeekOne(database: Driver): Promise<void> {
    seedRun(database, {
      id: "r1",
      createdAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:10:00.000Z",
      answers: { q1: ["Acme Analytics first.", "Northwind Metrics first."] },
    });
    await summarizeAt(database, "2026-09-02T12:00:00.000Z");
  }

  it("flags the summary once a run with answers for the prompt finishes after it", async () => {
    const db = open();
    await summarizedWeekOne(db);
    expect(viewOf(db, "q1")?.outdated).toBeNull();

    seedRun(db, {
      id: "r2",
      createdAt: "2026-09-08T09:00:00.000Z",
      finishedAt: "2026-09-08T09:10:00.000Z",
      answers: { q1: ["Acme Analytics.", "Contoso Insights.", "Globex Search."] },
    });

    expect(viewOf(db, "q1")?.outdated).toEqual({ newAnswers: 3 });
  });

  it("waits for a run to finish before flagging it", async () => {
    const db = open();
    await summarizedWeekOne(db);
    seedRun(db, {
      id: "r2",
      createdAt: "2026-09-08T09:00:00.000Z",
      finishedAt: null,
      answers: { q1: ["Acme Analytics.", "Contoso Insights."] },
    });

    expect(viewOf(db, "q1")?.outdated).toBeNull();

    db.prepare(
      "UPDATE runs SET status = 'completed', finished_at = '2026-09-08T09:30:00.000Z' WHERE id = 'r2'",
    ).run();
    expect(viewOf(db, "q1")?.outdated).toEqual({ newAnswers: 2 });
  });

  it("is not flagged by a run that answered only other prompts", async () => {
    const db = open();
    await summarizedWeekOne(db);
    seedRun(db, {
      id: "r2",
      createdAt: "2026-09-08T09:00:00.000Z",
      finishedAt: "2026-09-08T09:10:00.000Z",
      answers: { q2: ["Globex Search."] },
    });

    expect(viewOf(db, "q1")?.outdated).toBeNull();
  });

  it("is flagged by a run that finished while the summary was being written", async () => {
    // The answers are read before the call and the call can take a while. A
    // run that lands in between was not read, so the summary must not claim it.
    const db = open();
    seedWeekOne(db);
    seedRun(db, {
      id: "r2",
      createdAt: "2026-09-08T09:00:00.000Z",
      finishedAt: null,
      answers: {},
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
    const slowCall: SummaryCall = async () => {
      vi.setSystemTime(new Date("2026-09-08T12:01:00.000Z"));
      seedRunTask(db, "r2", "q1", "Acme Analytics, from mid-call.");
      db.prepare(
        "UPDATE runs SET status = 'completed', finished_at = '2026-09-08T12:00:30.000Z' WHERE id = 'r2'",
      ).run();
      return {
        text: "Summary.",
        inputTokens: 1_000,
        outputTokens: 100,
        tokens: 1_100,
        searchCalls: 0,
      };
    };

    await summarizePromptResults(db, "q1", slowCall);
    vi.useRealTimers();

    expect(viewOf(db, "q1")?.outdated).toEqual({ newAnswers: 1 });
  });

  it("is flagged by a run that finishes again after a retry, with no new answers to count", async () => {
    // Answers carry no timestamp, so a run's finish is the clock. A retry that
    // re-finishes an older run moves that clock without adding an answer here.
    const db = open();
    await summarizedWeekOne(db);
    db.prepare("UPDATE runs SET finished_at = '2026-09-03T08:00:00.000Z' WHERE id = 'r1'").run();

    expect(viewOf(db, "q1")?.outdated).toEqual({ newAnswers: 0 });
  });

  it("clears the flag when the summary is asked again, replacing it", async () => {
    const db = open();
    await summarizedWeekOne(db);
    seedRun(db, {
      id: "r2",
      createdAt: "2026-09-08T09:00:00.000Z",
      finishedAt: "2026-09-08T09:10:00.000Z",
      answers: { q1: ["Acme Analytics.", "Contoso Insights.", "Globex Search."] },
    });

    await summarizeAt(db, "2026-09-09T12:00:00.000Z", "Second pass over both weeks.");

    const view = viewOf(db, "q1");
    expect(view?.outdated).toBeNull();
    expect(view?.saved).toMatchObject({
      summary: "Second pass over both weeks.",
      answerCount: 5,
      runCount: 2,
      totalAnswers: 5,
    });
  });
});

describe("summarizePromptResults", () => {
  it("summarizes a prompt's answers across runs and stores the result", async () => {
    const db = open();
    seedRun(db, {
      id: "r1",
      createdAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:10:00.000Z",
      answers: { q1: ["Acme Analytics first.", "Northwind Metrics first."] },
    });
    seedRun(db, {
      id: "r2",
      createdAt: "2026-09-08T09:00:00.000Z",
      finishedAt: "2026-09-08T09:10:00.000Z",
      answers: { q1: ["Acme Analytics again.", "Contoso Insights first."], q2: ["Globex Search."] },
    });

    const result = await summarizePromptResults(db, "q1", okCall());

    expect(result).toMatchObject({
      summary: "Across both runs, Acme Analytics leads.",
      answerCount: 4,
      runCount: 2,
      totalAnswers: 4,
    });
    expect(viewOf(db, "q1")?.saved).toMatchObject({
      summary: "Across both runs, Acme Analytics leads.",
      answerCount: 4,
      runCount: 2,
      totalAnswers: 4,
    });
  });

  it("refuses the demo project, storing and logging nothing", async () => {
    const db = open();
    seedWeekOne(db);
    db.prepare("UPDATE projects SET is_demo = 1 WHERE id = 'p1'").run();

    await expect(summarizePromptResults(db, "q1", okCall())).rejects.toThrow(/DEMO_PROJECT/);
    expect(viewOf(db, "q1")?.saved).toBeNull();
    expect(usageRows(db)).toHaveLength(0);
  });

  it("refuses a prompt that has no answers yet, before any call", async () => {
    const db = open();
    seedWeekOne(db);
    const { call, sent } = capturingCall();

    await expect(summarizePromptResults(db, "q3", call)).rejects.toThrow(/NO_ANSWERS/);
    expect(sent()).toBe("");
  });

  it("refuses a prompt that is not in the database", async () => {
    const db = open();
    await expect(summarizePromptResults(db, "nope", okCall())).rejects.toThrow(/PROMPT_NOT_FOUND/);
  });
});

describe("a prompt results summary and its prompt's wording", () => {
  /** q1 summarized, then every run deleted: no answers left, so the text unlocks. */
  async function summarizedThenEmptied(database: Driver): Promise<void> {
    seedWeekOne(database);
    await summarizePromptResults(database, "q1", okCall("About the budget question."));
    database.prepare("DELETE FROM runs WHERE project_id = 'p1'").run();
  }

  it("is dropped when the prompt is reworded, so it cannot come back under new words", async () => {
    const db = open();
    await summarizedThenEmptied(db);

    updatePrompt(db, { id: "q1", text: "best analytics tools for agencies" });
    seedWeekOne(db);

    expect(viewOf(db, "q1")?.saved).toBeNull();
  });

  it("survives any other edit to the prompt", async () => {
    const db = open();
    await summarizedThenEmptied(db);

    updatePrompt(db, { id: "q1", iterations: 4, isActive: false });
    updatePrompt(db, { id: "q1", text: "best analytics tools" }); // the same words, re-saved
    seedWeekOne(db);

    expect(viewOf(db, "q1")?.saved?.summary).toBe("About the budget question.");
  });
});

describe("summarizePromptResults, the writer", () => {
  it("is the project's extraction model, and the stored row records it with the cost", async () => {
    const db = open();
    seedWeekOne(db);
    let writer = "";
    const call: SummaryCall = async (model) => {
      writer = model.id;
      return {
        text: "Summary.",
        inputTokens: 1_000,
        outputTokens: 100,
        tokens: 1_100,
        searchCalls: 0,
      };
    };

    const result = await summarizePromptResults(db, "q1", call);

    expect(writer).toBe(HAIKU);
    expect(readPromptResultsSummaries(db, "p1")[0]).toMatchObject({
      modelId: HAIKU,
      costUsd: result.costUsd,
    });
  });

  it("gets the run-level summary's instructions, so tuning those tunes both", async () => {
    const db = open();
    seedWeekOne(db);
    let system = "";
    const call: SummaryCall = async (_model, instructions) => {
      system = instructions;
      return {
        text: "Summary.",
        inputTokens: 1_000,
        outputTokens: 100,
        tokens: 1_100,
        searchCalls: 0,
      };
    };

    await summarizePromptResults(db, "q1", call);

    expect(system.startsWith(SUMMARY_SYSTEM)).toBe(true);
  });

  it("answers offline under the mock seam, and the log says it cost nothing", async () => {
    const before = process.env["OVERHEARD_MOCK_PROVIDERS"];
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    try {
      const db = open();
      seedWeekOne(db);

      const result = await summarizePromptResults(db, "q1");

      expect(result.summary).not.toBe("");
      expect(usageRows(db)).toEqual([
        expect.objectContaining({ kind: "prompt_summary", outcome: "success", cost_usd: 0 }),
      ]);
    } finally {
      if (before === undefined) delete process.env["OVERHEARD_MOCK_PROVIDERS"];
      else process.env["OVERHEARD_MOCK_PROVIDERS"] = before;
    }
  });
});

describe("summarizePromptResults, spend", () => {
  it("logs the call as a prompt_summary with no run attached", async () => {
    const db = open();
    seedWeekOne(db);

    const result = await summarizePromptResults(db, "q1", okCall());

    expect(usageRows(db)).toEqual([
      expect.objectContaining({
        run_id: null,
        kind: "prompt_summary",
        outcome: "success",
        input_tokens: 1_000,
      }),
    ]);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(usageRows(db)[0]?.cost_usd).toBeCloseTo(result.costUsd, 10);
  });

  it("logs a failed call that may have billed at no less than the price it showed", async () => {
    const db = open();
    seedFourWeeks(db);
    const shown = viewOf(db, "q1")?.costUsd ?? Number.NaN;
    const failing = async () => {
      throw new ProviderError("HTTP 500: upstream", 500, "HTTP:500");
    };

    await expect(summarizePromptResults(db, "q1", failing)).rejects.toThrow(/SUMMARY_FAILED/);

    const rows = usageRows(db);
    expect(rows).toEqual([
      expect.objectContaining({
        run_id: null,
        kind: "prompt_summary",
        outcome: "error",
        input_tokens: 0,
      }),
    ]);
    expect(rows[0]?.cost_usd).toBeGreaterThanOrEqual(shown);
    expect(viewOf(db, "q1")?.saved).toBeNull();
  });

  it("logs nothing for a refusal that never reached generation", async () => {
    const db = open();
    seedWeekOne(db);
    const refused = async () => {
      throw new ProviderError("HTTP 429: slow down", 429, "HTTP:429");
    };

    await expect(summarizePromptResults(db, "q1", refused)).rejects.toThrow(/SUMMARY_FAILED.*429/);
    expect(usageRows(db)).toHaveLength(0);
    expect(viewOf(db, "q1")?.saved).toBeNull();
  });

  it("refuses an empty summary rather than storing a blank paragraph, and still logs the call", async () => {
    const db = open();
    seedWeekOne(db);

    await expect(summarizePromptResults(db, "q1", okCall("   "))).rejects.toThrow(/EMPTY_SUMMARY/);
    expect(viewOf(db, "q1")?.saved).toBeNull();
    expect(usageRows(db)).toEqual([
      expect.objectContaining({ kind: "prompt_summary", outcome: "empty" }),
    ]);
  });
});
