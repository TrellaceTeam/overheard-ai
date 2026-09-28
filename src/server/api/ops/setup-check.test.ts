import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb } from "../../logic/test-support";
import type { SearchCheckResult } from "@/lib/setup-check";
import { checkProviders, checkSelection, type SetupProbe } from "./setup-check";

// Fixture brands are fictional. Keep them that way: no real company, domain or
// customer name in test data.

let db: Driver;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

function ok(message = "checked"): SearchCheckResult {
  return { status: "ok", message };
}

function fail(status: SearchCheckResult["status"], message: string): SearchCheckResult {
  return { status, message };
}

describe("checkProviders", () => {
  it("probes the representative search-capable model of each provider named", async () => {
    const seen: Array<[string, string]> = [];
    const probe: SetupProbe = async (_kind, provider, modelId) => {
      seen.push([provider, modelId]);
      return ok();
    };

    const report = await checkProviders(["openai", "google"], probe);

    expect(seen).toEqual([
      ["openai", "gpt-5.6-terra"],
      ["google", "gemini-3.6-flash"],
    ]);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every((row) => row.kind === "assistant")).toBe(true);
    expect(typeof report.checkedAt).toBe("string");
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  });

  it("passes one failure through without touching the other rows", async () => {
    const probe: SetupProbe = async (_kind, provider) =>
      provider === "openai" ? fail("no_credits", "no credit left") : ok();

    const report = await checkProviders(["openai", "anthropic"], probe);

    expect(report.rows[0]?.result.status).toBe("no_credits");
    expect(report.rows[1]?.result.status).toBe("ok");
  });
});

describe("checkSelection", () => {
  const GPT_LUNA = "e473c6ad-df52-4ee6-bf96-f7913077f8d1";
  const SONNET = "8e4393f7-aaaf-415f-b52c-fec4b4166501";

  it("probes the named assistants plus the extractor createProject would auto-pick", async () => {
    const seen: Array<[string, string]> = [];
    const report = await checkSelection(
      db,
      { assistantModelIds: [SONNET], providersWithKeys: ["openai"] },
      async (kind, _provider, modelId) => {
        seen.push([kind, modelId]);
        return ok();
      },
    );

    expect(seen).toEqual([
      ["assistant", "claude-sonnet-5"],
      ["extractor", "gpt-5.6-luna"],
    ]);
    expect(report.rows.map((row) => row.kind)).toEqual(["assistant", "extractor"]);
  });

  it("honours an explicitly named extractor and an explicit null", async () => {
    const named = await checkSelection(
      db,
      { assistantModelIds: [SONNET], extractorModelId: GPT_LUNA },
      async () => ok(),
    );
    expect(named.rows.map((row) => row.kind)).toEqual(["assistant", "extractor"]);
    expect(named.rows[1]?.modelId).toBe("gpt-5.6-luna");

    const none = await checkSelection(
      db,
      { assistantModelIds: [SONNET], extractorModelId: null },
      async () => ok(),
    );
    expect(none.rows.map((row) => row.kind)).toEqual(["assistant"]);
  });

  it("refuses an empty selection and an unknown model", async () => {
    await expect(checkSelection(db, { assistantModelIds: [] }, async () => ok())).rejects.toThrow(
      /NO_MODELS/,
    );
    await expect(
      checkSelection(db, { assistantModelIds: ["not-a-model"] }, async () => ok()),
    ).rejects.toThrow(/MODEL_NOT_FOUND/);
  });
});
