import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Driver } from "./driver";
import { migrate } from "./migrate";
import { CATALOGUE, seedModels } from "./seed-models";
import type { ModelRow } from "./types";

let db: Driver;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});

afterEach(() => {
  db.close();
});

function models(): ModelRow[] {
  return db.prepare("SELECT * FROM models ORDER BY provider, model_id").all<ModelRow>();
}

describe("seedModels", () => {
  it("writes the nine live catalog rows, three per provider", () => {
    seedModels(db);
    const rows = models();

    expect(rows).toHaveLength(9);
    for (const provider of ["anthropic", "google", "openai"]) {
      expect(rows.filter((r) => r.provider === provider)).toHaveLength(3);
    }
  });

  it("uses the preview id that replaced the Google model that 404ed", () => {
    seedModels(db);
    const ids = models().map((r) => r.model_id);
    expect(ids).toContain("gemini-3.1-pro-preview");
    expect(ids).not.toContain("gemini-3.1-pro");
  });

  it("gives every provider exactly one extraction model, ranked cheapest first", () => {
    seedModels(db);
    const extractors = models().filter((r) => r.is_extraction_model === 1);

    expect(extractors).toHaveLength(3);
    expect(new Set(extractors.map((r) => r.provider)).size).toBe(3);
    expect(
      [...extractors]
        .sort((a, b) => (a.extraction_rank ?? 0) - (b.extraction_rank ?? 0))
        .map((r) => r.model_id),
    ).toEqual(["gpt-5.6-luna", "gemini-3.1-flash-lite", "claude-haiku-4-5"]);
  });

  it("ranks extractors in the same order their input price does", () => {
    seedModels(db);
    const extractors = models()
      .filter((r) => r.is_extraction_model === 1)
      .sort((a, b) => (a.extraction_rank ?? 0) - (b.extraction_rank ?? 0));
    const prices = extractors.map((r) => r.input_price_per_mtok);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("leaves extraction_rank null on a model that cannot extract", () => {
    seedModels(db);
    for (const row of models()) {
      if (row.is_extraction_model === 0) expect(row.extraction_rank).toBeNull();
    }
  });

  it("marks web search on exactly the six non-extraction models", () => {
    seedModels(db);
    const searchers = models().filter((r) => r.supports_web_search === 1);
    expect(searchers).toHaveLength(6);
    expect(searchers.every((r) => r.is_extraction_model === 0)).toBe(true);
  });

  it("re-seeds without duplicating rows and refreshes catalog facts", () => {
    seedModels(db);
    db.prepare("UPDATE models SET display_name = ? WHERE model_id = ?").run(
      "stale name",
      "claude-opus-5",
    );

    seedModels(db);

    expect(models()).toHaveLength(9);
    expect(models().find((r) => r.model_id === "claude-opus-5")?.display_name).toBe(
      "Claude Opus 5",
    );
  });

  it("does not switch a model the user turned off back on", () => {
    seedModels(db);
    db.prepare("UPDATE models SET is_active = 0 WHERE model_id = ?").run("gpt-5.6-sol");

    seedModels(db);

    expect(models().find((r) => r.model_id === "gpt-5.6-sol")?.is_active).toBe(0);
  });

  it("re-seeds a model whose uuid changed but whose provider and model_id did not", () => {
    // The table carries a second unique key on (provider, model_id) that the
    // upsert cannot name. On an existing database, a catalog that gives a model
    // a fresh uuid must not throw out of seedModels, and so out of getDb() on
    // every request.
    seedModels(db);
    const before = models().find((r) => r.model_id === "gpt-5.6-luna");

    const renamed = CATALOGUE.map((m) =>
      m.model_id === "gpt-5.6-luna" ? { ...m, id: "11111111-2222-3333-4444-555555555555" } : m,
    );
    expect(() => seedModels(db, renamed)).not.toThrow();

    const after = models().filter((r) => r.model_id === "gpt-5.6-luna");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
    expect(models()).toHaveLength(9);
  });

  it("keeps the catalog ids stable across boots", () => {
    seedModels(db);
    const first = models().map((r) => r.id);
    seedModels(db);
    expect(models().map((r) => r.id)).toEqual(first);
    expect(first.sort()).toEqual([...CATALOGUE.map((m) => m.id)].sort());
  });
});
