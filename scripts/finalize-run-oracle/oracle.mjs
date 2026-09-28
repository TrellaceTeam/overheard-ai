// Generates the finalize-run fixtures from the reference PL/pgSQL.
//
// Loads the reference finalize_run and its helpers (sql/functions.sql)
// into an embedded Postgres (PGlite), feeds it small synthetic datasets with obviously
// fictional brands, runs finalize_run, and writes each case to the app's fixture folder as
//   { name, description, input: {...rows}, expected: {...rows} }.
//
// The expected block is whatever real Postgres produced, and the app's SQLite and
// TypeScript finalizeRun is tested against it. No customer data is involved anywhere.
//
// Run:  npm install && npm run oracle   (from scripts/finalize-run-oracle)

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
// Written straight into the app tree, so a regenerated fixture shows up as a
// diff in the test suite that consumes it rather than in a folder nobody reads.
const FIXTURES = resolve(
  HERE,
  "..",
  "..",
  "src",
  "server",
  "logic",
  "__fixtures__",
  "finalize-run",
);
const OUT = resolve(ROOT, "out");

// ---------------------------------------------------------------- ids

// Readable, stable uuids so fixtures diff cleanly.
const u = (tag, n) => `${tag.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ID = {
  project: u("a", 1),
  modelAlpha: u("b", 1),
  modelBeta: u("b", 2),
  promptTools: u("c", 1),
  promptSearch: u("c", 2),
  // Fictional brands. Never a real customer or competitor.
  acme: u("d", 1), // Acme Analytics    - the target brand, mentioned often
  northwind: u("d", 2), // Northwind Metrics - mentioned sometimes
  contoso: u("d", 3), // Contoso Insights  - never mentioned
  fabrikam: u("d", 4), // Fabrikam Labs     - never mentioned
  globex: u("d", 5), // Globex Search     - rarely mentioned
};

const BRAND_NAMES = {
  [ID.acme]: "Acme Analytics",
  [ID.northwind]: "Northwind Metrics",
  [ID.contoso]: "Contoso Insights",
  [ID.fabrikam]: "Fabrikam Labs",
  [ID.globex]: "Globex Search",
};

// ---------------------------------------------------------------- base rows

const PROJECTS = [{ id: ID.project, name: "Overheard AI Demo Project" }];

// Placeholder assistants. The app's real catalog is seeded by src/server/db/seed-models.ts.
const MODELS = [
  {
    id: ID.modelAlpha,
    provider: "example",
    model_key: "assistant-alpha",
    label: "Assistant Alpha",
    tier: "frontier",
  },
  {
    id: ID.modelBeta,
    provider: "example",
    model_key: "assistant-beta",
    label: "Assistant Beta",
    tier: "mid",
  },
];

const PROMPTS = [
  {
    id: ID.promptTools,
    project_id: ID.project,
    text: "best analytics tools for a small team",
    category: "discovery",
    iterations: 3,
  },
  {
    id: ID.promptSearch,
    project_id: ID.project,
    text: "top search platforms",
    category: "discovery",
    iterations: 2,
  },
];

const BRANDS = [
  { id: ID.acme, project_id: ID.project, name: "Acme Analytics", role: "target" },
  { id: ID.northwind, project_id: ID.project, name: "Northwind Metrics", role: "competitor" },
  { id: ID.contoso, project_id: ID.project, name: "Contoso Insights", role: "competitor" },
  { id: ID.fabrikam, project_id: ID.project, name: "Fabrikam Labs", role: "competitor" },
  { id: ID.globex, project_id: ID.project, name: "Globex Search", role: "discovered" },
];

// ---------------------------------------------------------------- builders

let taskSeq = 0;
let obsSeq = 0;

// task(runId, overrides) -> a run_tasks row with sane defaults.
// status defaults to done because finalize_run only measures done tasks.
function task(runId, o = {}) {
  taskSeq += 1;
  const isPerception = o.is_perception === true;
  const dead = o.status === "failed" || o.status === "blocked";
  return {
    id: u("f", taskSeq),
    run_id: runId,
    project_id: ID.project,
    prompt_id: isPerception ? null : (o.prompt_id ?? ID.promptTools),
    model_id: o.model_id ?? ID.modelAlpha,
    iteration: o.iteration ?? 1,
    question_text: isPerception
      ? "What do you know about Acme Analytics?"
      : (o.question_text ?? "best analytics tools for a small team"),
    is_perception: isPerception,
    status: o.status ?? "done",
    attempts: o.attempts ?? 1,
    answer_text: dead ? null : (o.answer_text ?? "synthetic answer text"),
    error: o.status === "failed" ? "synthetic provider error" : null,
  };
}

// obs(taskRow, brandId, overrides) -> a brand_observations row.
// brandId null models an unresolved raw name, which finalize_run must drop.
function obs(t, brandId, o = {}) {
  obsSeq += 1;
  return {
    id: u("1", obsSeq),
    run_task_id: t.id,
    run_id: t.run_id,
    project_id: ID.project,
    brand_id: brandId,
    raw_name: o.raw_name ?? (brandId ? BRAND_NAMES[brandId] : "some tool nobody resolved"),
    position: o.position === undefined ? null : o.position,
    total_items: o.total_items ?? null,
    mention_type: o.mention_type ?? (o.position ? "ranked" : "mentioned"),
    linked_url: o.is_cited ? "https://example.invalid/review" : null,
    is_cited: o.is_cited ?? false,
    evidence: o.evidence ?? null,
  };
}

// planned_calls is 2 per measured task. Perception tasks are not in the run counters.
function run(id, tasks, o = {}) {
  const measured = tasks.filter((t) => !t.is_perception).length;
  return {
    id,
    project_id: ID.project,
    trigger: o.trigger ?? "manual",
    status: o.status ?? "running",
    planned_calls: o.planned_calls ?? measured * 2,
    completed_calls: 0,
    failed_calls: 0,
    config_snapshot: JSON.stringify({ note: "synthetic fixture" }),
  };
}

// ---------------------------------------------------------------- db plumbing

const TABLES = [
  "run_metrics",
  "brand_observations",
  "extractions",
  "run_tasks",
  "runs",
  "brands",
  "prompts",
  "models",
  "projects",
];

async function reset(db) {
  await db.exec(`truncate ${TABLES.join(", ")} restart identity cascade;`);
  taskSeq = 0;
  obsSeq = 0;
}

async function insertAll(db, table, rows) {
  if (!rows || rows.length === 0) return;
  const c = Object.keys(rows[0]);
  const ph = c.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `insert into ${table} (${c.join(", ")}) values (${ph})`;
  for (const r of rows) {
    await db.query(
      sql,
      c.map((k) => r[k]),
    );
  }
}

async function load(db, input) {
  await reset(db);
  await insertAll(db, "projects", input.projects);
  await insertAll(db, "models", input.models);
  await insertAll(db, "prompts", input.prompts);
  await insertAll(db, "brands", input.brands);
  await insertAll(db, "runs", input.runs);
  await insertAll(db, "run_tasks", input.run_tasks);
  await insertAll(db, "brand_observations", input.brand_observations);
}

// Non deterministic columns (id, created_at, timestamps) are dropped so fixtures are stable.
const METRIC_COLS = [
  "model_id",
  "prompt_id",
  "brand_id",
  "answers",
  "mentions",
  "ranked",
  "citations",
  "mention_rate",
  "rank_rate",
  "citation_rate",
  "link_when_mentioned",
  "avg_rank",
  "best_rank",
  "worst_rank",
  "rank_stddev",
  "share_of_voice",
  "top_pick_share",
  "top3_rate",
];

async function dumpMetrics(db) {
  const res = await db.query(`
    select ${METRIC_COLS.map((c) => `m.${c}`).join(", ")}
      from run_metrics m
     order by (m.model_id is null), m.model_id,
              (m.prompt_id is null), m.prompt_id,
              m.brand_id
  `);
  return res.rows.map((r) => {
    const out = {};
    out.scope =
      r.model_id === null && r.prompt_id === null ? "run (lvl 1)" : "model+prompt (lvl 0)";
    out.model_label = MODELS.find((m) => m.id === r.model_id)?.model_key ?? "(all assistants)";
    out.prompt_label = PROMPTS.find((p) => p.id === r.prompt_id)?.text ?? "(all prompts)";
    out.brand_name = BRAND_NAMES[r.brand_id] ?? null;
    for (const k of METRIC_COLS) out[k] = r[k];
    return out;
  });
}

async function dumpRun(db, runId) {
  const res = await db.query(
    `select status, planned_calls, completed_calls, failed_calls,
            started_at is not null as started_at_set,
            finished_at is not null as finished_at_set
       from runs where id = $1`,
    [runId],
  );
  return res.rows[0];
}

// ---------------------------------------------------------------- cases

const cases = [];
const defineCase = (c) => cases.push(c);

// 1. counting-rule -------------------------------------------------
defineCase({
  name: "counting-rule",
  description:
    "One answer contributes at most one mention per brand however many times the brand is named. " +
    "Acme Analytics is named three times in the first answer and still counts once. " +
    "pos is the minimum position over the group, is_cited and is_top are maxima. " +
    "An observation with a null brand_id is an unresolved raw name and is dropped entirely.",
  build() {
    const runId = u("e", 1);
    const t1 = task(runId, { iteration: 1 });
    const t2 = task(runId, { iteration: 2 });
    const t3 = task(runId, { iteration: 3 });
    const tasks = [t1, t2, t3];
    return {
      runId,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [
        // Acme named three separate times in one answer. One mention, pos = min(1,2,null) = 1.
        obs(t1, ID.acme, { position: 1, raw_name: "Acme Analytics", is_cited: true }),
        obs(t1, ID.acme, { position: 2, raw_name: "Acme" }),
        obs(t1, ID.acme, { position: null, raw_name: "acme analytics" }),
        obs(t1, ID.northwind, { position: 2 }),
        obs(t2, ID.acme, { position: 3 }),
        obs(t2, ID.northwind, { position: 1 }),
        obs(t3, ID.northwind, { position: 2 }),
        obs(t3, null, { position: 4 }),
      ],
    };
  },
});

// 2. absent-brand --------------------------------------------------
defineCase({
  name: "absent-brand",
  description:
    "A brand that appears in no answer gets no run_metrics row at all. It must never surface as " +
    "a rate of 1 through an empty denominator, and the interface has to supply the zero itself. " +
    "Northwind Metrics, Contoso Insights, Fabrikam Labs and Globex Search exist as brands and " +
    "are absent from every answer in this run.",
  build() {
    const runId = u("e", 2);
    const t1 = task(runId, { iteration: 1 });
    const t2 = task(runId, { iteration: 2 });
    const tasks = [t1, t2];
    return {
      runId,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [obs(t1, ID.acme, { position: 1 }), obs(t2, ID.acme, { position: 2 })],
      extra: {
        brand_ids_expected_to_have_no_rows: [ID.northwind, ID.contoso, ID.fabrikam, ID.globex],
      },
    };
  },
});

// 3. mixed-failure -------------------------------------------------
defineCase({
  name: "mixed-failure",
  description:
    "Denominators count done tasks only. A failed task and a blocked task are excluded from " +
    "answers but each adds 2 to failed_calls, and the run lands on partial. " +
    "completed_calls plus failed_calls equals planned_calls exactly.",
  build() {
    const runId = u("e", 3);
    const t1 = task(runId, { iteration: 1 });
    const t2 = task(runId, { iteration: 2 });
    const t3 = task(runId, { iteration: 3 });
    const t4 = task(runId, { iteration: 4, status: "failed" });
    const t5 = task(runId, { iteration: 5, status: "blocked" });
    const tasks = [t1, t2, t3, t4, t5];
    return {
      runId,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [
        obs(t1, ID.acme, { position: 1, is_cited: true }),
        obs(t2, ID.acme, { position: 2 }),
        obs(t2, ID.northwind, { position: 1 }),
        obs(t3, ID.northwind, { position: 3, is_cited: true }),
      ],
    };
  },
});

// 4. perception-excluded -------------------------------------------
defineCase({
  name: "perception-excluded",
  description:
    "A done perception task is excluded from the tasks CTE, so answers stays 2 rather than 3. " +
    "It is also excluded from done, mid, failed and blocked in update_run_progress, but not from " +
    "pending, so a run whose perception task is still extracting stays running and finalize_run " +
    "stays reachable. Inserting an observation against a perception task raises.",
  build() {
    const runId = u("e", 4);
    const t1 = task(runId, { iteration: 1 });
    const t2 = task(runId, { iteration: 2 });
    const tp = task(runId, { iteration: 1, is_perception: true });
    const tasks = [t1, t2, tp];
    return {
      runId,
      perceptionTaskId: tp.id,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [
        obs(t1, ID.acme, { position: 1 }),
        obs(t2, ID.acme, { position: 1 }),
        obs(t2, ID.northwind, { position: 2 }),
      ],
    };
  },
  async after(db, built, expected) {
    // An observation against a perception task must raise.
    let raised = null;
    try {
      const row = obs({ id: built.perceptionTaskId, run_id: built.runId }, ID.acme, {
        position: 1,
      });
      await insertAll(db, "brand_observations", [row]);
    } catch (e) {
      raised = String(e.message).split("\n")[0];
    }
    expected.perception_observation_insert_raises = raised !== null;
    expected.perception_observation_error_prefix = raised ? raised.slice(0, 34) : null;

    // A non terminal perception task must hold the run open at running.
    await db.query("update run_tasks set status = 'extracting' where id = $1", [
      built.perceptionTaskId,
    ]);
    await db.query("select finalize_run($1)", [built.runId]);
    expected.while_perception_still_extracting = {
      run: await dumpRun(db, built.runId),
      run_metrics_row_count: (await dumpMetrics(db)).length,
    };

    // Put it back so the headline expected block stays the documented one.
    await db.query("update run_tasks set status = 'done' where id = $1", [built.perceptionTaskId]);
    await db.query("select finalize_run($1)", [built.runId]);
  },
});

// 5. top3-rate -----------------------------------------------------
defineCase({
  name: "top3-rate",
  description:
    "top3_rate is top3 over answers. A brand named fourth and second in the same answer is in the " +
    "top three, because pos is already the minimum. A mention with a null position stays in the " +
    "denominator through answers but is excluded from the numerator of rank_rate, top_pick_share " +
    "and top3_rate, and from avg_rank, best_rank, worst_rank and rank_stddev.",
  build() {
    const runId = u("e", 5);
    const t1 = task(runId, { iteration: 1 });
    const t2 = task(runId, { iteration: 2 });
    const t3 = task(runId, { iteration: 3 });
    const t4 = task(runId, { iteration: 4 });
    const tasks = [t1, t2, t3, t4];
    return {
      runId,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [
        obs(t1, ID.acme, { position: 4 }), // named twice in one answer,
        obs(t1, ID.acme, { position: 2 }), // min position 2, so it is in the top three
        obs(t2, ID.acme, { position: 3 }),
        obs(t3, ID.acme, { position: 5 }),
        obs(t4, ID.acme, { position: null, mention_type: "mentioned" }), // mentioned, unranked
      ],
    };
  },
});

// 6. repeat-finalize-idempotent ------------------------------------
defineCase({
  name: "repeat-finalize-idempotent",
  description:
    "The kitchen sink dataset: two assistants, two prompts, done and failed and blocked tasks, " +
    "a perception task, citations, top positions and an unresolved observation. finalize_run is " +
    "called twice and must produce identical run_metrics. Idempotency comes only from the delete " +
    "immediately before the insert, so the delete and the insert must share one transaction.",
  keepFirstFinalize: true,
  build() {
    const runId = u("e", 6);
    const a1 = task(runId, { iteration: 1, model_id: ID.modelAlpha, prompt_id: ID.promptTools });
    const a2 = task(runId, { iteration: 2, model_id: ID.modelAlpha, prompt_id: ID.promptTools });
    const a3 = task(runId, { iteration: 1, model_id: ID.modelAlpha, prompt_id: ID.promptSearch });
    const b1 = task(runId, { iteration: 1, model_id: ID.modelBeta, prompt_id: ID.promptTools });
    const b2 = task(runId, {
      iteration: 2,
      model_id: ID.modelBeta,
      prompt_id: ID.promptTools,
      status: "failed",
    });
    const b3 = task(runId, {
      iteration: 1,
      model_id: ID.modelBeta,
      prompt_id: ID.promptSearch,
      status: "blocked",
    });
    const p1 = task(runId, { iteration: 1, model_id: ID.modelAlpha, is_perception: true });
    const tasks = [a1, a2, a3, b1, b2, b3, p1];
    return {
      runId,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [
        obs(a1, ID.acme, { position: 1, is_cited: true }),
        obs(a1, ID.acme, { position: 3 }),
        obs(a1, ID.northwind, { position: 2 }),
        obs(a2, ID.acme, { position: 2, is_cited: true }),
        obs(a2, ID.globex, { position: 1 }),
        obs(a3, ID.northwind, { position: 1 }),
        obs(a3, ID.acme, { position: null, mention_type: "mentioned" }),
        obs(b1, ID.acme, { position: 2 }),
        obs(b1, ID.northwind, { position: 1, is_cited: true }),
        obs(b1, null, { position: 3 }),
      ],
    };
  },
});

// 7. two-models-with-merged-scope ----------------------------------
defineCase({
  name: "two-models-with-merged-scope",
  description:
    "Two assistants on one prompt. finalize_run writes a lvl 0 row per (model_id, prompt_id) and a " +
    "lvl 1 row with both null, which is the across everything scope. The lvl 1 rates are not the " +
    "average of the lvl 0 rates, and share_of_voice is computed inside each scope separately. " +
    "There is no per assistant only level and no per prompt only level.",
  build() {
    const runId = u("e", 7);
    const a1 = task(runId, { iteration: 1, model_id: ID.modelAlpha, prompt_id: ID.promptTools });
    const a2 = task(runId, { iteration: 2, model_id: ID.modelAlpha, prompt_id: ID.promptTools });
    const b1 = task(runId, { iteration: 1, model_id: ID.modelBeta, prompt_id: ID.promptTools });
    const b2 = task(runId, { iteration: 2, model_id: ID.modelBeta, prompt_id: ID.promptTools });
    const tasks = [a1, a2, b1, b2];
    return {
      runId,
      runs: [run(runId, tasks)],
      run_tasks: tasks,
      brand_observations: [
        obs(a1, ID.acme, { position: 1, is_cited: true }),
        obs(a2, ID.acme, { position: 1 }),
        obs(b1, ID.acme, { position: 3 }),
        obs(b2, ID.northwind, { position: 1 }),
      ],
    };
  },
});

// ---------------------------------------------------------------- driver

function inputBlock(built) {
  return {
    projects: PROJECTS,
    models: MODELS,
    prompts: PROMPTS,
    brands: BRANDS,
    runs: built.runs,
    run_tasks: built.run_tasks,
    brand_observations: built.brand_observations,
  };
}

async function main() {
  mkdirSync(FIXTURES, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const db = await PGlite.create();
  await db.exec(readFileSync(resolve(ROOT, "sql/schema.sql"), "utf8"));
  await db.exec(readFileSync(resolve(ROOT, "sql/functions.sql"), "utf8"));

  const pgVersion = (await db.query("select version() as v")).rows[0].v;
  console.log(`node ${process.version}`);
  console.log(pgVersion);
  console.log("");

  const written = [];
  const summary = { engine: pgVersion, node: process.version, cases: [] };

  for (const c of cases) {
    const built = c.build();
    const input = inputBlock(built);
    await load(db, input);

    await db.query("select finalize_run($1)", [built.runId]);
    const firstMetrics = await dumpMetrics(db);
    const firstRun = await dumpRun(db, built.runId);

    // Every case is finalised twice, because the worker can finalise a run more than once.
    await db.query("select finalize_run($1)", [built.runId]);
    const secondMetrics = await dumpMetrics(db);
    const secondRun = await dumpRun(db, built.runId);

    const identical = JSON.stringify(firstMetrics) === JSON.stringify(secondMetrics);
    if (!identical) throw new Error(`finalize_run was not idempotent for case ${c.name}`);

    const expected = {
      run: secondRun,
      run_metrics_row_count: secondMetrics.length,
      second_finalize_identical: identical,
      run_metrics: secondMetrics,
    };
    if (c.keepFirstFinalize) {
      expected.first_finalize_run = firstRun;
      expected.first_finalize_run_metrics = firstMetrics;
    }
    if (built.extra) Object.assign(expected, built.extra);
    if (c.after) await c.after(db, built, expected);

    const fixture = {
      name: c.name,
      description: c.description,
      source: "scripts/finalize-run-oracle/sql/functions.sql, run in PGlite",
      input,
      expected,
    };
    const path = resolve(FIXTURES, `${c.name}.json`);
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    written.push(path);

    console.log(
      `${c.name}: ${secondMetrics.length} run_metrics rows, run ${secondRun.status}, ` +
        `completed ${secondRun.completed_calls} failed ${secondRun.failed_calls} ` +
        `of ${secondRun.planned_calls} planned, idempotent ${identical}`,
    );
    summary.cases.push({
      name: c.name,
      rows: secondMetrics.length,
      run: secondRun,
      idempotent: identical,
    });
  }

  writeFileSync(resolve(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await db.close();
  console.log("");
  console.log(`wrote ${written.length} fixtures to ${FIXTURES}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
