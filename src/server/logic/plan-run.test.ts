/**
 * planRun: the count the Run button shows and createRun spends against.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import { answersPerAssistant, planRun } from "./plan-run";
import { freshDb, HAIKU, seedProject, SONNET } from "./test-support";

let db: Driver;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

describe("planRun", () => {
  it("multiplies active prompts by their iterations by the monitored assistants", () => {
    seedProject(db, {
      prompts: [
        { id: "q1", text: "best analytics tools", iterations: 3 },
        { id: "q2", text: "top search platforms", iterations: 2 },
      ],
      models: [HAIKU, SONNET],
    });

    const plan = planRun(db, "p1");

    expect(plan).toEqual({ prompts: 2, assistants: 2, answers: 10, calls: 20 });
    expect(answersPerAssistant(plan)).toBe(5);
  });

  it("ignores an inactive prompt", () => {
    seedProject(db, {
      prompts: [
        { id: "q1", text: "best analytics tools", iterations: 3 },
        { id: "q2", text: "top search platforms", iterations: 9, isActive: false },
      ],
    });

    expect(planRun(db, "p1")).toEqual({ prompts: 1, assistants: 1, answers: 3, calls: 6 });
  });

  it("raises NO_PROMPTS when nothing is active", () => {
    seedProject(db, { prompts: [{ id: "q1", text: "best analytics tools", isActive: false }] });

    expect(() => planRun(db, "p1")).toThrow(/NO_PROMPTS/);
  });

  it("ignores an archived prompt even while it is switched on", () => {
    seedProject(db, {
      prompts: [
        { id: "q1", text: "best analytics tools", iterations: 3 },
        { id: "q2", text: "top search platforms", iterations: 9 },
      ],
    });
    db.prepare("UPDATE prompts SET archived = 1 WHERE id = 'q2'").run();

    expect(planRun(db, "p1")).toEqual({ prompts: 1, assistants: 1, answers: 3, calls: 6 });
  });

  it("raises NO_PROMPTS when everything is archived", () => {
    seedProject(db, { prompts: [{ id: "q1", text: "best analytics tools" }] });
    db.prepare("UPDATE prompts SET archived = 1").run();

    expect(() => planRun(db, "p1")).toThrow(/NO_PROMPTS/);
  });

  it("raises NO_MODELS when no assistant is monitored", () => {
    seedProject(db, { models: [] });

    // The sentence reaches the user as is in the Run now dialog and the
    // Prompts panel, so it says assistant, the word the rest of the UI uses.
    expect(() => planRun(db, "p1")).toThrow("NO_MODELS: select at least one assistant");
  });

  it("raises RUN_TOO_LARGE above the configured limit, before anything is spent", () => {
    seedProject(db, {
      prompts: [{ id: "q1", text: "best analytics tools", iterations: 30 }],
      models: [HAIKU, SONNET],
    });
    db.prepare("UPDATE app_state SET max_planned_calls = 100 WHERE id = 1").run();

    // 30 iterations times 2 assistants is 60 answers, which is 120 calls: over 100.
    // The sentence carries the count the planner computed, the live limit and
    // where to change it, because it is shown as is in the Run dialog and the
    // Prompts panel. Once this throws there is no plan object to render.
    expect(() => planRun(db, "p1")).toThrow(
      /RUN_TOO_LARGE: this run plans 120 provider calls. Your run size limit is 100/,
    );
    expect(() => planRun(db, "p1")).toThrow(/Account settings/);
  });

  it("plans a run at exactly the limit", () => {
    seedProject(db, {
      prompts: [{ id: "q1", text: "best analytics tools", iterations: 25 }],
      models: [HAIKU, SONNET],
    });
    db.prepare("UPDATE app_state SET max_planned_calls = 100 WHERE id = 1").run();

    // 25 iterations times 2 assistants is 50 answers, which is exactly 100 calls.
    expect(planRun(db, "p1").calls).toBe(100);
  });

  it("defaults to 1,000: a bigger plan is refused until the install raises the limit", () => {
    seedProject(db, {
      prompts: [{ id: "q1", text: "best analytics tools", iterations: 20 }],
    });

    for (let index = 2; index <= 26; index += 1) {
      db.prepare(
        "INSERT INTO prompts (id, project_id, text, iterations) VALUES (?, 'p1', 'more', 20)",
      ).run(`extra${index}`);
    }

    // 26 prompts times 20 iterations times 1 assistant is 520 answers: 1,040
    // calls, just over the default. Raising the limit is a decision a person
    // makes in Settings.
    expect(() => planRun(db, "p1")).toThrow(
      /RUN_TOO_LARGE: this run plans 1,040 provider calls. Your run size limit is 1,000/,
    );

    db.prepare("UPDATE app_state SET max_planned_calls = 500000 WHERE id = 1").run();
    expect(planRun(db, "p1").calls).toBe(1040);
  });

  it("always plans an even number of calls, two per answer", () => {
    seedProject(db, {
      prompts: [{ id: "q1", text: "best analytics tools", iterations: 7 }],
      models: [HAIKU, SONNET],
    });

    const plan = planRun(db, "p1");

    expect(plan.calls % 2).toBe(0);
    expect(plan.calls).toBe(plan.answers * 2);
  });
});
