import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Driver } from "./driver";
import { appliedVersions, builtInMigrations, migrate, type Migration } from "./migrate";
import { seedModels } from "./seed-models";

// Every case opens its own in-memory database. Nothing here ever touches ./data.
const open: Driver[] = [];
function db(): Driver {
  const handle = openDatabase(":memory:");
  open.push(handle);
  return handle;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function tableNames(handle: Driver): string[] {
  return handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>()
    .map((row) => row.name);
}

/** The versions this build ships, in order. */
const SHIPPED = [
  "0001_initial",
  "0002_run_provenance_and_metric_deletes",
  "0003_app_state_and_demo_flag",
  "0004_prompt_archive",
  "0005_call_limit_setting",
  "0006_answer_summaries",
  "0007_prompt_summaries",
  "0008_project_extraction_prompt",
  "0009_run_task_failure_code",
  "0010_inflight_caps_setting",
  "0011_project_description",
];

describe("migrate", () => {
  it("applies the shipped migrations to a fresh database", () => {
    const handle = db();
    const applied = migrate(handle);

    expect(applied).toEqual(SHIPPED);
    expect(appliedVersions(handle)).toEqual(SHIPPED);
    expect(tableNames(handle)).toEqual([
      "_schema_migrations",
      "answer_summaries",
      "app_state",
      "brand_observations",
      "brands",
      "extractions",
      "models",
      "perception_summaries",
      "project_models",
      "projects",
      "prompt_summaries",
      "prompts",
      "run_metrics",
      "run_tasks",
      "runs",
      "schedules",
      "usage_events",
    ]);
  });

  it("is idempotent: a second call applies nothing", () => {
    const handle = db();
    migrate(handle);

    expect(migrate(handle)).toEqual([]);
    expect(appliedVersions(handle)).toEqual(SHIPPED);
  });

  it("applies only the migrations a v1 database has not seen", () => {
    // The incremental path, proved with a migration that exists only here, so
    // the shipped set is untouched.
    const handle = db();
    migrate(handle);

    const extra: Migration = {
      version: "9999_test_only_follow_up",
      sql: "ALTER TABLE projects ADD COLUMN test_only_note TEXT",
    };
    const applied = migrate(handle, [...builtInMigrations(), extra]);

    expect(applied).toEqual(["9999_test_only_follow_up"]);
    expect(appliedVersions(handle)).toEqual([...SHIPPED, "9999_test_only_follow_up"]);

    handle
      .prepare("INSERT INTO projects (id, name, test_only_note) VALUES (?, ?, ?)")
      .run("p1", "Acme Analytics", "hello");
    const row = handle
      .prepare("SELECT test_only_note FROM projects WHERE id = ?")
      .get<{ test_only_note: string }>("p1");
    expect(row?.test_only_note).toBe("hello");
  });

  it("reconciles orphan answers left by pre-cascade prompt deletes", () => {
    // A database at 0002, where deleting a prompt nulls its tasks' prompt_id
    // and the answers keep counting.
    const handle = db();
    migrate(handle, builtInMigrations().slice(0, 2));
    seedModels(handle);
    const model = handle
      .prepare("SELECT id FROM models WHERE provider = 'anthropic' LIMIT 1")
      .get<{ id: string }>()!.id;

    handle.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Acme Analytics')").run();
    handle
      .prepare(
        "INSERT INTO prompts (id, project_id, text, iterations) VALUES ('q1', 'p1', 'best analytics tools', 1)",
      )
      .run();
    handle
      .prepare(
        "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot, finalised_at) VALUES ('r1', 'p1', 'completed', 3, '{}', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    const task = (id: string, promptId: string | null, perception: 0 | 1) =>
      handle
        .prepare(
          "INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status, next_attempt_at, answer_text, is_perception) VALUES (?, 'r1', 'p1', ?, ?, 1, 'done', '2026-01-01T00:00:00.000Z', 'an answer', ?)",
        )
        .run(id, promptId, model, perception);
    task("t-orphan", null, 0); // what a prompt delete leaves at 0002
    task("t-kept", "q1", 0);
    task("t-perception", null, 1); // legitimately null-prompt
    handle
      .prepare(
        "INSERT INTO extractions (id, run_task_id, project_id, answer_format, raw_json, model_used) VALUES ('e1', 't-orphan', 'p1', 'prose', '{}', 'test')",
      )
      .run();
    handle
      .prepare(
        "INSERT INTO brand_observations (id, run_task_id, run_id, project_id, raw_name, mention_type) VALUES ('o1', 't-orphan', 'r1', 'p1', 'Acme Analytics', 'mentioned')",
      )
      .run();
    handle
      .prepare(
        "INSERT INTO usage_events (id, run_id, run_task_id, kind, provider, model_id, outcome) VALUES ('u1', 'r1', 't-orphan', 'answer', 'anthropic', 'x', 'done')",
      )
      .run();
    const metric = handle.prepare(
      "INSERT INTO run_metrics (id, run_id, project_id, model_id, prompt_id, brand_id, answers, mentions, ranked, citations, mention_rate, rank_rate, citation_rate) VALUES (?, 'r1', 'p1', ?, ?, NULL, 1, 1, 0, 0, 1, 0, 0)",
    );
    metric.run("m-agg", null, null); // level-1 aggregate for r1
    metric.run("m-orphan", model, null); // level-0 row with a null prompt

    expect(migrate(handle)).toEqual([
      "0003_app_state_and_demo_flag",
      "0004_prompt_archive",
      "0005_call_limit_setting",
      "0006_answer_summaries",
      "0007_prompt_summaries",
      "0008_project_extraction_prompt",
      "0009_run_task_failure_code",
      "0010_inflight_caps_setting",
      "0011_project_description",
    ]);

    const count = (sql: string) => handle.prepare(sql).get<{ c: number }>()!.c;
    expect(count("SELECT count(*) c FROM run_tasks WHERE id = 't-orphan'")).toBe(0);
    expect(count("SELECT count(*) c FROM extractions")).toBe(0);
    expect(count("SELECT count(*) c FROM brand_observations")).toBe(0);
    expect(count("SELECT count(*) c FROM usage_events")).toBe(0);
    // The kept and the perception task survive.
    expect(count("SELECT count(*) c FROM run_tasks WHERE id = 't-kept'")).toBe(1);
    expect(count("SELECT count(*) c FROM run_tasks WHERE id = 't-perception'")).toBe(1);
    // The scored run is handed to the recovery net: rows gone, stamp cleared.
    expect(count("SELECT count(*) c FROM run_metrics WHERE run_id = 'r1'")).toBe(0);
    const run = handle
      .prepare("SELECT finalised_at FROM runs WHERE id = 'r1'")
      .get<{ finalised_at: string | null }>();
    expect(run?.finalised_at).toBeNull();
    // The archived column is there, defaulting every prompt to visible.
    const prompt = handle
      .prepare("SELECT archived FROM prompts WHERE id = 'q1'")
      .get<{ archived: number }>();
    expect(prompt?.archived).toBe(0);
  });

  it("rebuilds the usage log for prompt results summaries without losing a row", () => {
    // A database as 0006 left it, with spend already logged: one answer and
    // one answer summary against a run, and one call that belongs to no run.
    const handle = db();
    migrate(handle, builtInMigrations().slice(0, 6));
    handle.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Acme Analytics')").run();
    handle
      .prepare(
        "INSERT INTO runs (id, project_id, planned_calls, config_snapshot) VALUES ('r1', 'p1', 2, '{}')",
      )
      .run();
    const usage = handle.prepare(
      "INSERT INTO usage_events (id, run_id, kind, provider, model_id, cost_usd, outcome) VALUES (?, ?, ?, 'example', 'assistant-alpha', ?, 'success')",
    );
    usage.run("u1", "r1", "answer", 0.002);
    usage.run("u2", "r1", "summary", 0.001);
    usage.run("u3", null, "extraction", 0.0005);

    // The incremental pass also applies everything after 0007. This test's
    // subject is the 0007 usage-log rebuild.
    expect(migrate(handle)).toEqual([
      "0007_prompt_summaries",
      "0008_project_extraction_prompt",
      "0009_run_task_failure_code",
      "0010_inflight_caps_setting",
      "0011_project_description",
    ]);

    const rows = () =>
      handle
        .prepare("SELECT id, run_id, kind, cost_usd FROM usage_events ORDER BY id")
        .all<{ id: string; run_id: string | null; kind: string; cost_usd: number }>();
    expect(rows()).toEqual([
      { id: "u1", run_id: "r1", kind: "answer", cost_usd: 0.002 },
      { id: "u2", run_id: "r1", kind: "summary", cost_usd: 0.001 },
      { id: "u3", run_id: null, kind: "extraction", cost_usd: 0.0005 },
    ]);

    // The new kind is admitted with no run attached; anything else is not.
    usage.run("u4", null, "prompt_summary", 0.004);
    expect(() => usage.run("u5", null, "not_a_kind", 0)).toThrow();

    // The rebuilt log still follows its run: deleting the run takes its rows
    // and leaves the run-less ones.
    handle.prepare("DELETE FROM runs WHERE id = 'r1'").run();
    expect(rows().map((row) => row.id)).toEqual(["u3", "u4"]);
  });

  it("gives an existing install null calls in flight, so it keeps the defaults", () => {
    const handle = db();
    migrate(handle, builtInMigrations().slice(0, 9));
    handle.prepare("UPDATE app_state SET max_planned_calls = 250 WHERE id = 1").run();

    expect(migrate(handle)).toEqual(["0010_inflight_caps_setting", "0011_project_description"]);

    const row = handle
      .prepare(
        "SELECT max_planned_calls, max_inflight_openai, max_inflight_anthropic, max_inflight_google FROM app_state WHERE id = 1",
      )
      .get<Record<string, number | null>>();
    expect(row).toEqual({
      max_planned_calls: 250,
      max_inflight_openai: null,
      max_inflight_anthropic: null,
      max_inflight_google: null,
    });
  });

  it("adds the capped brand description and a usage kind for generation, losing no row", () => {
    // A database as 0009 left it, with a project and spend of every kind logged.
    const handle = db();
    const upTo0009 = builtInMigrations().filter((m) => m.version < "0010");
    migrate(handle, upTo0009);
    handle.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Acme Analytics')").run();
    handle
      .prepare(
        "INSERT INTO runs (id, project_id, planned_calls, config_snapshot) VALUES ('r1', 'p1', 2, '{}')",
      )
      .run();
    const usage = handle.prepare(
      "INSERT INTO usage_events (id, run_id, kind, provider, model_id, cost_usd, outcome) VALUES (?, ?, ?, 'example', 'assistant-alpha', ?, 'success')",
    );
    usage.run("u1", "r1", "answer", 0.002);
    usage.run("u2", null, "prompt_summary", 0.004);
    // The kind is refused before the migration.
    expect(() => usage.run("u0", null, "prompt_generation", 0.001)).toThrow();

    expect(migrate(handle)).toEqual(["0010_inflight_caps_setting", "0011_project_description"]);

    const rows = handle
      .prepare("SELECT id, run_id, kind, cost_usd FROM usage_events ORDER BY id")
      .all<{ id: string; run_id: string | null; kind: string; cost_usd: number }>();
    expect(rows).toEqual([
      { id: "u1", run_id: "r1", kind: "answer", cost_usd: 0.002 },
      { id: "u2", run_id: null, kind: "prompt_summary", cost_usd: 0.004 },
    ]);
    // A generation belongs to no run, and its kind is admitted; anything else is not.
    usage.run("u3", null, "prompt_generation", 0.001);
    expect(() => usage.run("u4", null, "not_a_kind", 0)).toThrow();

    // The existing project reads no description, and the column holds its cap.
    const description = (id: string) =>
      handle
        .prepare("SELECT description FROM projects WHERE id = ?")
        .get<{ description: string | null }>(id)?.description;
    expect(description("p1")).toBeNull();
    const insert = handle.prepare("INSERT INTO projects (id, name, description) VALUES (?, ?, ?)");
    insert.run("p2", "Northwind Metrics", "x".repeat(280));
    expect(description("p2")).toHaveLength(280);
    expect(() => insert.run("p3", "Contoso Insights", "x".repeat(281))).toThrow();
  });

  it("records nothing when a migration throws", () => {
    const handle = db();
    const broken: Migration = { version: "0001_initial", sql: "THIS IS NOT SQL" };

    expect(() => migrate(handle, [broken])).toThrow();
    expect(appliedVersions(handle)).toEqual([]);
    expect(tableNames(handle)).toEqual(["_schema_migrations"]);
  });

  it("orders migrations by filename, not by object order", () => {
    const handle = db();
    const a: Migration = { version: "0001_initial", sql: builtInMigrations()[0]?.sql ?? "" };
    const b: Migration = {
      version: "0002_needs_projects",
      sql: "CREATE INDEX projects_name_idx ON projects (name)",
    };

    expect(
      migrate(
        handle,
        [b, a].sort((x, y) => (x.version < y.version ? -1 : 1)),
      ),
    ).toEqual(["0001_initial", "0002_needs_projects"]);
  });

  it("lets a migration rebuild a table without breaking its children", () => {
    // The table-rebuild procedure SQLite documents for changing a column or a
    // CHECK: build the replacement, copy, drop the original, rename. Dropping
    // the original with foreign keys enforced fires every child's ON DELETE
    // action, which here would null the prompt off every task in the database.
    // The runner turns enforcement off around the whole call, outside any
    // transaction, where the pragma takes effect.
    const handle = db();
    migrate(handle);

    const rebuild: Migration = {
      version: "9999_rebuild_prompts",
      sql: `
        CREATE TABLE prompts_new (
          id         TEXT PRIMARY KEY,
          project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          text       TEXT    NOT NULL,
          context    TEXT,
          category   TEXT,
          iterations INTEGER NOT NULL DEFAULT 5 CHECK (iterations BETWEEN 1 AND 200),
          is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ) STRICT;
        INSERT INTO prompts_new SELECT id, project_id, text, context, category, iterations,
                                       is_active, created_at, updated_at FROM prompts;
        DROP TABLE prompts;
        ALTER TABLE prompts_new RENAME TO prompts;`,
    };

    expect(migrate(handle, [...builtInMigrations(), rebuild])).toEqual(["9999_rebuild_prompts"]);

    const childSql = handle
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_tasks'")
      .get<{ sql: string }>();
    expect(childSql?.sql).toContain("REFERENCES prompts(id)");
    expect(childSql?.sql).not.toContain("prompts_new");
  });

  it("puts foreign key enforcement back on afterwards", () => {
    const handle = db();
    migrate(handle);
    const row = handle.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });
});
