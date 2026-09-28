import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import { freshDb, HAIKU, seedProject } from "./test-support";
import { readPromptResultsSummaries, savePromptResultsSummary } from "./prompt-results-summary";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  seedProject(db, {
    models: [HAIKU],
    prompts: [
      { id: "q1", text: "best analytics tools", iterations: 1 },
      { id: "q2", text: "which analytics tool for a startup", iterations: 1 },
    ],
  });
  return db;
}

const input = {
  projectId: "p1",
  promptId: "q1",
  summary: "Across three runs, 30 of 40 answers recommend Acme Analytics.",
  answerCount: 40,
  runCount: 3,
  totalAnswers: 52,
  modelId: HAIKU,
  costUsd: 0.0123,
  createdAt: "2026-09-25T01:00:00.000Z",
};

describe("savePromptResultsSummary", () => {
  it("stores what the summary read, how many answers the prompt had, and what it cost", () => {
    const db = open();
    savePromptResultsSummary(db, input);

    const rows = readPromptResultsSummaries(db, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promptId: "q1",
      summary: "Across three runs, 30 of 40 answers recommend Acme Analytics.",
      answerCount: 40,
      runCount: 3,
      totalAnswers: 52,
      modelId: HAIKU,
      costUsd: 0.0123,
      createdAt: "2026-09-25T01:00:00.000Z",
    });
  });

  it("replaces the prompt's summary when it is asked again", () => {
    const db = open();
    savePromptResultsSummary(db, input);
    savePromptResultsSummary(db, {
      ...input,
      summary: "Asked again: now 40 of 52 answers recommend Acme Analytics.",
      answerCount: 52,
      runCount: 4,
      totalAnswers: 52,
      createdAt: "2026-10-02T01:00:00.000Z",
    });

    const rows = readPromptResultsSummaries(db, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      summary: "Asked again: now 40 of 52 answers recommend Acme Analytics.",
      answerCount: 52,
      runCount: 4,
      createdAt: "2026-10-02T01:00:00.000Z",
    });
  });

  it("keeps one row per prompt", () => {
    const db = open();
    savePromptResultsSummary(db, input);
    savePromptResultsSummary(db, { ...input, promptId: "q2", summary: "The startup question." });

    expect(
      readPromptResultsSummaries(db, "p1")
        .map((row) => row.promptId)
        .sort(),
    ).toEqual(["q1", "q2"]);
  });

  it("goes with its prompt", () => {
    const db = open();
    savePromptResultsSummary(db, input);
    savePromptResultsSummary(db, { ...input, promptId: "q2", summary: "The startup question." });

    db.prepare("DELETE FROM prompts WHERE id = 'q1'").run();

    expect(readPromptResultsSummaries(db, "p1").map((row) => row.promptId)).toEqual(["q2"]);
  });
});
