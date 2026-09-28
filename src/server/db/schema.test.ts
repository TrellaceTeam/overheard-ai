import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Driver } from "./driver";
import { migrate } from "./migrate";
import { seedModels } from "./seed-models";
import { PERCEPTION_TEMPLATE } from "@/lib/perception";
import { EXTRACTION_SYSTEM } from "../worker/extraction";

// The invariants the schema itself is responsible for: ids are UUID text,
// timestamps are ISO-8601 UTC text, booleans are 0 or 1, string lists are JSON
// arrays, and every child row is removed or detached when its parent goes.
// The run arithmetic is tested in src/server/logic.
let db: Driver;

const HAIKU = "09fbf457-be35-4428-b72b-48bc04fcc01e";

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  seedModels(db);
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run("p1", "Acme Analytics");
  db.prepare(
    "INSERT INTO runs (id, project_id, planned_calls, config_snapshot) VALUES (?,?,?,?)",
  ).run("r1", "p1", 2, "{}");
});

afterEach(() => {
  db.close();
});

function insertTask(id: string, isPerception: 0 | 1, promptId: string | null): void {
  db.prepare(
    `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, is_perception)
     VALUES (?, ?, 'p1', ?, ?, 1, ?)`,
  ).run(id, "r1", promptId, HAIKU, isPerception);
}

function insertMetric(
  id: string,
  promptId: string | null,
  brandId: string | null,
  modelId: string | null = HAIKU,
): void {
  db.prepare(
    `INSERT INTO run_metrics
       (id, run_id, project_id, model_id, prompt_id, brand_id,
        answers, mentions, ranked, citations, mention_rate, rank_rate, citation_rate)
     VALUES (?, 'r1', 'p1', ?, ?, ?, 4, 2, 1, 0, 0.5, 0.25, 0)`,
  ).run(id, modelId, promptId, brandId);
}

describe("schema", () => {
  it("gives every project the canonical perception prompt, the one setup pre-fills", () => {
    const row = db
      .prepare("SELECT perception_prompt FROM projects WHERE id = ?")
      .get<{ perception_prompt: string }>("p1");
    // A checkout with CRLF line endings carries them into the migration SQL and
    // so into the column default. A template literal is LF whatever the checkout.
    expect(row?.perception_prompt.replace(/\r\n/g, "\n")).toBe(PERCEPTION_TEMPLATE);
  });

  it("gives every project the canonical extraction prompt, the one the worker falls back to", () => {
    const row = db
      .prepare("SELECT extraction_prompt FROM projects WHERE id = ?")
      .get<{ extraction_prompt: string }>("p1");
    // The same CRLF allowance the perception default needs: the migration SQL
    // carries the checkout's line endings, the TypeScript constant does not.
    expect(row?.extraction_prompt.replace(/\r\n/g, "\n")).toBe(EXTRACTION_SYSTEM);
  });

  it("touches updated_at when a project changes", () => {
    const before = db
      .prepare("SELECT updated_at FROM projects WHERE id = ?")
      .get<{ updated_at: string }>("p1")?.updated_at;
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(
      "1999-01-01T00:00:00.000Z",
      "p1",
    );
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run("Northwind Metrics", "p1");
    const after = db
      .prepare("SELECT updated_at FROM projects WHERE id = ?")
      .get<{ updated_at: string }>("p1")?.updated_at;
    expect(after).not.toBe("1999-01-01T00:00:00.000Z");
    expect(typeof before).toBe("string");
  });

  it("refuses a second brand with the same ASCII name in one project, whatever the case", () => {
    const insert = db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES (?, ?, ?, ?)",
    );
    insert.run("b1", "p1", "Acme Analytics", "target");
    expect(() => insert.run("b2", "p1", "acme analytics", "competitor")).toThrow();
  });

  it("does not fold a non-ASCII name, which is why the app matches names itself", () => {
    // SQLite's built-in lower() folds A-Z and nothing else, so the unique index
    // on (project_id, lower(name)) cannot see that these two are one company.
    // createCompetitor and the worker's discovery insert therefore match on a
    // JavaScript key before they insert, and that is where the guarantee
    // lives. Asserted because the ASCII case above reads as though the index
    // covers both.
    const insert = db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES (?, ?, ?, ?)",
    );
    insert.run("b1", "p1", "GR\u00dcNER ANALYTICS", "competitor");
    insert.run("b2", "p1", "gr\u00fcner analytics", "competitor");
    expect(db.prepare("SELECT COUNT(*) AS n FROM brands").get<{ n: number }>()?.n).toBe(2);
  });

  it("refuses a prompt longer than the combined text and context budget", () => {
    const insert = db.prepare(
      "INSERT INTO prompts (id, project_id, text, context) VALUES (?,?,?,?)",
    );
    expect(() => insert.run("q1", "p1", "x".repeat(2001), null)).toThrow();
    expect(() => insert.run("q2", "p1", "x".repeat(2000), "y".repeat(8001))).toThrow();
    insert.run("q3", "p1", "x".repeat(2000), "y".repeat(8000));
    expect(db.prepare("SELECT COUNT(*) AS n FROM prompts").get<{ n: number }>()?.n).toBe(1);
  });

  it("keeps a task's measurement history when its prompt is deleted", () => {
    db.prepare("INSERT INTO prompts (id, project_id, text) VALUES (?,?,?)").run(
      "q1",
      "p1",
      "What are the best analytics tools?",
    );
    insertTask("t1", 0, "q1");
    db.prepare("UPDATE run_tasks SET question_text = ? WHERE id = ?").run("as sent", "t1");

    db.prepare("DELETE FROM prompts WHERE id = ?").run("q1");

    const row = db
      .prepare("SELECT prompt_id, question_text FROM run_tasks WHERE id = ?")
      .get<{ prompt_id: string | null; question_text: string }>("t1");
    expect(row?.prompt_id).toBeNull();
    expect(row?.question_text).toBe("as sent");
  });

  it("deletes a prompt's own metric rows with it, and lets a second prompt go too", () => {
    // The per-prompt rows go, because a per-prompt figure means nothing once
    // the prompt is gone. The second delete has to succeed: nulling prompt_id
    // would collapse two level 0 rows onto the same scope index key and abort
    // with a raw UNIQUE constraint message.
    const insert = db.prepare("INSERT INTO prompts (id, project_id, text) VALUES (?,?,?)");
    insert.run("q1", "p1", "What are the best analytics tools?");
    insert.run("q2", "p1", "Which analytics tool is cheapest?");
    db.prepare("INSERT INTO brands (id, project_id, name, role) VALUES (?,?,?,?)").run(
      "b1",
      "p1",
      "Acme Analytics",
      "target",
    );
    insertMetric("m-q1", "q1", "b1");
    insertMetric("m-q2", "q2", "b1");
    insertMetric("m-run-wide", null, "b1", null);

    db.prepare("DELETE FROM prompts WHERE id = ?").run("q1");
    db.prepare("DELETE FROM prompts WHERE id = ?").run("q2");

    const ids = db
      .prepare("SELECT id FROM run_metrics ORDER BY id")
      .all<{ id: string }>()
      .map((row) => row.id);
    expect(ids).toEqual(["m-run-wide"]);
  });

  it("rejects an observation written against a perception task", () => {
    insertTask("t-perception", 1, null);
    expect(() =>
      db
        .prepare(
          `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, raw_name, mention_type)
           VALUES (?, ?, 'r1', 'p1', ?, 'mentioned')`,
        )
        .run("o1", "t-perception", "Northwind Metrics"),
    ).toThrow(/PERCEPTION_HAS_NO_OBSERVATIONS/);
  });

  it("accepts an observation against a measured task", () => {
    insertTask("t-measured", 0, null);
    db.prepare(
      `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, raw_name, mention_type)
       VALUES (?, ?, 'r1', 'p1', ?, 'ranked')`,
    ).run("o2", "t-measured", "Northwind Metrics");
    expect(db.prepare("SELECT COUNT(*) AS n FROM brand_observations").get<{ n: number }>()?.n).toBe(
      1,
    );
  });

  it("keeps an observation whose brand is deleted, with a null brand_id", () => {
    db.prepare("INSERT INTO brands (id, project_id, name, role) VALUES (?,?,?,?)").run(
      "b1",
      "p1",
      "Globex Search",
      "competitor",
    );
    insertTask("t2", 0, null);
    db.prepare(
      `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, brand_id, raw_name, mention_type)
       VALUES (?, ?, 'r1', 'p1', ?, ?, 'mentioned')`,
    ).run("o3", "t2", "b1", "Globex Search");

    insertMetric("m-b1", null, "b1", HAIKU);

    db.prepare("DELETE FROM brands WHERE id = ?").run("b1");

    const row = db
      .prepare("SELECT brand_id, raw_name FROM brand_observations WHERE id = ?")
      .get<{ brand_id: string | null; raw_name: string }>("o3");
    expect(row?.brand_id).toBeNull();
    expect(row?.raw_name).toBe("Globex Search");

    // The metric row goes the same way as the observation beside it. Deleting
    // it would take the whole scope out of the answer count, and every other
    // brand's rates would rise when a rival is deleted.
    const metric = db
      .prepare("SELECT brand_id, answers FROM run_metrics WHERE id = ?")
      .get<{ brand_id: string | null; answers: number }>("m-b1");
    expect(metric?.brand_id).toBeNull();
    expect(metric?.answers).toBe(4);
  });

  it("holds the two run_metrics scope levels apart and refuses a duplicate scope", () => {
    const insert = db.prepare(
      `INSERT INTO run_metrics
         (id, run_id, project_id, model_id, prompt_id, brand_id,
          answers, mentions, ranked, citations, mention_rate, rank_rate, citation_rate)
       VALUES (?, 'r1', 'p1', ?, ?, ?, 4, 2, 1, 0, 0.5, 0.25, 0)`,
    );
    insert.run("m-scoped", HAIKU, null, null);
    insert.run("m-aggregate", null, null, null);
    expect(() => insert.run("m-dupe", null, null, null)).toThrow();
  });

  it("allows one perception summary per assistant plus one merged row", () => {
    const insert = db.prepare(
      "INSERT INTO perception_summaries (id, project_id, model_id) VALUES (?, 'p1', ?)",
    );
    insert.run("ps-model", HAIKU);
    insert.run("ps-merged", null);
    expect(() => insert.run("ps-dupe", null)).toThrow();
    expect(() => insert.run("ps-dupe-model", HAIKU)).toThrow();
  });

  it("allows at most one schedule per project", () => {
    const insert = db.prepare(
      "INSERT INTO schedules (id, project_id, cadence, hour_utc, next_run_at) VALUES (?,?,?,?,?)",
    );
    insert.run("s1", "p1", "weekly", 9, "2026-10-01T09:00:00.000Z");
    expect(() => insert.run("s2", "p1", "daily", 9, "2026-10-01T09:00:00.000Z")).toThrow();
  });

  it("caps day_of_month at 28 so a monthly schedule exists in every month", () => {
    const insert = db.prepare(
      `INSERT INTO schedules (id, project_id, cadence, day_of_month, hour_utc, next_run_at)
       VALUES (?, 'p1', 'monthly', ?, 9, '2026-10-01T09:00:00.000Z')`,
    );
    expect(() => insert.run("s3", 29)).toThrow();
    insert.run("s4", 28);
  });

  it("refuses a task status outside the schema's set", () => {
    insertTask("t3", 0, null);
    expect(() =>
      db.prepare("UPDATE run_tasks SET status = ? WHERE id = ?").run("blocked", "t3"),
    ).toThrow();
    db.prepare("UPDATE run_tasks SET status = ? WHERE id = ?").run("extracting", "t3");
  });

  it("allows every run status including partial and cancelled", () => {
    const set = db.prepare("UPDATE runs SET status = ? WHERE id = 'r1'");
    for (const status of ["queued", "running", "completed", "partial", "failed", "cancelled"]) {
      set.run(status);
    }
    expect(() => set.run("blocked")).toThrow();
  });

  it("cascades a project delete through every child table", () => {
    insertTask("t4", 0, null);
    db.prepare(
      `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, raw_name, mention_type)
       VALUES ('o4', 't4', 'r1', 'p1', 'Fabrikam Labs', 'mentioned')`,
    ).run();

    db.prepare("INSERT INTO prompts (id, project_id, text) VALUES ('q4','p1','A question?')").run();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b4','p1','Acme Analytics','target')",
    ).run();
    db.prepare("INSERT INTO project_models (project_id, model_id) VALUES ('p1', ?)").run(HAIKU);
    db.prepare(
      `INSERT INTO extractions (id, run_task_id, project_id, answer_format, raw_json, model_used)
       VALUES ('e4', 't4', 'p1', 'prose', '{}', 'test/test')`,
    ).run();
    insertMetric("m4", "q4", "b4");
    db.prepare(
      "INSERT INTO perception_summaries (id, project_id, model_id) VALUES ('ps4','p1',?)",
    ).run(HAIKU);
    db.prepare(
      `INSERT INTO usage_events (id, run_id, run_task_id, kind, provider, model_id, outcome)
       VALUES ('u4', 'r1', 't4', 'answer', 'anthropic', 'claude-test', 'success')`,
    ).run();
    db.prepare(
      `INSERT INTO schedules (id, project_id, cadence, hour_utc, next_run_at)
       VALUES ('sc4', 'p1', 'weekly', 9, '2026-10-01T09:00:00.000Z')`,
    ).run();

    db.prepare("DELETE FROM projects WHERE id = ?").run("p1");

    for (const table of [
      "runs",
      "run_tasks",
      "brand_observations",
      "brands",
      "prompts",
      "project_models",
      "extractions",
      "run_metrics",
      "perception_summaries",
      "usage_events",
      "schedules",
    ]) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()?.n;
      expect(n).toBe(0);
    }
  });

  it("is STRICT: a string cannot be stored in an integer column", () => {
    expect(() =>
      db.prepare("UPDATE runs SET planned_calls = ? WHERE id = 'r1'").run("lots"),
    ).toThrow();
  });

  it("defaults the run call limit to 1,000 and holds its bounds", () => {
    const row = db
      .prepare("SELECT max_planned_calls FROM app_state WHERE id = 1")
      .get<{ max_planned_calls: number }>();
    expect(row?.max_planned_calls).toBe(1000);

    db.prepare("UPDATE app_state SET max_planned_calls = 1 WHERE id = 1").run();
    db.prepare("UPDATE app_state SET max_planned_calls = 10000000 WHERE id = 1").run();
    expect(() =>
      db.prepare("UPDATE app_state SET max_planned_calls = 0 WHERE id = 1").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE app_state SET max_planned_calls = 10000001 WHERE id = 1").run(),
    ).toThrow();
  });

  it("leaves each provider's calls in flight null for the default and holds their bounds", () => {
    for (const column of ["max_inflight_openai", "max_inflight_anthropic", "max_inflight_google"]) {
      const row = db
        .prepare(`SELECT ${column} AS cap FROM app_state WHERE id = 1`)
        .get<{ cap: number | null }>();
      expect(row?.cap, column).toBeNull();

      const set = db.prepare(`UPDATE app_state SET ${column} = ? WHERE id = 1`);
      set.run(1);
      set.run(15);
      set.run(null);
      expect(() => set.run(0), column).toThrow();
      expect(() => set.run(16), column).toThrow();
    }
  });
});
