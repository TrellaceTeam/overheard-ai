import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import { freshDb, HAIKU, seedProject } from "./test-support";
import { listAnswerSummaries, saveAnswerSummary } from "./answer-summary";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  seedProject(db, {
    models: [HAIKU],
    prompts: [{ id: "q1", text: "best analytics tools", iterations: 1 }],
  });
  db.prepare(
    "INSERT INTO runs (id, project_id, planned_calls, config_snapshot) VALUES ('r1','p1',2,'{}')",
  ).run();
  return db;
}

const input = {
  runId: "r1",
  projectId: "p1",
  promptId: "q1",
  summary: "8 of 10 answers recommend Acme.",
  answerCount: 10,
  modelId: HAIKU,
  costUsd: 0.0021,
};

describe("saveAnswerSummary", () => {
  it("stores one summary per run and prompt", () => {
    const db = open();
    saveAnswerSummary(db, input);

    const rows = listAnswerSummaries(db, "r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promptId: "q1",
      summary: "8 of 10 answers recommend Acme.",
      answerCount: 10,
      costUsd: 0.0021,
    });
  });

  it("replaces the stored summary when the prompt is asked again", () => {
    const db = open();
    saveAnswerSummary(db, input);
    saveAnswerSummary(db, { ...input, summary: "Asked again: now 9 of 10.", answerCount: 10 });

    const rows = listAnswerSummaries(db, "r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("Asked again: now 9 of 10.");
  });

  it("keeps one row per prompt, not one per run", () => {
    const db = open();
    db.prepare(
      "INSERT INTO runs (id, project_id, planned_calls, config_snapshot) VALUES ('r2','p1',2,'{}')",
    ).run();
    saveAnswerSummary(db, input);
    saveAnswerSummary(db, { ...input, runId: "r2", summary: "The other run says less." });

    expect(listAnswerSummaries(db, "r1")).toHaveLength(1);
    expect(listAnswerSummaries(db, "r2")[0]?.summary).toBe("The other run says less.");
  });
});
