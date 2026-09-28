import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb } from "../../logic/test-support";
import { deleteProject } from "./projects";
import { demoState, restoreDemoProject } from "./demo";
import { demoShowcaseRunId } from "@/lib/demo-ids";

let db: Driver;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

describe("demoState / restoreDemoProject", () => {
  it("reports no demo before one is restored", () => {
    expect(demoState(db)).toEqual({ exists: false, projectId: null });
  });

  it("restores the demo and reports it afterwards", () => {
    const { projectId } = restoreDemoProject(db);
    expect(demoState(db)).toEqual({ exists: true, projectId });
  });

  it("restoring twice never duplicates the demo", () => {
    const first = restoreDemoProject(db);
    const second = restoreDemoProject(db);
    expect(second).toEqual(first);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE is_demo = 1")
      .get<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("names the showcase run: the deterministic id when it just generated the demo", () => {
    const { showcaseRunId } = restoreDemoProject(db);
    expect(showcaseRunId).toBe(demoShowcaseRunId());
  });

  it("names the newest weekly run it can actually see for an existing demo", () => {
    // For a demo that already exists, the newest scheduled run is read back
    // whatever its id looks like, so the tour opens on a run that is in the
    // database.
    const { projectId } = restoreDemoProject(db);
    db.prepare(
      `INSERT INTO runs (id, project_id, trigger, status, planned_calls, completed_calls,
                          failed_calls, config_snapshot, created_at, mock)
       VALUES ('legacy-newest', ?, 'scheduled', 'completed', 2, 2, 0, '{}',
               '2030-01-01T12:00:00.000Z', 1)`,
    ).run(projectId);
    expect(restoreDemoProject(db).showcaseRunId).toBe("legacy-newest");
  });

  it("recreates the demo after the user deleted it, with fresh dates", () => {
    const first = restoreDemoProject(db);
    deleteProject(db, first.projectId);
    expect(demoState(db).exists).toBe(false);

    const second = restoreDemoProject(db);
    expect(second.projectId).not.toBe(first.projectId);
    expect(demoState(db)).toEqual({ exists: true, projectId: second.projectId });

    // The recreated history still ends today: a restore months later reads as
    // "the last six months", not as the original creation day.
    const newest = db
      .prepare(
        `SELECT MAX(created_at) AS latest FROM runs
          WHERE project_id = ? AND trigger = 'scheduled'`,
      )
      .get<{ latest: string }>(second.projectId);
    const age = Date.now() - Date.parse(newest?.latest ?? "");
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(24 * 60 * 60 * 1000);
  });
});

/* ------------------------------------------------------- browse-only demo */

describe("the demo project is browse-only", () => {
  let demoId: string;

  beforeEach(() => {
    demoId = restoreDemoProject(db).projectId;
  });

  const DEMO = /DEMO_PROJECT/;

  it("refuses every operation that starts work", async () => {
    const { createRun, createPerceptionRunOnly, retryFailed, cancelRun, deleteRun } = await import(
      "./runs"
    );
    const { saveSchedule, disableSchedule } = await import("./schedules");

    expect(() => createRun(db, demoId)).toThrow(DEMO);
    expect(() => createPerceptionRunOnly(db, demoId)).toThrow(DEMO);
    expect(() =>
      saveSchedule(db, {
        projectId: demoId,
        cadence: "weekly",
        dayOfWeek: 1,
        hourUtc: 9,
        timezone: "UTC",
      }),
    ).toThrow(DEMO);
    expect(() => disableSchedule(db, demoId)).toThrow(DEMO);

    // By run id, from any of the demo's generated runs.
    const run = db
      .prepare("SELECT id FROM runs WHERE project_id = ? LIMIT 1")
      .get<{ id: string }>(demoId)!;
    expect(() => retryFailed(db, run.id)).toThrow(DEMO);
    expect(() => cancelRun(db, run.id)).toThrow(DEMO);
    expect(() => deleteRun(db, run.id)).toThrow(DEMO);
  });

  it("refuses every edit of prompts, brands, models and settings", async () => {
    const { createPrompt, updatePrompt, clonePrompt, deletePrompt } = await import("./prompts");
    const { createCompetitor, updateBrand, setBrandRole, deleteBrand, recomputeCitations } =
      await import("./brands");
    const { setProjectModel } = await import("./models");
    const { updateProject } = await import("./projects");

    const prompt = db
      .prepare("SELECT id FROM prompts WHERE project_id = ? LIMIT 1")
      .get<{ id: string }>(demoId)!;
    const brand = db
      .prepare("SELECT id FROM brands WHERE project_id = ? AND role = 'competitor' LIMIT 1")
      .get<{ id: string }>(demoId)!;
    const model = db
      .prepare("SELECT id FROM models WHERE is_extraction_model = 0 LIMIT 1")
      .get<{ id: string }>()!;

    expect(() =>
      createPrompt(db, { projectId: demoId, text: "A new question?", category: "test" }),
    ).toThrow(DEMO);
    expect(() => updatePrompt(db, { id: prompt.id, text: "Edited." })).toThrow(DEMO);
    expect(() => clonePrompt(db, prompt.id)).toThrow(DEMO);
    expect(() => deletePrompt(db, prompt.id)).toThrow(DEMO);

    expect(() =>
      createCompetitor(db, {
        projectId: demoId,
        name: "Contoso Insights",
        domain: "contoso.example.com",
      }),
    ).toThrow(DEMO);
    expect(() => updateBrand(db, { id: brand.id, variants: ["Something Else"] })).toThrow(DEMO);
    expect(() => setBrandRole(db, { id: brand.id, role: "discovered" })).toThrow(DEMO);
    expect(() => recomputeCitations(db, brand.id)).toThrow(DEMO);
    expect(() => deleteBrand(db, brand.id)).toThrow(DEMO);

    expect(() => setProjectModel(db, { projectId: demoId, modelId: model.id, on: true })).toThrow(
      DEMO,
    );
    expect(() => updateProject(db, { projectId: demoId, name: "Renamed" })).toThrow(DEMO);
  });

  it("still deletes, so Restore has something to restore", () => {
    expect(deleteProject(db, demoId)).toEqual({ ok: true });
    expect(demoState(db).exists).toBe(false);
  });

  it("is never enqueued by the scheduler, even with a due schedule", async () => {
    // A schedule cannot be saved through the operation (refused above), but a
    // hand-written row must not sneak a run past the sweep either.
    db.prepare(
      `INSERT INTO schedules (id, project_id, cadence, hour_utc, timezone, is_active, next_run_at)
       VALUES ('demo-schedule', ?, 'weekly', 9, 'UTC', 1, '2020-01-01T00:00:00.000Z')`,
    ).run(demoId);

    const { enqueueScheduledRuns } = await import("../../logic/scheduler");
    const createRunFn = vi.fn();
    const summary = enqueueScheduledRuns(db, new Date("2026-09-24T12:00:00Z"), createRunFn);

    expect(summary.created).toBe(0);
    expect(createRunFn).not.toHaveBeenCalled();
  });
});

describe("demoPrefill", () => {
  it("serves the tutorial the demo's own setup values", async () => {
    // Asserted through the generator's exports, not literals, so this test
    // cannot drift from the project the tutorial goes on to create, and the
    // demo's real brand names stay where ADR 0006 allows them.
    const { demoPrefill } = await import("./demo");
    const { DEMO_BRAND, DEMO_COMPETITORS, DEMO_ITERATIONS, DEMO_PROMPTS } = await import(
      "../../logic/demo-project"
    );
    const prefill = demoPrefill();
    expect(prefill.brandName).toBe(DEMO_BRAND.name);
    expect(prefill.domains).toEqual([DEMO_BRAND.domain]);
    expect(prefill.competitors).toEqual(DEMO_COMPETITORS.map((competitor) => competitor.name));
    expect(prefill.category.length).toBeGreaterThan(0);
    expect(prefill.prompts).toEqual(
      DEMO_PROMPTS.map((prompt) => ({
        text: prompt.text,
        tag: prompt.category,
        iterations: DEMO_ITERATIONS,
      })),
    );
    expect(prefill.perceptionPrompt).toContain(DEMO_BRAND.name);
  });
});
