/**
 * The four writes the worker makes about one task, and the phase-boundary
 * attempt reset that keeps a paid-for answer from being thrown away.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { BrandObservationRow, ExtractionRow, RunTaskRow } from "../db/types";
import {
  backoffAt,
  failTask,
  releaseTaskForRetry,
  storeAnswer,
  storeExtraction,
} from "./store-answer";
import { claimTasks } from "./claim-tasks";
import type { ObservationInput } from "./types";
import { freshDb, HAIKU, seedProject } from "./test-support";

const TASK = "t1";

let db: Driver;

beforeEach(() => {
  db = freshDb();
  seedProject(db);
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1','running',2,'{}')",
  ).run();
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text, next_attempt_at)
     VALUES (?, 'r1', 'p1', 'q1', ?, 1, 'best analytics tools', ?)`,
  ).run(TASK, HAIKU, new Date(Date.now() - 1000).toISOString());
  db.prepare(
    "INSERT INTO brands (id, project_id, name, role) VALUES ('b-north', 'p1', 'Northwind Metrics', 'competitor')",
  ).run();
});

afterEach(() => {
  db.close();
});

function task(): RunTaskRow {
  const row = db.prepare("SELECT * FROM run_tasks WHERE id = ?").get<RunTaskRow>(TASK);
  if (!row) throw new Error("no task");
  return row;
}

function observation(brandId: string | null, position: number | null): ObservationInput {
  return {
    brandId,
    rawName: brandId === null ? "Some Unknown Tool" : "Northwind Metrics",
    position,
    totalItems: 5,
    mentionType: "ranked",
    linkedUrl: null,
    isCited: false,
    evidence: null,
  };
}

describe("storeAnswer", () => {
  it("moves the task to answered, clears the lock, and resets attempts to 0", () => {
    claimTasks(db, 10, "worker-1");
    expect(task().attempts).toBe(1);

    storeAnswer(db, TASK, {
      answerText: "Northwind Metrics, then Acme Analytics.",
      answerTokens: 42,
      latencyMs: 1200,
      providerCostUsd: 0.0031,
    });

    const after = task();
    expect(after.status).toBe("answered");
    expect(after.answer_text).toBe("Northwind Metrics, then Acme Analytics.");
    expect(after.answer_tokens).toBe(42);
    expect(after.latency_ms).toBe(1200);
    expect(after.provider_cost_usd).toBeCloseTo(0.0031, 6);
    expect(after.attempts).toBe(0);
    expect(after.locked_at).toBeNull();
    expect(after.locked_by).toBeNull();
    expect(after.error).toBeNull();
  });

  it("gives the extraction phase its own full attempt budget", () => {
    // Answer attempts already at the ceiling, then a successful answer: the
    // reset leaves extraction claimable.
    db.prepare("UPDATE run_tasks SET attempts = 2 WHERE id = ?").run(TASK);

    storeAnswer(db, TASK, {
      answerText: "an answer already paid for",
      answerTokens: null,
      latencyMs: null,
      providerCostUsd: null,
    });

    expect(claimTasks(db, 10, "worker-1")[0]?.phase).toBe("extracting");
  });

  it("keeps the model version the provider reported, and null when it reported none", () => {
    const answerModel = () =>
      db
        .prepare("SELECT answer_model FROM run_tasks WHERE id = ?")
        .get<{ answer_model: string | null }>(TASK)?.answer_model;
    const answer = { answerText: "an answer", answerTokens: 1, latencyMs: 1, providerCostUsd: 0 };

    storeAnswer(db, TASK, { ...answer, answerModel: "reader-2026-09-22" });
    expect(answerModel()).toBe("reader-2026-09-22");

    storeAnswer(db, TASK, answer);
    expect(answerModel()).toBeNull();
  });
});

describe("storeExtraction", () => {
  beforeEach(() => {
    db.prepare("UPDATE run_tasks SET status = 'extracting', answer_text = 'text' WHERE id = ?").run(
      TASK,
    );
  });

  it("writes the extraction, the observations and the done status together", () => {
    storeExtraction(db, TASK, {
      answerFormat: "ranked_list",
      totalItems: 5,
      rawJson: { brands: ["Northwind Metrics"] },
      modelUsed: "anthropic/claude-haiku-4-5",
      observations: [observation("b-north", 2)],
    });

    expect(task().status).toBe("done");
    const extraction = db
      .prepare("SELECT * FROM extractions WHERE run_task_id = ?")
      .get<ExtractionRow>(TASK);
    expect(extraction?.answer_format).toBe("ranked_list");
    expect(extraction?.model_used).toBe("anthropic/claude-haiku-4-5");
    expect(JSON.parse(extraction?.raw_json ?? "null")).toEqual({ brands: ["Northwind Metrics"] });

    const rows = db
      .prepare("SELECT * FROM brand_observations WHERE run_task_id = ?")
      .all<BrandObservationRow>(TASK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.brand_id).toBe("b-north");
    expect(rows[0]?.run_id).toBe("r1");
  });

  it("keeps an observation whose raw name resolved to nothing", () => {
    storeExtraction(db, TASK, {
      answerFormat: "prose",
      totalItems: null,
      rawJson: {},
      modelUsed: "anthropic/claude-haiku-4-5",
      observations: [observation(null, null)],
    });

    const rows = db
      .prepare("SELECT * FROM brand_observations WHERE run_task_id = ?")
      .all<BrandObservationRow>(TASK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.brand_id).toBeNull();
  });

  it("replaces the previous observations rather than adding to them", () => {
    const result = {
      answerFormat: "ranked_list" as const,
      totalItems: 5,
      rawJson: {},
      modelUsed: "anthropic/claude-haiku-4-5",
      observations: [observation("b-north", 2)],
    };

    storeExtraction(db, TASK, result);
    db.prepare("UPDATE run_tasks SET status = 'extracting' WHERE id = ?").run(TASK);
    storeExtraction(db, TASK, result);

    const rows = db
      .prepare("SELECT count(*) AS n FROM brand_observations WHERE run_task_id = ?")
      .get<{ n: number }>(TASK);
    const extractions = db
      .prepare("SELECT count(*) AS n FROM extractions WHERE run_task_id = ?")
      .get<{ n: number }>(TASK);
    expect(rows?.n).toBe(1);
    expect(extractions?.n).toBe(1);
  });

  it("writes no observations for a perception task", () => {
    db.prepare("UPDATE run_tasks SET is_perception = 1, prompt_id = NULL WHERE id = ?").run(TASK);

    storeExtraction(db, TASK, {
      answerFormat: "prose",
      totalItems: null,
      rawJson: {},
      modelUsed: "anthropic/claude-haiku-4-5",
      observations: [observation("b-north", 1)],
    });

    expect(task().status).toBe("done");
    expect(
      db
        .prepare("SELECT count(*) AS n FROM brand_observations WHERE run_task_id = ?")
        .get<{ n: number }>(TASK)?.n,
    ).toBe(0);
  });

  it("raises on a task that does not exist", () => {
    expect(() =>
      storeExtraction(db, "nope", {
        answerFormat: "prose",
        totalItems: null,
        rawJson: {},
        modelUsed: "x",
        observations: [],
      }),
    ).toThrow(/TASK_NOT_FOUND/);
  });
});

describe("failTask and releaseTaskForRetry", () => {
  it("fails a task outright with no backoff", () => {
    claimTasks(db, 10, "worker-1");

    failTask(db, TASK, "UNEXPECTED", "INVALID_REQUEST");

    const after = task();
    expect(after.status).toBe("failed");
    expect(after.error).toBe("INVALID_REQUEST");
    expect(after.failure_code).toBe("UNEXPECTED");
    expect(after.locked_at).toBeNull();
  });

  it("leaves a task that is already done alone", () => {
    db.prepare("UPDATE run_tasks SET status = 'done' WHERE id = ?").run(TASK);

    failTask(db, TASK, "UNEXPECTED", "too late");

    expect(task().status).toBe("done");
  });

  it("returns in_flight to queued with the backoff gate set", () => {
    claimTasks(db, 10, "worker-1");
    const gate = backoffAt(1);

    releaseTaskForRetry(db, TASK, "HTTP:429", "RATE_LIMITED", gate);

    const after = task();
    expect(after.status).toBe("queued");
    expect(after.error).toBe("RATE_LIMITED");
    expect(after.failure_code).toBe("HTTP:429");
    expect(after.next_attempt_at).toBe(gate);
    expect(after.locked_by).toBeNull();
  });

  it("clears the code together with the error when the task later succeeds", () => {
    claimTasks(db, 10, "worker-1");
    releaseTaskForRetry(db, TASK, "TIMEOUT", "TIMEOUT: gone", backoffAt(1));
    expect(task().failure_code).toBe("TIMEOUT");

    storeAnswer(db, TASK, {
      answerText: "x",
      answerTokens: 1,
      latencyMs: 5,
      providerCostUsd: 0.001,
    });

    const after = task();
    expect(after.error).toBeNull();
    expect(after.failure_code).toBeNull();
  });

  it("returns extracting to answered, never to queued", () => {
    db.prepare("UPDATE run_tasks SET status = 'answered', answer_text = 'x' WHERE id = ?").run(
      TASK,
    );
    claimTasks(db, 10, "worker-1");
    expect(task().status).toBe("extracting");

    releaseTaskForRetry(db, TASK, "SCHEMA_VIOLATION", "PARSE_FAILED", backoffAt(1));

    expect(task().status).toBe("answered");
  });
});

describe("backoffAt", () => {
  it("doubles with each attempt, plus up to ten seconds of jitter", () => {
    const now = new Date("2026-09-22T12:00:00.000Z");

    for (const [attempts, base] of [
      [1, 30],
      [2, 60],
      [3, 120],
    ] as const) {
      const delay = new Date(backoffAt(attempts, now)).getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(base * 1000);
      expect(delay).toBeLessThan((base + 10) * 1000);
    }
  });
});
