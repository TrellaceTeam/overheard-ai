import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver, SqlParam } from "../db/driver";
import { demoShowcaseRunId } from "@/lib/demo-ids";
import { PERCEPTION_TEMPLATE, resolvePerceptionPrompt } from "@/lib/perception";
import { isSelfReferenced } from "@/lib/selfReference";
import { DEMO_BRAND, DEMO_JUMP_WEEK, DEMO_WEEKS, ensureDemoProject } from "./demo-project";
import { freshDb } from "./test-support";

// This file is excepted from the fictional-brands rule (CONTRIBUTING.md,
// ADR 0006): it tests the demo generator, which is about real companies with
// invented data. Nothing else in the repo may copy these names into fixtures.

let db: Driver;
let projectId: string;

/** A fixed "today" so every assertion is about one deterministic database. */
const TODAY = new Date("2026-09-24T15:04:05Z");

beforeEach(() => {
  db = freshDb();
  projectId = ensureDemoProject(db, { today: TODAY }).projectId;
});

afterEach(() => {
  db.close();
});

function one<T>(sql: string, ...args: SqlParam[]): T {
  const row = db.prepare(sql).get<T>(...args);
  if (!row) throw new Error(`no row: ${sql}`);
  return row;
}

function all<T>(sql: string, ...args: SqlParam[]): T[] {
  return db.prepare(sql).all<T>(...args);
}

function brandId(name: string): string {
  return one<{ id: string }>(
    "SELECT id FROM brands WHERE project_id = ? AND name = ?",
    projectId,
    name,
  ).id;
}

/** The prompt that names the project's own brand; the served views exclude it. */
function selfReferencedPromptId(): string {
  const prompts = all<{ id: string; text: string }>(
    "SELECT id, text FROM prompts WHERE project_id = ?",
    projectId,
  );
  const matches = prompts.filter((prompt) =>
    isSelfReferenced(prompt.text, { name: DEMO_BRAND.name, variants: [] }),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.id;
}

/**
 * The series the screens serve: level-0 metric rows, minus the
 * self-referenced prompt, aggregated per run the way the dashboard does
 * (mentions over distinct-scope answers). Pinning the story here, not on the
 * run-wide rows, guards what a user sees.
 */
function servedMentionSeries(brand: string): number[] {
  const selfRef = selfReferencedPromptId();
  const brand_ = brandId(brand);
  const runs = all<{ id: string }>(
    "SELECT id FROM runs WHERE project_id = ? AND trigger = 'scheduled' ORDER BY created_at",
    projectId,
  );
  return runs.map((run) => {
    const mentions = one<{ n: number }>(
      `SELECT COALESCE(SUM(mentions), 0) AS n FROM run_metrics
        WHERE run_id = ? AND model_id IS NOT NULL AND brand_id = ? AND prompt_id <> ?`,
      run.id,
      brand_,
      selfRef,
    ).n;
    const answers = one<{ n: number }>(
      `SELECT COALESCE(SUM(answers), 0) AS n
         FROM (SELECT DISTINCT model_id, prompt_id, answers FROM run_metrics
                WHERE run_id = ? AND model_id IS NOT NULL AND prompt_id <> ?)`,
      run.id,
      selfRef,
    ).n;
    return answers === 0 ? 0 : mentions / answers;
  });
}

function servedAvgRanks(brand: string): number[] {
  const selfRef = selfReferencedPromptId();
  const brand_ = brandId(brand);
  const runs = all<{ id: string }>(
    "SELECT id FROM runs WHERE project_id = ? AND trigger = 'scheduled' ORDER BY created_at",
    projectId,
  );
  return runs.map(
    (run) =>
      one<{ avg: number | null }>(
        `SELECT AVG(avg_rank) AS avg FROM run_metrics
        WHERE run_id = ? AND model_id IS NOT NULL AND brand_id = ? AND prompt_id <> ?
          AND avg_rank IS NOT NULL`,
        run.id,
        brand_,
        selfRef,
      ).avg ?? Number.NaN,
  );
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("ensureDemoProject", () => {
  it("creates the demo once and returns it unchanged afterwards", () => {
    const first = ensureDemoProject(db, { today: TODAY });
    const second = ensureDemoProject(db, { today: new Date("2027-01-01T00:00:00Z") });

    expect(first.created).toBe(false); // beforeEach already created it
    expect(second).toEqual({ projectId, created: false });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE is_demo = 1").n).toBe(1);
  });

  it("marks the project as the demo and names the real brand", () => {
    const project = one<{ name: string; is_demo: number }>(
      "SELECT name, is_demo FROM projects WHERE id = ?",
      projectId,
    );
    expect(project.name).toBe(DEMO_BRAND.name);
    expect(project.is_demo).toBe(1);
  });
});

describe("the demo history", () => {
  it("holds 26 weekly mock runs ending on the creation day, plus one perception run", () => {
    const measured = all<{
      created_at: string;
      status: string;
      mock: number;
      finalised_at: string | null;
    }>(
      `SELECT created_at, status, mock, finalised_at FROM runs
        WHERE project_id = ? AND trigger = 'scheduled' ORDER BY created_at`,
      projectId,
    );
    expect(measured).toHaveLength(DEMO_WEEKS);
    measured.forEach((run) => {
      // Every week finished clean, the showcase run included.
      expect(run.status).toBe("completed");
      expect(run.mock).toBe(1);
      expect(run.finalised_at).not.toBeNull();
    });

    // Weekly, to the day, ending at noon UTC on the creation day.
    expect(measured[DEMO_WEEKS - 1]!.created_at).toBe("2026-09-24T12:00:00.000Z");
    for (let i = 1; i < measured.length; i++) {
      const gap = Date.parse(measured[i]!.created_at) - Date.parse(measured[i - 1]!.created_at);
      expect(gap).toBe(7 * 24 * 60 * 60 * 1000);
    }

    const perception = all<{ config_snapshot: string; mock: number }>(
      "SELECT config_snapshot, mock FROM runs WHERE project_id = ? AND trigger = 'manual'",
      projectId,
    );
    expect(perception).toHaveLength(1);
    expect(JSON.parse(perception[0]!.config_snapshot)).toEqual({ perception_only: true });
    expect(perception[0]!.mock).toBe(1);
  });

  it.each([
    ["2026-12-25T09:00:00Z", "2026-12-24T12:00:00.000Z"],
    ["2026-12-25T12:00:00Z", "2026-12-25T12:00:00.000Z"],
  ])("ends the history at the last noon UTC at or before %s", (today, latest) => {
    const other = freshDb();
    try {
      const id = ensureDemoProject(other, { today: new Date(today) }).projectId;
      const newest = other
        .prepare(
          `SELECT MAX(created_at) AS latest FROM runs
            WHERE project_id = ? AND trigger = 'scheduled'`,
        )
        .get<{ latest: string }>(id);
      expect(newest?.latest).toBe(latest);
    } finally {
      other.close();
    }
  });

  it("scores through the real pipeline: tasks done, extractions, metrics at both levels", () => {
    const tasks = one<{ n: number; done: number }>(
      `SELECT COUNT(*) AS n, SUM(status = 'done') AS done FROM run_tasks
        WHERE project_id = ? AND is_perception = 0`,
      projectId,
    );
    expect(tasks.n).toBe(DEMO_WEEKS * 4 * 3 * 3); // weeks × prompts × assistants × iterations
    expect(tasks.done).toBe(tasks.n);
    expect(
      one<{ n: number }>("SELECT COUNT(*) AS n FROM extractions WHERE project_id = ?", projectId).n,
    ).toBe(tasks.n);

    const levels = one<{ per_scope: number; run_wide: number }>(
      `SELECT SUM(model_id IS NOT NULL) AS per_scope, SUM(model_id IS NULL) AS run_wide
         FROM run_metrics WHERE project_id = ?`,
      projectId,
    );
    expect(levels.per_scope).toBeGreaterThan(0);
    expect(levels.run_wide).toBeGreaterThan(0);

    // The metric window and the trend axis key off run_metrics.created_at, so
    // those must carry the run's week, not the generation moment.
    const stale = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_metrics m JOIN runs r ON r.id = m.run_id
        WHERE m.project_id = ? AND m.created_at <> r.created_at`,
      projectId,
    );
    expect(stale.n).toBe(0);
  });

  it("finished clean: every call in the history was collected", () => {
    expect(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM run_tasks WHERE project_id = ? AND status <> 'done'`,
        projectId,
      ).n,
    ).toBe(0);
    // Every task carries its answer, and every answer was read back.
    expect(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM run_tasks t LEFT JOIN extractions e ON e.run_task_id = t.id
          WHERE t.project_id = ? AND t.is_perception = 0 AND e.id IS NULL`,
        projectId,
      ).n,
    ).toBe(0);
  });
});

describe("the showcase run", () => {
  function showcaseRunId(): string {
    return one<{ id: string }>(
      `SELECT id FROM runs WHERE project_id = ? AND trigger = 'scheduled'
        ORDER BY created_at DESC LIMIT 1`,
      projectId,
    ).id;
  }

  it("is the newest weekly run and carries the deterministic id the tour names", () => {
    expect(showcaseRunId()).toBe(demoShowcaseRunId());
  });

  it("reconciles its own counters, and only its own", () => {
    const run = one<{
      status: string;
      planned_calls: number;
      completed_calls: number;
      failed_calls: number;
    }>(
      "SELECT status, planned_calls, completed_calls, failed_calls FROM runs WHERE id = ?",
      showcaseRunId(),
    );
    expect(run.status).toBe("completed");
    expect(run.planned_calls).toBe(36 * 2);
    expect(run.completed_calls).toBe(36 * 2);
    expect(run.failed_calls).toBe(0);

    // The showcase run is not special: every week finished like it did.
    const others = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM runs
        WHERE project_id = ? AND trigger = 'scheduled' AND id <> ? AND status <> 'completed'`,
      projectId,
      showcaseRunId(),
    );
    expect(others.n).toBe(0);
  });

  it("scores all 36 answers, so the dashboard story is the whole week", () => {
    const rows = all<{ answers: number }>(
      "SELECT answers FROM run_metrics WHERE run_id = ? AND model_id IS NULL",
      showcaseRunId(),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.answers).toBe(36);
  });

  it("comes out of two fresh builds identical, ids included", () => {
    const build = (): string[] => {
      const other = freshDb();
      try {
        const id = ensureDemoProject(other, { today: TODAY }).projectId;
        return other
          .prepare(`SELECT id FROM runs WHERE project_id = ? ORDER BY created_at, trigger`)
          .all<{ id: string }>(id)
          .map((row) => row.id);
      } finally {
        other.close();
      }
    };
    expect(build()).toEqual(build());
  });
});

describe("the story", () => {
  it("starts Ramp low and ends it clearly higher, in the served numbers", () => {
    const ramp = servedMentionSeries(DEMO_BRAND.name);
    expect(ramp).toHaveLength(DEMO_WEEKS);
    expect(average(ramp.slice(0, 8))).toBeLessThan(0.3);
    expect(average(ramp.slice(-8))).toBeGreaterThan(average(ramp.slice(0, 8)) + 0.2);
  });

  it(`jumps at week ${DEMO_JUMP_WEEK}, after the fictional press moment`, () => {
    const ramp = servedMentionSeries(DEMO_BRAND.name);
    const before = average(ramp.slice(0, DEMO_JUMP_WEEK - 1));
    const after = average(ramp.slice(DEMO_JUMP_WEEK - 1));
    expect(after).toBeGreaterThan(before + 0.2);
    // The jump shows in its own week, not just in the averages around it.
    expect(ramp[DEMO_JUMP_WEEK - 1]!).toBeGreaterThan(ramp[DEMO_JUMP_WEEK - 2]! + 0.1);
  });

  it("improves Ramp's rank after the jump", () => {
    const ranks = servedAvgRanks(DEMO_BRAND.name).filter((rank) => !Number.isNaN(rank));
    expect(average(ranks.slice(-8))).toBeLessThan(average(ranks.slice(0, 8)));
  });

  it("keeps Brex high and steady, Navan flat, and lets Mercury dip", () => {
    const brex = servedMentionSeries("Brex");
    expect(average(brex)).toBeGreaterThan(0.6);
    expect(Math.max(...brex) - Math.min(...brex)).toBeLessThan(0.35);

    const navan = servedMentionSeries("Navan");
    expect(Math.abs(average(navan.slice(-8)) - average(navan.slice(0, 8)))).toBeLessThan(0.12);

    const mercury = servedMentionSeries("Mercury");
    expect(average(mercury.slice(-8))).toBeLessThan(average(mercury.slice(0, 8)) - 0.05);
  });

  it("cites the brands' own domains sometimes", () => {
    const cited = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM brand_observations
        WHERE project_id = ? AND is_cited = 1 AND linked_url LIKE '%ramp.com%'`,
      projectId,
    );
    expect(cited.n).toBeGreaterThan(0);
  });
});

describe("prompts and perception", () => {
  it("includes a self-referenced prompt whose answers exist but are detectable", () => {
    const prompts = all<{ text: string }>(
      "SELECT text FROM prompts WHERE project_id = ?",
      projectId,
    );
    expect(prompts).toHaveLength(4);
    const selfReferenced = prompts.filter((p) =>
      isSelfReferenced(p.text, { name: DEMO_BRAND.name, variants: [] }),
    );
    expect(selfReferenced).toHaveLength(1);

    // Its answers were collected like any other prompt's (the exclusion from
    // statistics happens at read time and is covered by the metrics tests).
    const answered = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_tasks t JOIN prompts p ON p.id = t.prompt_id
        WHERE t.project_id = ? AND p.text = ? AND t.answer_text IS NOT NULL`,
      projectId,
      selfReferenced[0]!.text,
    );
    expect(answered.n).toBe(DEMO_WEEKS * 3 * 3);
  });

  it("carries one set of perception summaries for the newest run, never stale, with researched downsides", () => {
    const summaries = all<{
      model_id: string | null;
      knows_brand: number;
      what_it_does: string;
      downsides: string;
      question_text: string | null;
      run_id: string | null;
    }>(
      "SELECT model_id, knows_brand, what_it_does, downsides, question_text, run_id FROM perception_summaries WHERE project_id = ?",
      projectId,
    );
    expect(summaries).toHaveLength(4); // three assistants + the merged row

    const expectedQuestion = resolvePerceptionPrompt(PERCEPTION_TEMPLATE, DEMO_BRAND.name);
    for (const summary of summaries) {
      expect(summary.knows_brand).toBe(1);
      expect(summary.question_text).toBe(expectedQuestion);
      expect(summary.run_id).not.toBeNull();
      // ADR 0006: the downsides section reports commonly published criticisms
      // in neutral phrasing instead of staying empty.
      expect(summary.downsides.length).toBeGreaterThan(40);
    }
    const merged = summaries.filter((s) => s.model_id === null);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.downsides).toMatch(/support/i);
    expect(merged[0]!.downsides).toMatch(/underwriting/i);
    // The assistants do not read as one canned row times three.
    const distinct = new Set(
      summaries.filter((s) => s.model_id !== null).map((s) => s.what_it_does),
    );
    expect(distinct.size).toBe(3);
  });
});
