import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, seedProject, SONNET } from "../../logic/test-support";
import { aggregateBrand } from "@/lib/metrics";
import { listProjectMetrics, projectMetricWindow } from "./metrics";
import { listBrands, updateBrand } from "./brands";
import { promptAnswerCounts } from "./prompts";

let db: Driver;

afterEach(() => {
  db.close();
});

interface MetricSeed {
  id: string;
  runId: string;
  modelId: string | null;
  promptId: string | null;
  brandId: string | null;
  answers: number;
  mentions: number;
  createdAt: string;
}

function insertMetric(db: Driver, seed: MetricSeed): void {
  db.prepare(
    `INSERT INTO run_metrics
       (id, run_id, project_id, model_id, prompt_id, brand_id, answers, mentions, ranked,
        citations, mention_rate, rank_rate, citation_rate, avg_rank, best_rank,
        top_pick_share, top3_rate, created_at)
     VALUES (?, ?, 'p1', ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 1.5, 1, 0, 0, ?)`,
  ).run(
    seed.id,
    seed.runId,
    seed.modelId,
    seed.promptId,
    seed.brandId,
    seed.answers,
    seed.mentions,
    seed.mentions,
    seed.answers > 0 ? seed.mentions / seed.answers : 0,
    seed.createdAt,
  );
}

function open(): Driver {
  db = freshDb();
  seedProject(db, { models: [HAIKU, SONNET] });
  db.prepare(
    "INSERT INTO brands (id, project_id, name, role) VALUES ('rival', 'p1', 'Northwind Metrics', 'competitor')",
  ).run();

  for (const [runId, created] of [
    ["r1", "2026-01-01T00:00:00.000Z"],
    ["r2", "2026-02-01T00:00:00.000Z"],
  ] as const) {
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, created_at)
       VALUES (?, 'p1', 'completed', 4, '{}', ?)`,
    ).run(runId, created);
  }

  // Level 0 rows: one per (model, prompt, brand). Plus one run-wide row per run,
  // which every read here must leave out.
  insertMetric(db, {
    id: "m1",
    runId: "r1",
    modelId: HAIKU,
    promptId: "q1",
    brandId: "p1-brand",
    answers: 4,
    mentions: 2,
    createdAt: "2026-01-01T01:00:00.000Z",
  });
  insertMetric(db, {
    id: "m2",
    runId: "r1",
    modelId: HAIKU,
    promptId: "q1",
    brandId: "rival",
    answers: 4,
    mentions: 4,
    createdAt: "2026-01-01T01:00:00.000Z",
  });
  insertMetric(db, {
    id: "m3",
    runId: "r1",
    modelId: null,
    promptId: null,
    brandId: "p1-brand",
    answers: 4,
    mentions: 2,
    createdAt: "2026-01-01T01:00:00.000Z",
  });
  insertMetric(db, {
    id: "m4",
    runId: "r2",
    modelId: SONNET,
    promptId: "q1",
    brandId: "p1-brand",
    answers: 4,
    mentions: 4,
    createdAt: "2026-02-01T01:00:00.000Z",
  });
  return db;
}

describe("the metric window", () => {
  it("keeps the newest runs when there are more rows than one read carries", () => {
    // A plain row limit on the ascending query would keep the oldest rows, and
    // the dashboard would show stale numbers while the Runs list kept growing.
    const db = open();
    const insertBrand = db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES (?, 'p1', ?, 'discovered')",
    );
    for (let brand = 0; brand < 200; brand += 1) insertBrand.run(`b${brand}`, `Brand ${brand}`);

    let created = 0;
    for (let run = 0; run < 40; run += 1) {
      created += 1;
      const runId = `big${run}`;
      const at = `2026-03-${String(created).padStart(2, "0")}T00:00:00.000Z`;
      db.prepare(
        `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, created_at)
         VALUES (?, 'p1', 'completed', 4, '{}', ?)`,
      ).run(runId, at);
      for (let row = 0; row < 200; row += 1) {
        insertMetric(db, {
          id: `${runId}-${row}`,
          runId,
          modelId: HAIKU,
          promptId: "q1",
          brandId: `b${row}`,
          answers: 4,
          mentions: 2,
          createdAt: at,
        });
      }
    }

    const window = projectMetricWindow(db, "p1");

    expect(window.capped).toBe(true);
    // Whole runs only: never a run with some of its brands loaded and some not.
    const perRun = new Map<string, number>();
    for (const row of window.rows) perRun.set(row.run_id, (perRun.get(row.run_id) ?? 0) + 1);
    for (const [runId, count] of perRun) {
      if (runId.startsWith("big")) expect(count).toBe(200);
    }
    // And the newest run is in it.
    expect(perRun.has("big39")).toBe(true);
    expect(perRun.has("big0")).toBe(false);
  });

  it("leaves mock runs out once the project has a measured run", () => {
    // Mock answers rank the target first every time, so they store a 100 percent
    // mention rate. Averaged into measured figures, nothing on screen tells them
    // apart.
    const db = open();
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, created_at, mock)
       VALUES ('rmock', 'p1', 'completed', 4, '{}', '2026-03-01T00:00:00.000Z', 1)`,
    ).run();
    insertMetric(db, {
      id: "mm1",
      runId: "rmock",
      modelId: HAIKU,
      promptId: "q1",
      brandId: "p1-brand",
      answers: 4,
      mentions: 4,
      createdAt: "2026-03-01T01:00:00.000Z",
    });

    const window = projectMetricWindow(db, "p1");
    expect(window.mockExcluded).toBe(true);
    expect(window.rows.map((row) => row.run_id)).not.toContain("rmock");

    // Unless they are asked for, which is what a screen showing the demo does.
    expect(
      projectMetricWindow(db, "p1", { includeMock: true }).rows.map((row) => row.run_id),
    ).toContain("rmock");
  });

  it("shows mock runs when they are all the project has, which is the demo", () => {
    db = freshDb();
    seedProject(db);
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, created_at, mock)
       VALUES ('rmock', 'p1', 'completed', 4, '{}', '2026-03-01T00:00:00.000Z', 1)`,
    ).run();
    insertMetric(db, {
      id: "mm1",
      runId: "rmock",
      modelId: HAIKU,
      promptId: "q1",
      brandId: "p1-brand",
      answers: 4,
      mentions: 4,
      createdAt: "2026-03-01T01:00:00.000Z",
    });

    const window = projectMetricWindow(db, "p1");
    expect(window.mockExcluded).toBe(false);
    expect(window.rows).toHaveLength(1);
  });
});

describe("listProjectMetrics", () => {
  it("serves level 0 rows only, oldest first", () => {
    const db = open();
    const rows = listProjectMetrics(db, "p1");
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "m4"]);
  });

  it("filters by run, assistant and brand", () => {
    const db = open();
    expect(listProjectMetrics(db, "p1", { runIds: ["r2"] }).map((r) => r.id)).toEqual(["m4"]);
    expect(listProjectMetrics(db, "p1", { modelIds: [HAIKU] }).map((r) => r.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(listProjectMetrics(db, "p1", { brandIds: ["rival"] }).map((r) => r.id)).toEqual(["m2"]);
  });

  it("reads an empty selection as none rather than as everything", () => {
    const db = open();
    expect(listProjectMetrics(db, "p1", { modelIds: [] })).toEqual([]);
  });
});

describe("self-referenced prompts", () => {
  function withSelfReferencedPrompt(): Driver {
    const db = open();
    db.prepare(
      `INSERT INTO prompts (id, project_id, text, iterations, is_active)
       VALUES ('q-self', 'p1', 'is Acme Analytics a good choice for a startup', 1, 1),
              ('q-nick', 'p1', 'how does AcmeA compare for dashboards', 1, 1)`,
    ).run();
    for (const [id, promptId, brandId] of [
      ["s1", "q-self", "p1-brand"],
      ["s2", "q-self", "rival"],
      ["s3", "q-nick", "p1-brand"],
      ["s4", "q-nick", "rival"],
    ] as const) {
      insertMetric(db, {
        id,
        runId: "r1",
        modelId: HAIKU,
        promptId,
        brandId,
        answers: 4,
        mentions: 4,
        createdAt: "2026-01-01T01:00:00.000Z",
      });
    }
    return db;
  }

  it("never counts them, for the own brand or for competitors", () => {
    const db = withSelfReferencedPrompt();

    const ids = listProjectMetrics(db, "p1").map((row) => row.id);
    expect(ids).toEqual(["m1", "m2", "s3", "s4", "m4"]);

    const window = projectMetricWindow(db, "p1");
    expect(window.rows.map((row) => row.id)).not.toContain("s2");
  });

  it("keeps them out of every figure the screens aggregate", () => {
    const db = withSelfReferencedPrompt();
    db.prepare("DELETE FROM run_metrics WHERE id IN ('s3', 's4')").run();

    // Same figures as with no self-referenced prompt at all.
    const rows = listProjectMetrics(db, "p1");
    expect(aggregateBrand(rows, "p1-brand")).toMatchObject({ answers: 8, mention_rate: 0.75 });
    expect(aggregateBrand(rows, "rival").mention_rate).toBeCloseTo(0.5, 4);
    expect(
      aggregateBrand(
        rows.filter((row) => row.run_id === "r1"),
        "p1-brand",
      ).answers,
    ).toBe(4);
  });

  it("follows the own brand's current variants, so editing one reclassifies past runs", () => {
    const db = withSelfReferencedPrompt();
    expect(listProjectMetrics(db, "p1").map((row) => row.id)).toContain("s3");

    updateBrand(db, { id: "p1-brand", variants: ["AcmeA"] });

    const ids = listProjectMetrics(db, "p1").map((row) => row.id);
    expect(ids).not.toContain("s3");
    expect(ids).not.toContain("s4");
  });

  it("is decided by the own brand only, not by a competitor named in a prompt", () => {
    const db = open();
    db.prepare(
      `INSERT INTO prompts (id, project_id, text, iterations, is_active)
       VALUES ('q-rival', 'p1', 'is Northwind Metrics worth it', 1, 1)`,
    ).run();
    insertMetric(db, {
      id: "c1",
      runId: "r1",
      modelId: HAIKU,
      promptId: "q-rival",
      brandId: "rival",
      answers: 4,
      mentions: 4,
      createdAt: "2026-01-01T01:00:00.000Z",
    });

    expect(listProjectMetrics(db, "p1").map((row) => row.id)).toContain("c1");
  });

  it("keeps discovered brands and answer counts untouched", () => {
    const db = withSelfReferencedPrompt();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('found', 'p1', 'Contoso Insights', 'discovered')",
    ).run();
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status)
       VALUES ('t-self', 'r1', 'p1', 'q-self', ?, 1, 'done')`,
    ).run(HAIKU);

    expect(listBrands(db, "p1").map((brand) => brand.name)).toContain("Contoso Insights");
    expect(promptAnswerCounts(db, "p1")["q-self"]).toBe(1);
  });
});
