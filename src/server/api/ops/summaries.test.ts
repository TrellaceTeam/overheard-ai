import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import type { ModelRow } from "../../db/types";
import { freshDb, HAIKU, seedProject, setProviderKeys, SONNET } from "../../logic/test-support";
import { ProviderError, type ProviderResult } from "../../worker/providers";
import { createRun, getRunDetail, listRunTasks } from "./runs";
import {
  estimateSummaryCost,
  listPromptSummaries,
  pickSummaryModel,
  summarizePromptAnswers,
  summaryFeedSize,
  summaryUserPrompt,
  MAX_ANSWERS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM,
} from "./summaries";
import { InvalidInputError } from "./shared";

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
    models: [HAIKU, SONNET],
    prompts: [
      { id: "q1", text: "best analytics tools", iterations: 2 },
      { id: "q2", text: "which analytics tool for a startup", iterations: 1 },
    ],
  });
  return db;
}

/** A run whose q1 answers all arrived. q2 is still queued. */
function runWithAnswers(database: Driver): string {
  const { runId } = createRun(database, "p1");
  database
    .prepare(
      `UPDATE run_tasks SET status = 'done', answer_text = 'Acme is a fine tool. ' || question_text
        WHERE run_id = ? AND prompt_id = 'q1'`,
    )
    .run(runId);
  return runId;
}

function okCall(text = "All four answers recommend Acme."): () => Promise<ProviderResult> {
  return async () => ({
    text,
    inputTokens: 1_000,
    outputTokens: 100,
    tokens: 1_100,
    searchCalls: 0,
  });
}

function usageRows(database: Driver, runId: string) {
  return database
    .prepare("SELECT kind, outcome, input_tokens, cost_usd FROM usage_events WHERE run_id = ?")
    .all<{ kind: string; outcome: string; input_tokens: number; cost_usd: number }>(runId);
}

describe("summarizePromptAnswers", () => {
  it("summarizes one prompt's answers and stores the result", async () => {
    const db = open();
    const runId = runWithAnswers(db);

    const result = await summarizePromptAnswers(db, runId, "q1", okCall());

    expect(result.summary).toBe("All four answers recommend Acme.");
    expect(result.answerCount).toBe(4); // 2 iterations × 2 assistants
    const views = listPromptSummaries(db, runId);
    expect(views).toHaveLength(1); // q2 has no answers, so no row
    expect(views[0]).toMatchObject({
      promptId: "q1",
      promptText: "best analytics tools",
      answerCount: 4,
      saved: { summary: "All four answers recommend Acme.", answerCount: 4 },
    });
  });

  it("replaces the stored summary when asked again", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    await summarizePromptAnswers(db, runId, "q1", okCall("First pass."));
    await summarizePromptAnswers(db, runId, "q1", okCall("Second pass."));

    const views = listPromptSummaries(db, runId);
    expect(views).toHaveLength(1);
    expect(views[0]?.saved?.summary).toBe("Second pass.");
  });

  it("logs the spend as a summary usage event, so the run's total carries it", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    const result = await summarizePromptAnswers(db, runId, "q1", okCall());

    expect(usageRows(db, runId)).toEqual([
      expect.objectContaining({ kind: "summary", outcome: "success", input_tokens: 1_000 }),
    ]);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(getRunDetail(db, runId).estimatedCostUsd).toBeCloseTo(result.costUsd, 10);
  });

  it("refuses the demo project", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    db.prepare("UPDATE projects SET is_demo = 1 WHERE id = 'p1'").run();

    await expect(summarizePromptAnswers(db, runId, "q1", okCall())).rejects.toThrow(/DEMO_PROJECT/);
  });

  it("refuses a question with no answers in the run", async () => {
    const db = open();
    const runId = runWithAnswers(db);

    await expect(summarizePromptAnswers(db, runId, "q2", okCall())).rejects.toThrow(/NO_ANSWERS/);
  });

  it("refuses a run that is not in the database", async () => {
    const db = open();
    await expect(summarizePromptAnswers(db, "nope", "q1", okCall())).rejects.toThrow(
      /RUN_NOT_FOUND/,
    );
  });

  it("wraps a provider failure and stores nothing", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    const failing = async () => {
      throw new ProviderError("HTTP 429: slow down", 429, "HTTP:429");
    };

    await expect(summarizePromptAnswers(db, runId, "q1", failing)).rejects.toThrow(
      /SUMMARY_FAILED.*429/,
    );
    expect(listPromptSummaries(db, runId)[0]?.saved).toBeNull();
    // A 4xx never reached generation: no worst-case spend row.
    expect(usageRows(db, runId)).toHaveLength(0);
  });

  it("logs the worst case when a failed call may have billed", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    const failing = async () => {
      throw new ProviderError("HTTP 500: upstream", 500, "HTTP:500");
    };

    await expect(summarizePromptAnswers(db, runId, "q1", failing)).rejects.toThrow(
      /SUMMARY_FAILED/,
    );
    expect(usageRows(db, runId)).toEqual([
      expect.objectContaining({ kind: "summary", outcome: "error", input_tokens: 0 }),
    ]);
  });

  it("refuses an empty summary rather than storing a blank paragraph", async () => {
    const db = open();
    const runId = runWithAnswers(db);

    await expect(summarizePromptAnswers(db, runId, "q1", okCall("   "))).rejects.toThrow(
      /EMPTY_SUMMARY/,
    );
    expect(listPromptSummaries(db, runId)[0]?.saved).toBeNull();
    // The call happened and returned tokens, so the spend is still logged.
    expect(usageRows(db, runId)).toEqual([
      expect.objectContaining({ kind: "summary", outcome: "empty" }),
    ]);
  });
});

describe("pickSummaryModel", () => {
  it("takes the project's extraction model", () => {
    const db = open();
    expect(pickSummaryModel(db, "p1")?.id).toBe(HAIKU);
  });

  it("falls back to the catalog's first extraction candidate", () => {
    const db = open();
    db.prepare("UPDATE projects SET extraction_model_id = NULL WHERE id = 'p1'").run();
    expect(pickSummaryModel(db, "p1")).not.toBeNull();
  });
});

describe("estimateSummaryCost", () => {
  it("grows with the answers it has to read", () => {
    const db = open();
    const model = pickSummaryModel(db, "p1");
    const small = estimateSummaryCost(model, 4_000);
    const large = estimateSummaryCost(model, 40_000);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it("is zero with no model to price against", () => {
    expect(estimateSummaryCost(null, 40_000)).toBe(0);
  });
});

describe("summaryUserPrompt", () => {
  it("carries the question and every numbered answer", () => {
    const prompt = summaryUserPrompt("best analytics tools", ["Acme first.", "Globex first."]);
    expect(prompt).toContain("best analytics tools");
    expect(prompt).toContain("[1]\nAcme first.");
    expect(prompt).toContain("[2]\nGlobex first.");
  });

  it("stops at the answer cap and says how many it shows", () => {
    const answers = Array.from({ length: 60 }, (_, i) => `answer ${i}`);
    const prompt = summaryUserPrompt("q", answers);
    expect(prompt).toContain(`${MAX_ANSWERS} answers from different assistants`);
    expect(prompt).not.toContain(`answer ${MAX_ANSWERS}`);
  });

  it("slices one runaway answer instead of dropping the rest", () => {
    const prompt = summaryUserPrompt("q", ["x".repeat(20_000), "short one"]);
    expect(prompt).toContain("short one");
    expect(prompt.length).toBeLessThan(20_000);
  });
});

describe("summaryFeedSize", () => {
  it("stops at the answer cap", () => {
    expect(summaryFeedSize(Array(60).fill(100))).toEqual({ count: MAX_ANSWERS, chars: 5_000 });
  });

  it("counts each answer at its slice, and stops before the one that would pass the budget", () => {
    // 15 full slices are 120,000 characters, the whole budget; the 16th does not fit.
    expect(summaryFeedSize(Array(20).fill(50_000))).toEqual({ count: 15, chars: 120_000 });
  });
});

describe("the count a summary is labelled with", () => {
  it("is what the summarizer read, before buying and after", async () => {
    db = freshDb();
    seedProject(db, {
      models: [HAIKU, SONNET],
      prompts: [{ id: "q1", text: "best analytics tools", iterations: 10 }],
    });
    const { runId } = createRun(db, "p1");
    // Twenty answers of 50,000 characters: only 15 slices fit the budget.
    db.prepare(
      `UPDATE run_tasks SET status = 'done', answer_text = replace(hex(zeroblob(25000)), '00', 'xy')
        WHERE run_id = ? AND prompt_id = 'q1'`,
    ).run(runId);

    const before = listPromptSummaries(db, runId)[0]!;
    expect(before.answerCount).toBe(20);
    expect(before.feedCount).toBe(15);

    const result = await summarizePromptAnswers(db, runId, "q1", okCall());
    expect(result.answerCount).toBe(15);
    expect(listPromptSummaries(db, runId)[0]?.saved?.answerCount).toBe(15);
  });
});

describe("getRunDetail, prompt summaries", () => {
  it("rides along in the run screen's one call", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    await summarizePromptAnswers(db, runId, "q1", okCall());

    const detail = getRunDetail(db, runId);
    expect(detail.promptSummaries.map((row) => row.promptId)).toEqual(["q1"]);
    expect(detail.promptSummaries[0]?.saved?.summary).toBe("All four answers recommend Acme.");
    expect(detail.promptSummaries[0]?.costUsd).toBeGreaterThan(0);
    // The tasks themselves are untouched: a summary is not an extraction.
    expect(listRunTasks(db, runId).filter((task) => task.status === "done")).toHaveLength(4);
  });
});

describe("summarizePromptAnswers, the money rules", () => {
  it("logs nothing for a refusal that never reached generation", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    const refused = async () => {
      throw new InvalidInputError(
        "MISSING_CREDENTIAL",
        "no API key is configured for anthropic; add it to .env and restart",
      );
    };

    await expect(summarizePromptAnswers(db, runId, "q1", refused)).rejects.toThrow(
      /MISSING_CREDENTIAL/,
    );
    // Nothing was sent, so nothing was spent: a refusal logs no worst case.
    expect(usageRows(db, runId)).toHaveLength(0);
    expect(listPromptSummaries(db, runId)[0]?.saved).toBeNull();
  });

  it("sizes a may-have-billed failure from what was actually sent", async () => {
    const db = open();
    const runId = runWithAnswers(db);
    // Answers long enough that the sent-size worst case and the worker's fixed
    // extraction worst case (worstCaseCost) disagree.
    db.prepare(
      `UPDATE run_tasks SET answer_text = replace(hex(zeroblob(10000)), '00', 'x')
        WHERE run_id = ? AND prompt_id = 'q1'`,
    ).run(runId);
    const answers = db
      .prepare(
        `SELECT answer_text FROM run_tasks
          WHERE run_id = ? AND prompt_id = 'q1' AND status = 'done' AND is_perception = 0
          ORDER BY created_at, id`,
      )
      .all<{ answer_text: string }>(runId)
      .map((row) => row.answer_text);
    const sent = SUMMARY_SYSTEM.length + summaryUserPrompt("best analytics tools", answers).length;
    const model = db.prepare("SELECT * FROM models WHERE id = ?").get<ModelRow>(HAIKU)!;
    const expected =
      estimateSummaryCost(model, sent) +
      (SUMMARY_MAX_TOKENS / 1_000_000) * Number(model.output_price_per_mtok);

    const failing = async () => {
      throw new ProviderError("HTTP 500: upstream", 500, "HTTP:500");
    };
    await expect(summarizePromptAnswers(db, runId, "q1", failing)).rejects.toThrow(
      /SUMMARY_FAILED/,
    );

    const rows = usageRows(db, runId);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "summary", outcome: "error", input_tokens: 0 }),
    ]);
    expect(rows[0]?.cost_usd).toBeCloseTo(expected, 10);
  });
});
