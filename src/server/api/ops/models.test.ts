import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, seedProject, SONNET } from "../../logic/test-support";
import { listExtractionModels, listModels, listProjectModels, setProjectModel } from "./models";

const GPT_LUNA = "e473c6ad-df52-4ee6-bf96-f7913077f8d1";
const GEMINI_FLASH_LITE = "695e8bbd-b115-4c03-84b0-f91e20890a13";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  seedProject(db, { models: [SONNET] });
  return db;
}

describe("listModels", () => {
  it("offers the assistants a project can monitor and leaves the extractors out", () => {
    const db = open();
    const models = listModels(db);
    expect(models.every((model) => model.is_extraction_model === 0)).toBe(true);
    expect(models.every((model) => model.is_active === 1)).toBe(true);
    expect(models.map((model) => model.id)).toContain(SONNET);
    expect(models.map((model) => model.id)).not.toContain(HAIKU);
  });
});

describe("listExtractionModels", () => {
  it("orders them cheapest first, by extraction rank", () => {
    const db = open();
    expect(listExtractionModels(db).map((model) => model.id)).toEqual([
      GPT_LUNA,
      GEMINI_FLASH_LITE,
      HAIKU,
    ]);
  });

  it("sorts an unranked extractor last rather than first", () => {
    const db = open();
    db.prepare("UPDATE models SET extraction_rank = NULL WHERE id = ?").run(GPT_LUNA);
    expect(listExtractionModels(db).map((model) => model.id)).toEqual([
      GEMINI_FLASH_LITE,
      HAIKU,
      GPT_LUNA,
    ]);
  });
});

describe("setProjectModel", () => {
  it("adds and removes one assistant at a time", () => {
    const db = open();
    expect(listProjectModels(db, "p1").map((model) => model.modelId)).toEqual([SONNET]);

    setProjectModel(db, { projectId: "p1", modelId: HAIKU, on: true });
    expect(listProjectModels(db, "p1").map((model) => model.modelId)).toContain(HAIKU);

    setProjectModel(db, { projectId: "p1", modelId: HAIKU, on: false });
    expect(listProjectModels(db, "p1").map((model) => model.modelId)).toEqual([SONNET]);
  });

  it("is idempotent in both directions", () => {
    const db = open();
    setProjectModel(db, { projectId: "p1", modelId: SONNET, on: true });
    setProjectModel(db, { projectId: "p1", modelId: HAIKU, on: false });
    expect(listProjectModels(db, "p1")).toHaveLength(1);
  });

  it("refuses a model that is not in the catalog", () => {
    const db = open();
    expect(() => setProjectModel(db, { projectId: "p1", modelId: "nope", on: true })).toThrow(
      /MODEL_NOT_FOUND/,
    );
  });

  it("resolves the provider and display name for the settings grid", () => {
    const db = open();
    expect(listProjectModels(db, "p1")[0]).toEqual({
      modelId: SONNET,
      provider: "anthropic",
      displayName: "Claude Sonnet 5",
    });
  });
});
