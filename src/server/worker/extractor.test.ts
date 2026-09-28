import { afterEach, describe, expect, it } from "vitest";
import { freshDb, HAIKU, seedProject, setProviderKeys } from "../logic/test-support";
import { resolveExtractionModel } from "./extractor";
import type { Driver } from "../db/driver";

// The database-backed form of the shared rule. The catalog the fresh
// database seeds carries three current extraction models: gpt-6-luna (openai,
// rank 1), gemini-3.5-flash-lite (google, rank 2), claude-haiku-4-5
// (anthropic, rank 3), then the superseded ones. The seeded project prefers
// the haiku.

let restoreKeys: (() => void) | undefined;

function setKeys(...names: string[]) {
  restoreKeys?.();
  restoreKeys = setProviderKeys(...names);
}

afterEach(() => {
  restoreKeys?.();
  restoreKeys = undefined;
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

function open(): Driver {
  const db = freshDb();
  seedProject(db, { models: [HAIKU] });
  return db;
}

describe("resolveExtractionModel", () => {
  it("takes the project's preferred extractor when its provider has a key", () => {
    setKeys("ANTHROPIC_API_KEY");
    const db = open();
    expect(resolveExtractionModel(db, "p1")?.id).toBe(HAIKU);
    db.close();
  });

  it("falls to the cheapest keyed candidate when the preferred provider has no key", () => {
    setKeys("OPENAI_API_KEY");
    const db = open();
    // Picking the haiku here would fail every call on a missing credential.
    expect(resolveExtractionModel(db, "p1")?.model_id).toBe("gpt-6-luna");
    db.close();
  });

  it("is null when no provider has a key", () => {
    setKeys();
    const db = open();
    expect(resolveExtractionModel(db, "p1")).toBeNull();
    db.close();
  });

  it("resolves without a project by the cheapest keyed candidate", () => {
    setKeys("GOOGLE_API_KEY", "ANTHROPIC_API_KEY");
    const db = open();
    expect(resolveExtractionModel(db, null)?.model_id).toBe("gemini-3.5-flash-lite");
    db.close();
  });
});
