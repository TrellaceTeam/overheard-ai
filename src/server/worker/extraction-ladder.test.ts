/**
 * The extraction ladder: the readers one stored answer climbs through when a
 * model replies in the wrong shape.
 *
 * The order tests run against a real seeded database, because the ladder
 * depends on the catalog and the keys in the environment. The walk tests
 * inject the call: no network, no keys, no spend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../db/driver";
import type { ModelRow } from "../db/types";
import { freshDb, setProviderKeys } from "../logic/test-support";
import type { Extraction } from "./extraction";
import {
  extractionLadder,
  LADDER_MAX_RUNGS,
  nextTierUp,
  UNREADABLE_PREFIX,
  walkExtractionLadder,
} from "./extraction-ladder";
import { ProviderError, type ProviderResult } from "./providers";

/** Catalogue ids, named so an expected order reads as models, not uuids. */
const LUNA = "gpt-5.6-luna"; // openai, extraction, rank 1
const TERRA = "gpt-5.6-terra"; // openai, mid
const SOL = "gpt-5.6-sol"; // openai, frontier
const HAIKU = "claude-haiku-4-5"; // anthropic, extraction, rank 3
const SONNET = "claude-sonnet-5"; // anthropic, mid
const OPUS = "claude-opus-5"; // anthropic, frontier
const FLASH_LITE = "gemini-3.1-flash-lite"; // google, extraction, rank 2
const GEMINI_FLASH = "gemini-3.6-flash"; // google, mid

let db: Driver;
let restoreKeys: () => void = () => {};

function modelOf(modelId: string): ModelRow {
  const row = db.prepare("SELECT * FROM models WHERE model_id = ?").get<ModelRow>(modelId);
  if (!row) throw new Error(`no catalog model ${modelId}`);
  return row;
}

function ids(rungs: readonly ModelRow[]): string[] {
  return rungs.map((rung) => rung.model_id);
}

beforeEach(() => {
  db = freshDb();
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

afterEach(() => {
  restoreKeys();
  restoreKeys = () => {};
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  db.close();
});

describe("nextTierUp", () => {
  it("climbs extraction to mid, mid to frontier, and stops at the top", () => {
    restoreKeys = setProviderKeys("OPENAI_API_KEY");
    expect(nextTierUp(modelOf(LUNA), [modelOf(LUNA), modelOf(TERRA), modelOf(SOL)])?.model_id).toBe(
      TERRA,
    );
    expect(
      nextTierUp(modelOf(TERRA), [modelOf(LUNA), modelOf(TERRA), modelOf(SOL)])?.model_id,
    ).toBe(SOL);
    expect(nextTierUp(modelOf(SOL), [modelOf(LUNA), modelOf(TERRA), modelOf(SOL)])).toBeNull();
  });

  it("never climbs sideways into another provider's catalog", () => {
    expect(nextTierUp(modelOf(LUNA), [modelOf(LUNA), modelOf(SONNET), modelOf(OPUS)])).toBeNull();
  });

  it("skips a model the user switched off: disabled means do not pay for it", () => {
    db.prepare("UPDATE models SET is_active = 0 WHERE model_id = ?").run(SONNET);
    const active = db.prepare("SELECT * FROM models WHERE is_active = 1").all<ModelRow>();
    expect(nextTierUp(modelOf(HAIKU), active)?.model_id).toBe(OPUS);
  });

  it("picks the cheapest model of the next tier when a provider has several", () => {
    // Google's mid model costs the same as its frontier one, so the tier order
    // decides before the price does.
    expect(
      nextTierUp(modelOf(FLASH_LITE), [
        modelOf(FLASH_LITE),
        modelOf(GEMINI_FLASH),
        modelOf("gemini-3.1-pro-preview"),
      ])?.model_id,
    ).toBe(GEMINI_FLASH);
  });
});

describe("extractionLadder", () => {
  it("is empty without a resolved extractor", () => {
    expect(extractionLadder(db, null)).toEqual([]);
  });

  it("runs extractor, same provider next tier, cheapest keyed extractor", () => {
    restoreKeys = setProviderKeys("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY");
    expect(ids(extractionLadder(db, modelOf(HAIKU)))).toEqual([HAIKU, SONNET, LUNA]);
  });

  it("drops a rung that repeats a reader already tried", () => {
    // Luna is the cheapest keyed extractor, so the third rung adds nothing and
    // the ladder is shorter.
    restoreKeys = setProviderKeys("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY");
    expect(ids(extractionLadder(db, modelOf(LUNA)))).toEqual([LUNA, TERRA]);
  });

  it("counts only providers with a key for the cheapest-extractor rung", () => {
    restoreKeys = setProviderKeys("GOOGLE_API_KEY");
    // Cheapest keyed extractor is Flash-Lite itself, which is already rung one.
    expect(ids(extractionLadder(db, modelOf(FLASH_LITE)))).toEqual([FLASH_LITE, GEMINI_FLASH]);
  });

  it("never exceeds the first read plus two escalations", () => {
    restoreKeys = setProviderKeys("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY");
    expect(extractionLadder(db, modelOf(HAIKU)).length).toBeLessThanOrEqual(LADDER_MAX_RUNGS);
    expect(LADDER_MAX_RUNGS).toBe(3);
  });

  it("under the mock seam every provider has a key, so the ladder is at full length", () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    expect(ids(extractionLadder(db, modelOf(HAIKU)))).toEqual([HAIKU, SONNET, LUNA]);
  });
});

describe("walkExtractionLadder", () => {
  function model(id: string): ModelRow {
    return { ...modelOf(LUNA), id, model_id: id };
  }

  function result(text: string): ProviderResult {
    return { text, inputTokens: 10, outputTokens: 20, tokens: 30, searchCalls: 0 };
  }

  const EXTRACTION: Extraction = { answer_format: "prose", total_items: 0, brands: [] };

  /** Parses only the literal "good". Anything else is a shape violation. */
  function parse(raw: string): Extraction {
    if (raw === "good") return EXTRACTION;
    throw new Error(`SCHEMA_VIOLATION: not the shape (${raw})`);
  }

  it("returns the first rung that parses, and buys nothing after it", async () => {
    const call = vi.fn().mockResolvedValue(result("good"));
    const onViolation = vi.fn();
    const walked = await walkExtractionLadder(
      [model("m1"), model("m2")],
      "system",
      "user",
      call,
      parse,
      { onViolation },
    );
    expect(walked.extraction).toBe(EXTRACTION);
    expect(walked.model.model_id).toBe("m1");
    expect(walked.result.text).toBe("good");
    expect(call).toHaveBeenCalledTimes(1);
    expect(onViolation).not.toHaveBeenCalled();
  });

  it("re-reads the same answer up the ladder, invisibly, in order", async () => {
    const seen: string[] = [];
    const call = vi.fn(async (rung: ModelRow) => {
      seen.push(rung.model_id);
      return result(rung.model_id === "m2" ? "good" : "rubbish");
    });
    const onViolation = vi.fn();
    const walked = await walkExtractionLadder(
      [model("m1"), model("m2"), model("m3")],
      "system",
      "user",
      call,
      parse,
      { onViolation },
    );
    expect(seen).toEqual(["m1", "m2"]);
    expect(walked.model.model_id).toBe("m2");
    // The discarded rung is handed to the pass for usage logging: it was billed.
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(onViolation.mock.calls[0]?.[0]?.model_id).toBe("m1");
  });

  it("hands every rung the same system and user, so only the reader changes", async () => {
    const call = vi.fn().mockResolvedValue(result("good"));
    await walkExtractionLadder([model("m1")], "the system", "the answer", call, parse);
    expect(call).toHaveBeenCalledWith(model("m1"), "the system", "the answer");
  });

  it("fails non-retryably when the last rung also violates, naming the code the card reads", async () => {
    const call = vi.fn().mockResolvedValue(result("still rubbish"));
    const onViolation = vi.fn();
    const promise = walkExtractionLadder(
      [model("m1"), model("m2"), model("m3")],
      "s",
      "u",
      call,
      parse,
      { onViolation },
    );
    await expect(promise).rejects.toMatchObject({ status: 400, retryable: false });
    await expect(promise).rejects.toThrow(new RegExp(`^${UNREADABLE_PREFIX}`));
    expect(call).toHaveBeenCalledTimes(3);
    expect(onViolation).toHaveBeenCalledTimes(3);
    // The stored detail carries the last violation, for the technical disclosure.
    await promise.catch((error: ProviderError) => {
      expect(error.message).toContain("SCHEMA_VIOLATION");
      expect(error.message).toContain("3 readers");
    });
  });

  it("counts its rungs in the exhaustion message, singular included", async () => {
    const call = vi.fn().mockResolvedValue(result("rubbish"));
    await expect(walkExtractionLadder([model("m1")], "s", "u", call, parse)).rejects.toThrow(
      /1 reader replied/,
    );
  });

  it("propagates a provider error at once: the ladder is for wrong shapes, not for 429s", async () => {
    const rateLimited = new ProviderError("HTTP 429: slow down", 429, "HTTP:429");
    const call = vi
      .fn()
      .mockResolvedValueOnce(result("rubbish"))
      .mockRejectedValueOnce(rateLimited);
    const onViolation = vi.fn();
    const onCallError = vi.fn();
    await expect(
      walkExtractionLadder([model("m1"), model("m2"), model("m3")], "s", "u", call, parse, {
        onViolation,
        onCallError,
      }),
    ).rejects.toBe(rateLimited);
    expect(call).toHaveBeenCalledTimes(2);
    expect(onViolation).toHaveBeenCalledTimes(1);
    // The hook is what lets the pass log the failed call's usage before the
    // error reaches the task's normal retry budget.
    expect(onCallError).toHaveBeenCalledWith(model("m2"), rateLimited);
  });
});
