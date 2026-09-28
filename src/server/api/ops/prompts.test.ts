import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, seedProject } from "../../logic/test-support";
import { finalizeRun } from "../../logic/finalize-run";
import {
  clonePrompt,
  createPrompt,
  deletePrompt,
  listPrompts,
  promptAnswerCounts,
  promptIsLocked,
  setPromptArchived,
  updatePrompt,
} from "./prompts";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  seedProject(db, { prompts: [{ id: "q1", text: "best analytics tools", iterations: 2 }] });
  return db;
}

/** One done task against q1, which locks it. */
function answerQ1(db: Driver): void {
  db.prepare(
    `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot)
     VALUES ('r1', 'p1', 'completed', 2, '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status, next_attempt_at, answer_text)
     VALUES ('t1', 'r1', 'p1', 'q1', ?, 1, 'done', '2026-01-01T00:00:00.000Z', 'an answer')`,
  ).run(HAIKU);
}

describe("createPrompt", () => {
  it("trims, defaults to active with five iterations, and returns the id", () => {
    const db = open();
    const { id } = createPrompt(db, {
      projectId: "p1",
      text: "  Which tool is cheapest?  ",
      category: "test",
    });
    const row = listPrompts(db, "p1").find((prompt) => prompt.id === id);
    expect(row).toMatchObject({ text: "Which tool is cheapest?", iterations: 5, is_active: 1 });
  });

  it("clamps iterations to the range the stepper offers", () => {
    const db = open();
    const low = createPrompt(db, { projectId: "p1", text: "a", iterations: 0, category: "test" });
    const high = createPrompt(db, { projectId: "p1", text: "b", iterations: 99, category: "test" });
    const rows = listPrompts(db, "p1");
    expect(rows.find((r) => r.id === low.id)?.iterations).toBe(1);
    expect(rows.find((r) => r.id === high.id)?.iterations).toBe(20);
  });

  it("refuses a blank question and one over the character limit", () => {
    const db = open();
    expect(() => createPrompt(db, { projectId: "p1", text: "   ", category: "test" })).toThrow(
      /NO_TEXT/,
    );
    expect(() =>
      createPrompt(db, { projectId: "p1", text: "x".repeat(2001), category: "test" }),
    ).toThrow(/TEXT_TOO_LONG/);
  });
});

describe("the lock", () => {
  it("refuses a text edit once the question has answers", () => {
    const db = open();
    expect(promptIsLocked(db, "q1")).toBe(false);

    answerQ1(db);
    expect(promptIsLocked(db, "q1")).toBe(true);
    expect(() => updatePrompt(db, { id: "q1", text: "something else" })).toThrow(/PROMPT_LOCKED/);
  });

  it("still allows the tag, the iterations and the switch", () => {
    const db = open();
    answerQ1(db);

    updatePrompt(db, { id: "q1", category: "comparison" });
    updatePrompt(db, { id: "q1", isActive: false });
    updatePrompt(db, { id: "q1", iterations: 3 });

    const row = listPrompts(db, "p1")[0];
    expect(row).toMatchObject({ category: "comparison", is_active: 0, iterations: 3 });
  });

  it("clones to an inactive copy so a run between the two cannot ask it twice", () => {
    const db = open();
    answerQ1(db);
    const { id } = clonePrompt(db, "q1");

    const copy = listPrompts(db, "p1").find((prompt) => prompt.id === id);
    expect(copy).toMatchObject({ text: "best analytics tools", is_active: 0, iterations: 2 });
    expect(promptIsLocked(db, id)).toBe(false);
  });

  it("refuses to clone a question that does not exist", () => {
    const db = open();
    expect(() => clonePrompt(db, "gone")).toThrow(/PROMPT_NOT_FOUND/);
  });
});

describe("promptAnswerCounts", () => {
  it("counts done tasks per prompt and leaves the rest out", () => {
    const db = open();
    answerQ1(db);
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status, next_attempt_at)
       VALUES ('t2', 'r1', 'p1', 'q1', ?, 2, 'failed', '2026-01-01T00:00:00.000Z')`,
    ).run(HAIKU);

    expect(promptAnswerCounts(db, "p1")).toEqual({ q1: 1 });
  });
});

describe("deletePrompt", () => {
  it("deletes a second measured prompt instead of raising an index error", () => {
    // The scope index coalesces a null prompt_id to the empty string. If a
    // delete nulled the metric rows instead of removing them, two level 0 rows
    // that differed only by prompt would become one key once both prompts were
    // gone, and the second delete would fail on run_metrics_scope_idx.
    const db = open();
    const { id: first } = createPrompt(db, {
      projectId: "p1",
      text: "best analytics tools?",
      category: "test",
    });
    const { id: second } = createPrompt(db, {
      projectId: "p1",
      text: "cheapest analytics tool?",
      category: "test",
    });
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot)
       VALUES ('r1', 'p1', 'completed', 4, '{}')`,
    ).run();
    const metric = db.prepare(
      `INSERT INTO run_metrics
         (id, run_id, project_id, model_id, prompt_id, brand_id,
          answers, mentions, ranked, citations, mention_rate, rank_rate, citation_rate)
       VALUES (?, 'r1', 'p1', ?, ?, 'p1-brand', 4, 2, 1, 0, 0.5, 0.25, 0)`,
    );
    metric.run("m1", HAIKU, first);
    metric.run("m2", HAIKU, second);

    expect(() => deletePrompt(db, first)).not.toThrow();
    expect(() => deletePrompt(db, second)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_metrics").get<{ n: number }>()?.n).toBe(0);
  });

  it("takes the past answers with it, as the delete dialog warns", () => {
    // Answers kept with a null prompt_id could not be classified, so a deleted
    // brand-named question would keep counting. Archive keeps history, delete
    // removes it, and the dialog says so before either.
    const db = open();
    answerQ1(db);

    deletePrompt(db, "q1");

    expect(
      db.prepare("SELECT count(*) AS c FROM run_tasks WHERE id = 't1'").get<{ c: number }>()?.c,
    ).toBe(0);
  });

  it("refuses a question that does not exist", () => {
    const db = open();
    expect(() => deletePrompt(db, "gone")).toThrow(/PROMPT_NOT_FOUND/);
  });
});

/* ------------------------------------------------- three states, duplicates */

describe("duplicate prompts", () => {
  it("refuses a new prompt whose text already exists, however it is cased or padded", () => {
    const db = open();
    expect(() =>
      createPrompt(db, { projectId: "p1", text: "  BEST analytics tools ", category: "test" }),
    ).toThrow(/PROMPT_DUPLICATE/);
  });

  it("folds case outside A to Z, and accents typed either way", () => {
    const db = open();
    createPrompt(db, { projectId: "p1", text: "¿qué crm elijo?", category: "test" });
    expect(() =>
      createPrompt(db, { projectId: "p1", text: "¿QUÉ CRM ELIJO?", category: "test" }),
    ).toThrow(/PROMPT_DUPLICATE/);
    // "é" as one code point against "e" plus a combining acute accent.
    expect(() =>
      createPrompt(db, { projectId: "p1", text: "¿qué crm elijo?", category: "test" }),
    ).toThrow(/PROMPT_DUPLICATE/);
  });

  it("refuses against an off prompt and against an archived one, and says where the archived twin hides", () => {
    const db = open();
    updatePrompt(db, { id: "q1", isActive: false });
    expect(() =>
      createPrompt(db, { projectId: "p1", text: "best analytics tools", category: "test" }),
    ).toThrow(/PROMPT_DUPLICATE/);

    updatePrompt(db, { id: "q1", isActive: true });
    setPromptArchived(db, { id: "q1", archived: true });
    expect(() =>
      createPrompt(db, { projectId: "p1", text: "best analytics tools", category: "test" }),
    ).toThrow(/archived/);
  });

  it("refuses editing a prompt into a duplicate of another, but not into its own text", () => {
    const db = open();
    const { id } = createPrompt(db, {
      projectId: "p1",
      text: "cheapest analytics tools",
      category: "test",
    });
    expect(() => updatePrompt(db, { id, text: "Best Analytics Tools" })).toThrow(
      /PROMPT_DUPLICATE/,
    );
    // Saving a row without changing it must not be a duplicate of itself.
    expect(updatePrompt(db, { id, text: "cheapest analytics tools" })).toEqual({ ok: true });
  });

  it("still lets a locked prompt be cloned, which is how a locked prompt is edited", () => {
    const db = open();
    answerQ1(db);
    const { id } = clonePrompt(db, "q1");
    const clone = listPrompts(db, "p1").find((prompt) => prompt.id === id);
    expect(clone?.text).toBe("best analytics tools");
    expect(clone?.is_active).toBe(0);
  });
});

describe("archive and restore", () => {
  it("hides a prompt without touching its on/off state, and restores it as it was", () => {
    const db = open();
    updatePrompt(db, { id: "q1", isActive: false });
    setPromptArchived(db, { id: "q1", archived: true });

    let row = listPrompts(db, "p1")[0]!;
    expect(row.archived).toBe(1);
    expect(row.is_active).toBe(0);

    setPromptArchived(db, { id: "q1", archived: false });
    row = listPrompts(db, "p1")[0]!;
    expect(row.archived).toBe(0);
    expect(row.is_active).toBe(0);
  });

  it("refuses a prompt that does not exist", () => {
    const db = open();
    expect(() => setPromptArchived(db, { id: "gone", archived: true })).toThrow(/PROMPT_NOT_FOUND/);
  });
});

describe("delete cascades", () => {
  /** A completed, finalised run with answered tasks for q1 and q2. */
  function seedFinalisedRun(db: Driver): void {
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot)
       VALUES ('r1', 'p1', 'completed', 4, '{}')`,
    ).run();
    for (const [taskId, promptId] of [
      ["t1", "q1"],
      ["t2", "q2"],
    ] as const) {
      db.prepare(
        `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status, next_attempt_at, answer_text)
         VALUES (?, 'r1', 'p1', ?, ?, 1, 'done', '2026-01-01T00:00:00.000Z', 'an answer')`,
      ).run(taskId, promptId, HAIKU);
      db.prepare(
        `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, brand_id, raw_name, mention_type)
         VALUES (?, ?, 'r1', 'p1', 'p1-brand', 'Acme Analytics', 'ranked')`,
      ).run(`o-${taskId}`, taskId);
    }
    db.prepare(
      `INSERT INTO extractions (id, run_task_id, project_id, answer_format, raw_json, model_used)
       VALUES ('e1', 't1', 'p1', 'ranked_list', '{}', 'test')`,
    ).run();
    finalizeRun(db, "r1");
  }

  it("takes the answers, their observations, extractions and metric rows with it, and re-scores the run", () => {
    const db = open();
    createPrompt(db, { projectId: "p1", text: "second question", category: "test" });
    db.prepare("UPDATE prompts SET id = 'q2' WHERE text = 'second question'").run();
    seedFinalisedRun(db);

    const before = db
      .prepare("SELECT sum(answers) AS total FROM run_metrics WHERE prompt_id IS NOT NULL")
      .get<{ total: number }>();
    expect(before?.total).toBe(2);

    deletePrompt(db, "q1");

    expect(
      db.prepare("SELECT count(*) c FROM prompts WHERE id = 'q1'").get<{ c: number }>()?.c,
    ).toBe(0);
    // The answers go too. No orphaned task keeps the question alive.
    expect(
      db.prepare("SELECT count(*) c FROM run_tasks WHERE prompt_id IS NULL").get<{ c: number }>()
        ?.c,
    ).toBe(0);
    expect(
      db.prepare("SELECT count(*) c FROM run_tasks WHERE id = 't1'").get<{ c: number }>()?.c,
    ).toBe(0);
    expect(db.prepare("SELECT count(*) c FROM extractions").get<{ c: number }>()?.c).toBe(0);
    expect(
      db.prepare("SELECT count(*) c FROM brand_observations WHERE id = 'o-t1'").get<{ c: number }>()
        ?.c,
    ).toBe(0);
    // The surviving prompt's per-prompt row is all that is left of the scoring.
    const after = db
      .prepare("SELECT sum(answers) AS total FROM run_metrics WHERE prompt_id IS NOT NULL")
      .get<{ total: number }>();
    expect(after?.total).toBe(1);
    expect(
      db.prepare("SELECT count(*) c FROM run_metrics WHERE prompt_id = 'q1'").get<{ c: number }>()
        ?.c,
    ).toBe(0);
  });

  it("re-finalising after the delete cannot bring the answers back", () => {
    const db = open();
    createPrompt(db, { projectId: "p1", text: "second question", category: "test" });
    db.prepare("UPDATE prompts SET id = 'q2' WHERE text = 'second question'").run();
    seedFinalisedRun(db);
    deletePrompt(db, "q1");

    finalizeRun(db, "r1");
    expect(
      db.prepare("SELECT count(*) c FROM run_tasks WHERE prompt_id IS NULL").get<{ c: number }>()
        ?.c,
    ).toBe(0);
    const after = db
      .prepare("SELECT sum(answers) AS total FROM run_metrics WHERE prompt_id IS NOT NULL")
      .get<{ total: number }>();
    expect(after?.total).toBe(1);
  });

  it("recounts a run still in progress and shrinks its plan by the calls it removed", () => {
    const db = open();
    createPrompt(db, { projectId: "p1", text: "second question", category: "test" });
    db.prepare("UPDATE prompts SET id = 'q2' WHERE text = 'second question'").run();
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot)
       VALUES ('r1', 'p1', 'running', 6, '{}')`,
    ).run();
    const task = db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status, answer_text)
       VALUES (?, 'r1', 'p1', ?, ?, ?, ?, ?)`,
    );
    task.run("t1", "q1", HAIKU, 1, "queued", null);
    task.run("t2", "q1", HAIKU, 2, "queued", null);
    task.run("t3", "q2", HAIKU, 1, "done", "an answer");

    deletePrompt(db, "q1");

    expect(
      db
        .prepare("SELECT status, planned_calls, finalised_at FROM runs WHERE id = 'r1'")
        .get<{ status: string; planned_calls: number; finalised_at: string | null }>(),
    ).toEqual({ status: "completed", planned_calls: 2, finalised_at: null });
  });

  it("deleting a prompt nobody answered just deletes it", () => {
    const db = open();
    expect(deletePrompt(db, "q1")).toEqual({ ok: true });
    expect(listPrompts(db, "p1")).toHaveLength(0);
  });
});

describe("duplicate scope and archive history", () => {
  it("allows the same text in a different project", () => {
    const db = open();
    seedProject(db, {
      id: "p2",
      name: "Northwind Metrics",
      brand: "Northwind Metrics",
      prompts: [],
    });
    const { id } = createPrompt(db, {
      projectId: "p2",
      text: "best analytics tools",
      category: "test",
    });
    expect(id.length).toBeGreaterThan(0);
  });

  it("names the visible twin, not the archived one, when a clone left both", () => {
    const db = open();
    answerQ1(db); // locks q1, so cloning is the way to reuse its text
    clonePrompt(db, "q1"); // visible, inactive twin
    setPromptArchived(db, { id: "q1", archived: true });

    expect(() =>
      createPrompt(db, { projectId: "p1", text: "best analytics tools", category: "test" }),
    ).toThrow(/you already have this question$/);
  });

  it("keeps an archived prompt's answers scoring in its run", () => {
    const db = open();
    answerQ1(db);
    db.prepare(
      `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, brand_id, raw_name, mention_type)
       VALUES ('o1', 't1', 'r1', 'p1', 'p1-brand', 'Acme Analytics', 'ranked')`,
    ).run();
    finalizeRun(db, "r1");
    const count = () =>
      db
        .prepare("SELECT count(*) AS c FROM run_metrics WHERE prompt_id = 'q1'")
        .get<{ c: number }>()?.c ?? 0;
    const before = count();
    expect(before).toBeGreaterThan(0);

    setPromptArchived(db, { id: "q1", archived: true });

    expect(count()).toBe(before);
  });
});

describe("a clone must differ before it can be turned on", () => {
  it("refuses to activate a clone whose text still matches its visible twin", () => {
    const db = open();
    answerQ1(db);
    const { id } = clonePrompt(db, "q1");

    expect(() => updatePrompt(db, { id, isActive: true })).toThrow(/PROMPT_IDENTICAL/);
    expect(() => updatePrompt(db, { id, isActive: true })).toThrow(
      /edit this prompt first; it is still identical to another prompt/,
    );
    expect(() => updatePrompt(db, { id, isActive: true })).toThrow(/PROMPT_IDENTICAL/);
    expect(listPrompts(db, "p1").find((prompt) => prompt.id === id)?.is_active).toBe(0);
  });

  it("names the archived fold when the twin is the archived one", () => {
    const db = open();
    const { id } = clonePrompt(db, "q1");
    setPromptArchived(db, { id: "q1", archived: true });

    expect(() => updatePrompt(db, { id, isActive: true })).toThrow(
      /identical to an archived prompt/,
    );
  });

  it("compares trimmed and case-insensitively, the way the duplicate rule does", () => {
    const db = open();
    // Only a direct insert can produce an untrimmed, differently-cased twin,
    // because every op path trims and refuses duplicates, so the activation
    // check gets its own test.
    db.prepare(
      `INSERT INTO prompts (id, project_id, text, iterations, is_active, created_at, updated_at)
       VALUES ('c1', 'p1', '  BEST ANALYTICS TOOLS ', 2, 0, '2026-01-01', '2026-01-01')`,
    ).run();

    expect(() => updatePrompt(db, { id: "c1", isActive: true })).toThrow(/PROMPT_IDENTICAL/);
  });

  it("activates normally once the clone's text differs", () => {
    const db = open();
    const { id } = clonePrompt(db, "q1");
    updatePrompt(db, { id, text: "which analytics tool is cheapest?" });

    updatePrompt(db, { id, isActive: true });
    expect(listPrompts(db, "p1").find((prompt) => prompt.id === id)?.is_active).toBe(1);
  });

  it("accepts an edit-and-activate in one call when the new text differs", () => {
    const db = open();
    const { id } = clonePrompt(db, "q1");

    updatePrompt(db, { id, text: "a genuinely different question", isActive: true });
    expect(listPrompts(db, "p1").find((prompt) => prompt.id === id)?.is_active).toBe(1);
  });

  it("still reports a duplicate, not the activation refusal, when the new text is another prompt's", () => {
    const db = open();
    createPrompt(db, { projectId: "p1", text: "which tool is cheapest?", category: "test" });
    const { id } = clonePrompt(db, "q1");

    expect(() => updatePrompt(db, { id, text: "which tool is cheapest?", isActive: true })).toThrow(
      /PROMPT_DUPLICATE/,
    );
  });

  it("turning a prompt off always works, twin or not", () => {
    const db = open();
    updatePrompt(db, { id: "q1", isActive: false });
    const { id } = clonePrompt(db, "q1");

    updatePrompt(db, { id, isActive: false });
    updatePrompt(db, { id: "q1", isActive: false });
    expect(listPrompts(db, "p1").every((prompt) => prompt.is_active === 0)).toBe(true);
  });
});

describe("every question carries a tag", () => {
  it("refuses to create one without a tag, however it is blanked", () => {
    const db = open();
    expect(() => createPrompt(db, { projectId: "p1", text: "a", category: "" })).toThrow(/NO_TAG/);
    expect(() => createPrompt(db, { projectId: "p1", text: "a", category: "   " })).toThrow(
      /every prompt needs a tag/,
    );
  });

  it("stores the tag trimmed", () => {
    const db = open();
    const { id } = createPrompt(db, { projectId: "p1", text: "a", category: "  visibility " });
    expect(listPrompts(db, "p1").find((prompt) => prompt.id === id)?.category).toBe("visibility");
  });

  it("refuses to clear a tag again", () => {
    const db = open();
    expect(() => updatePrompt(db, { id: "q1", category: null })).toThrow(/NO_TAG/);
    expect(() => updatePrompt(db, { id: "q1", category: "   " })).toThrow(/NO_TAG/);
    expect(() => updatePrompt(db, { id: "q1", category: null })).toThrow(
      /cannot go back to no tag/,
    );
  });

  it("leaves an untagged row editable in every other way", () => {
    const db = open(); // q1 is seeded without a tag, as old rows are
    expect(listPrompts(db, "p1")[0]?.category).toBeNull();

    updatePrompt(db, { id: "q1", iterations: 4 });
    updatePrompt(db, { id: "q1", isActive: false });
    updatePrompt(db, { id: "q1", category: "visibility" });

    expect(listPrompts(db, "p1")[0]).toMatchObject({
      category: "visibility",
      is_active: 0,
      iterations: 4,
    });
  });
});
