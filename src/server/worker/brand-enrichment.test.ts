import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Driver } from "../db/driver";
import { migrate } from "../db/migrate";
import { CATALOGUE, seedModels } from "../db/seed-models";
import { autoTrackTopCompetitor, enrichNewBrands } from "./brand-enrichment";
import { countPerceptionTasks, listPerAssistantSummaries, targetBrandName } from "./queries";
import { writePerceptionSummary } from "../logic/perception-summary";
import { summarisePerception } from "./perception-extract";

// An in-memory database through the driver, migrated and seeded. Nothing under
// ./data is touched.

const catalogueId = (modelId: string) => CATALOGUE.find((m) => m.model_id === modelId)!.id;
const SONNET = catalogueId("claude-sonnet-5");
const LUNA = catalogueId("gpt-6-luna");

let db: Driver;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedModels(db);
  db.exec(`
    INSERT INTO projects (id, name, web_search_enabled, perception_prompt)
    VALUES ('project-1', 'Acme', 1, 'What do you know about {brand}?');
  `);
});

afterEach(() => {
  db.close();
});

function brand(id: string, name: string, role: string, patch: Record<string, string> = {}) {
  db.prepare(
    `INSERT INTO brands (id, project_id, name, role, variants, domains, suggested_domains)
     VALUES (?, 'project-1', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    role,
    patch["variants"] ?? "[]",
    patch["domains"] ?? "[]",
    patch["suggested_domains"] ?? "[]",
  );
}

function run(id: string, status = "completed") {
  db.prepare(
    `INSERT INTO runs (id, project_id, trigger, status, planned_calls, config_snapshot)
     VALUES (?, 'project-1', 'manual', ?, 2, '{}')`,
  ).run(id, status);
}

function runTask(id: string, runId: string, opts: { perception?: boolean } = {}) {
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration,
                            question_text, is_perception, status, answer_text)
     VALUES (?, ?, 'project-1', NULL, ?, 1, 'q', ?, 'done', 'an answer')`,
  ).run(id, runId, opts.perception ? SONNET : LUNA, opts.perception ? 1 : 0);
}

function observation(
  id: string,
  runId: string,
  taskId: string,
  brandId: string,
  raw: string,
  url: string | null,
) {
  db.prepare(
    `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, brand_id, raw_name,
                                     mention_type, linked_url, is_cited)
     VALUES (?, ?, ?, 'project-1', ?, ?, 'mentioned', ?, 0)`,
  ).run(id, taskId, runId, brandId, raw, url);
}

function metric(
  id: string,
  runId: string,
  brandId: string,
  mentions: number,
  avgRank: number | null,
) {
  db.prepare(
    `INSERT INTO run_metrics (id, run_id, project_id, model_id, prompt_id, brand_id,
                              answers, mentions, ranked, citations, mention_rate, rank_rate,
                              citation_rate, avg_rank)
     VALUES (?, ?, 'project-1', NULL, NULL, ?, 10, ?, 0, 0, 0, 0, 0, ?)`,
  ).run(id, runId, brandId, mentions, avgRank);
}

describe("enrichNewBrands", () => {
  it("seeds variants and domains for a brand making its first appearance", () => {
    brand("brand-north", "Northwind Metrics", "competitor");
    run("run-1");
    runTask("task-1", "run-1");
    observation(
      "obs-1",
      "run-1",
      "task-1",
      "brand-north",
      "Northwind",
      "https://northwind.example.com/a",
    );
    observation("obs-2", "run-1", "task-1", "brand-north", "Northwind Metrics", null);

    enrichNewBrands(db, "run-1", "project-1");

    const row = db
      .prepare("SELECT variants, domains FROM brands WHERE id = 'brand-north'")
      .get<{ variants: string; domains: string }>();
    // "Northwind Metrics" normalises to the canonical name, so only the short
    // form is a variant worth storing.
    expect(JSON.parse(row!.variants)).toEqual(["Northwind"]);
    expect(JSON.parse(row!.domains)).toEqual(["northwind.example.com"]);
  });

  it("never touches a brand that was already seen in an earlier run", () => {
    brand("brand-north", "Northwind Metrics", "competitor");
    run("run-0");
    run("run-1");
    runTask("task-0", "run-0");
    runTask("task-1", "run-1");
    observation("obs-0", "run-0", "task-0", "brand-north", "Northwind", null);
    observation("obs-1", "run-1", "task-1", "brand-north", "NW Metrics", "https://nw.example.com");

    enrichNewBrands(db, "run-1", "project-1");

    const row = db
      .prepare("SELECT variants, domains FROM brands WHERE id = 'brand-north'")
      .get<{ variants: string; domains: string }>();
    expect(JSON.parse(row!.variants)).toEqual([]);
    expect(JSON.parse(row!.domains)).toEqual([]);
  });

  it("suggests rather than applies a domain for the user's own brand", () => {
    brand("brand-acme", "Acme Analytics", "target");
    run("run-1");
    runTask("task-1", "run-1");
    observation("obs-1", "run-1", "task-1", "brand-acme", "Acme", "https://acme.example.com/x");

    enrichNewBrands(db, "run-1", "project-1");

    const row = db
      .prepare("SELECT domains, suggested_domains FROM brands WHERE id = 'brand-acme'")
      .get<{ domains: string; suggested_domains: string }>();
    expect(JSON.parse(row!.domains)).toEqual([]);
    expect(JSON.parse(row!.suggested_domains)).toEqual(["acme.example.com"]);
  });

  it("leaves a manually edited list alone", () => {
    brand("brand-north", "Northwind Metrics", "competitor", {
      variants: '["NW"]',
      domains: '["chosen.example.com"]',
    });
    run("run-1");
    runTask("task-1", "run-1");
    observation(
      "obs-1",
      "run-1",
      "task-1",
      "brand-north",
      "Northwind",
      "https://other.example.com",
    );

    enrichNewBrands(db, "run-1", "project-1");

    const row = db
      .prepare("SELECT variants, domains FROM brands WHERE id = 'brand-north'")
      .get<{ variants: string; domains: string }>();
    expect(JSON.parse(row!.variants)).toEqual(["NW"]);
    expect(JSON.parse(row!.domains)).toEqual(["chosen.example.com"]);
  });
});

describe("autoTrackTopCompetitor", () => {
  function firstRunWithTwoDiscovered() {
    brand("brand-north", "Northwind Metrics", "discovered");
    brand("brand-contoso", "Contoso Insights", "discovered");
    run("run-1");
    runTask("task-1", "run-1");
    metric("m-1", "run-1", "brand-north", 7, 1.5);
    metric("m-2", "run-1", "brand-contoso", 3, 1.1);
  }

  function roleOf(id: string): string {
    return db.prepare("SELECT role FROM brands WHERE id = ?").get<{ role: string }>(id)!.role;
  }

  it("promotes the most mentioned discovered brand on the first measured run", () => {
    firstRunWithTwoDiscovered();
    autoTrackTopCompetitor(db, "run-1", "project-1");
    expect(roleOf("brand-north")).toBe("competitor");
    expect(roleOf("brand-contoso")).toBe("discovered");
  });

  it("does nothing on a second pass over the same run", () => {
    firstRunWithTwoDiscovered();
    autoTrackTopCompetitor(db, "run-1", "project-1");
    autoTrackTopCompetitor(db, "run-1", "project-1");
    const tracked = db
      .prepare("SELECT COUNT(*) AS n FROM brands WHERE role = 'competitor'")
      .get<{ n: number }>();
    expect(tracked!.n).toBe(1);
  });

  it("does nothing when a competitor is already tracked", () => {
    firstRunWithTwoDiscovered();
    brand("brand-chosen", "Globex Search", "competitor");
    autoTrackTopCompetitor(db, "run-1", "project-1");
    expect(roleOf("brand-north")).toBe("discovered");
  });

  it("does nothing once the project has an earlier completed measured run", () => {
    firstRunWithTwoDiscovered();
    run("run-0");
    runTask("task-0", "run-0");
    autoTrackTopCompetitor(db, "run-1", "project-1");
    expect(roleOf("brand-north")).toBe("discovered");
  });

  it("ignores a brand this run did not measure, so the choice is never alphabetical", () => {
    brand("brand-north", "Northwind Metrics", "discovered");
    brand("brand-aaa", "Aardvark Data", "discovered");
    run("run-1");
    runTask("task-1", "run-1");
    metric("m-1", "run-1", "brand-north", 2, null);

    autoTrackTopCompetitor(db, "run-1", "project-1");

    expect(roleOf("brand-north")).toBe("competitor");
    expect(roleOf("brand-aaa")).toBe("discovered");
  });

  it("does nothing for a perception-only run, which measures nothing", () => {
    brand("brand-north", "Northwind Metrics", "discovered");
    run("run-p");
    runTask("task-p", "run-p", { perception: true });
    autoTrackTopCompetitor(db, "run-p", "project-1");
    expect(roleOf("brand-north")).toBe("discovered");
  });
});

describe("writePerceptionSummary", () => {
  const FIELDS = {
    knows_brand: true,
    what_it_does: "Tracks assistant answers.",
    typical_customers: "Small teams.",
    well_regarded_for: "Local storage.",
    downsides: "Thin docs.",
    run_id: null,
    question_text: "What do you know about Acme Analytics?",
    source_answers: 1,
  };

  it("replaces the per-assistant row rather than adding a second one", () => {
    writePerceptionSummary(db, "project-1", SONNET, FIELDS);
    writePerceptionSummary(db, "project-1", SONNET, { ...FIELDS, downsides: "Replaced." });
    const rows = listPerAssistantSummaries(db, "project-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.downsides).toBe("Replaced.");
  });

  it("replaces the merged row, which needs IS NULL rather than = NULL", () => {
    // `model_id = ?` with a null parameter matches nothing in SQLite, which
    // would leave the old aggregate in place beside the new one and trip the
    // unique index on (project_id, coalesce(model_id, '')).
    writePerceptionSummary(db, "project-1", null, FIELDS);
    writePerceptionSummary(db, "project-1", null, { ...FIELDS, source_answers: 3 });
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(source_answers) AS s FROM perception_summaries WHERE model_id IS NULL",
      )
      .get<{ n: number; s: number }>();
    expect(row).toEqual({ n: 1, s: 3 });
  });

  it("keeps the per-assistant rows and the merged row apart", () => {
    writePerceptionSummary(db, "project-1", SONNET, FIELDS);
    writePerceptionSummary(db, "project-1", null, FIELDS);
    expect(listPerAssistantSummaries(db, "project-1")).toHaveLength(1);
  });
});

describe("summarisePerception", () => {
  const FIELDS = {
    knows_brand: true,
    what_it_does: "Tracks assistant answers.",
    typical_customers: "Small teams.",
    well_regarded_for: "Local storage.",
    downsides: "Thin docs.",
    run_id: "run-p",
    question_text: "What do you know about Acme Analytics?",
    source_answers: 1,
  };

  const noCall = { call: null, recordUsage: () => {} };

  it("does nothing for a run with no perception task", async () => {
    run("run-1");
    runTask("task-1", "run-1");
    expect(countPerceptionTasks(db, "run-1")).toBe(0);
    await summarisePerception(db, "run-1", "project-1", noCall);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM perception_summaries").get<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("writes a single assistant's own summary straight through, with no model call", async () => {
    run("run-p");
    runTask("task-p", "run-p", { perception: true });
    writePerceptionSummary(db, "project-1", SONNET, FIELDS);

    await summarisePerception(db, "run-p", "project-1", noCall);

    const merged = db
      .prepare("SELECT * FROM perception_summaries WHERE model_id IS NULL")
      .get<{ what_it_does: string; source_answers: number; run_id: string }>();
    expect(merged?.what_it_does).toBe("Tracks assistant answers.");
    expect(merged?.source_answers).toBe(1);
    expect(merged?.run_id).toBe("run-p");
  });

  it("merges several assistants and decides knows_brand in code, not by the model", async () => {
    run("run-p");
    runTask("task-p", "run-p", { perception: true });
    writePerceptionSummary(db, "project-1", SONNET, FIELDS);
    writePerceptionSummary(db, "project-1", LUNA, {
      ...FIELDS,
      knows_brand: false,
      what_it_does: "",
      typical_customers: "",
      well_regarded_for: "",
      downsides: "",
    });

    let sawPrompt = "";
    await summarisePerception(db, "run-p", "project-1", {
      call: async (_system, user) => {
        sawPrompt = user;
        return {
          // The model claims it knows nothing. The count says otherwise, and the
          // count wins.
          text: JSON.stringify({ knows_brand: false, what_it_does: "Merged." }),
          inputTokens: 1,
          outputTokens: 1,
          tokens: 2,
          searchCalls: 0,
        };
      },
      recordUsage: () => {},
    });

    // Only the assistant that recognised the brand is fed to the merge.
    expect(sawPrompt).toContain("Claude Sonnet 5");
    expect(sawPrompt).not.toContain("GPT-6 Luna");
    const merged = db
      .prepare(
        "SELECT knows_brand, what_it_does, source_answers FROM perception_summaries WHERE model_id IS NULL",
      )
      .get<{ knows_brand: number; what_it_does: string; source_answers: number }>();
    // One merged answer, beside the one assistant counted as not recognising
    // the brand: the two numbers the band shows add up to the two asked.
    expect(merged).toEqual({ knows_brand: 1, what_it_does: "Merged.", source_answers: 1 });
  });

  it("leaves the per-assistant rows standing when the merge call fails", async () => {
    run("run-p");
    runTask("task-p", "run-p", { perception: true });
    writePerceptionSummary(db, "project-1", SONNET, FIELDS);
    writePerceptionSummary(db, "project-1", LUNA, FIELDS);

    await summarisePerception(db, "run-p", "project-1", {
      call: async () => {
        throw new Error("HTTP 500: upstream");
      },
      recordUsage: () => {},
    });

    expect(listPerAssistantSummaries(db, "project-1")).toHaveLength(2);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM perception_summaries WHERE model_id IS NULL").get<{
        n: number;
      }>(),
    ).toEqual({ n: 0 });
  });
});

describe("targetBrandName", () => {
  it("is the first active target brand", () => {
    brand("brand-acme", "Acme Analytics", "target");
    expect(targetBrandName(db, "project-1")).toBe("Acme Analytics");
  });

  it("falls back to a neutral phrase rather than an empty question", () => {
    expect(targetBrandName(db, "project-1")).toBe("the brand");
  });
});
