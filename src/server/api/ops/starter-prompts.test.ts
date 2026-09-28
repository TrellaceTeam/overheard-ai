import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../../db/driver";
import type { ModelRow } from "../../db/types";
import { freshDb, setProviderKeys } from "../../logic/test-support";
import { ProviderError, type ProviderResult } from "../../worker/providers";
import { NO_KEY_HINT, STARTER_GENERATION_SYSTEM } from "@/lib/starter-generation";
import {
  generateStarterPrompts,
  GENERATION_MAX_TOKENS,
  type GenerationCall,
  UNUSABLE_REPLY_REASON,
} from "./starter-prompts";

// The model rule filters by key, so keys are set even though every call in
// these suites is injected or stubbed. Fake values: nothing reaches a network.
let restoreKeys: (() => void) | undefined;
let db: Driver | undefined;

beforeEach(() => {
  restoreKeys = setProviderKeys("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY");
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

afterEach(() => {
  restoreKeys?.();
  restoreKeys = undefined;
  db?.close();
  db = undefined;
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  vi.unstubAllGlobals();
});

function open(): Driver {
  db = freshDb();
  return db;
}

const ALL_KEYS = ["openai", "anthropic", "google"];

const REQUEST = {
  brandName: "Acme Analytics",
  category: "coworking space",
  description: "Hot desks and meeting rooms for freelancers in Lisbon.",
  variants: ["Acme"],
  competitors: ["Northwind Metrics"],
};

const GOOD = JSON.stringify({
  visibility_1: "Which coworking spaces in Lisbon suit a freelancer who needs quiet hot desks?",
  visibility_2: "Where can a remote designer rent a desk by the day in central Lisbon?",
  visibility_3:
    "Which Lisbon coworking spaces have meeting rooms a freelancer can book by the hour?",
  comparison: "How do Lisbon coworking spaces compare on day passes versus monthly desks?",
  comparison_naming_brand:
    "Are there better alternatives than Acme Analytics for freelancers who need a desk in Lisbon?",
});

/** Visibility naming the brand: valid JSON, broken contract. */
const BRAND_IN_VISIBILITY = JSON.stringify({
  ...(JSON.parse(GOOD) as Record<string, string>),
  visibility_1: "Is Acme Analytics the best coworking space in Lisbon?",
});

function result(text: string): ProviderResult {
  return { text, inputTokens: 900, outputTokens: 400, tokens: 1_300, searchCalls: 0 };
}

/** A call that answers each reply in turn and records the models it was sent to. */
function calls(...replies: Array<string | Error>) {
  const models: ModelRow[] = [];
  const systems: string[] = [];
  const call: GenerationCall = async (model, system) => {
    models.push(model);
    systems.push(system);
    const next = replies[Math.min(models.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    return result(next ?? GOOD);
  };
  return { call, models, systems };
}

function usageRows(database: Driver) {
  return database
    .prepare(
      "SELECT run_id, run_task_id, kind, provider, model_id, outcome, input_tokens, cost_usd FROM usage_events ORDER BY rowid",
    )
    .all<{
      run_id: string | null;
      run_task_id: string | null;
      kind: string;
      provider: string;
      model_id: string;
      outcome: string;
      input_tokens: number;
      cost_usd: number;
    }>();
}

describe("generateStarterPrompts", () => {
  it("returns the generated five and logs the call's spend, with no run", async () => {
    const database = open();
    const { call, systems } = calls(GOOD);

    const generated = await generateStarterPrompts(database, REQUEST, {
      providersWithKeys: ALL_KEYS,
      call,
    });

    expect(generated.prompts).toHaveLength(5);
    expect(generated.prompts.map((prompt) => prompt.tag)).toEqual([
      "visibility",
      "visibility",
      "visibility",
      "comparison",
      "comparison",
    ]);
    expect(systems).toEqual([STARTER_GENERATION_SYSTEM]);
    const rows = usageRows(database);
    expect(rows).toEqual([
      expect.objectContaining({
        run_id: null,
        run_task_id: null,
        kind: "prompt_generation",
        outcome: "success",
        input_tokens: 900,
      }),
    ]);
    expect(rows[0]?.cost_usd).toBeGreaterThan(0);
    expect(generated.costUsd).toBeCloseTo(rows[0]?.cost_usd ?? 0, 10);
  });

  it("calls the cheapest keyed mid-tier model, OpenAI first on the catalogue's exact tie", async () => {
    const database = open();
    const everyKey = calls(GOOD);
    await generateStarterPrompts(database, REQUEST, {
      providersWithKeys: ALL_KEYS,
      call: everyKey.call,
    });
    // GPT-5.6 Terra and Gemini 3.6 Flash list at the same prices.
    expect(everyKey.models[0]?.model_id).toBe("gpt-5.6-terra");

    const anthropicOnly = calls(GOOD);
    await generateStarterPrompts(database, REQUEST, {
      providersWithKeys: ["anthropic"],
      call: anthropicOnly.call,
    });
    expect(anthropicOnly.models[0]?.model_id).toBe("claude-sonnet-5");
  });

  it("falls back to the cheapest keyed extractor when every mid-tier model is switched off", async () => {
    const database = open();
    database.prepare("UPDATE models SET is_active = 0 WHERE tier = 'mid'").run();
    const { call, models } = calls(GOOD);
    await generateStarterPrompts(database, REQUEST, {
      providersWithKeys: ["google", "anthropic"],
      call,
    });
    expect(models[0]?.model_id).toBe("gemini-3.1-flash-lite");
  });

  it("refuses with no key, before any call, and logs nothing", async () => {
    const database = open();
    const { call, models } = calls(GOOD);
    await expect(
      generateStarterPrompts(database, REQUEST, { providersWithKeys: [], call }),
    ).rejects.toThrow(`NO_PROVIDER_KEY: ${NO_KEY_HINT}`);
    expect(models).toHaveLength(0);
    expect(usageRows(database)).toHaveLength(0);
  });

  it("refuses a blank brand before any call", async () => {
    const database = open();
    const { call, models } = calls(GOOD);
    await expect(
      generateStarterPrompts(
        database,
        { ...REQUEST, brandName: "  " },
        { providersWithKeys: ALL_KEYS, call },
      ),
    ).rejects.toThrow(/NO_BRAND/);
    expect(models).toHaveLength(0);
  });
});

describe("generateStarterPrompts, the rare bad day", () => {
  it("retries once on a reply in the wrong shape, and logs the discarded one", async () => {
    const database = open();
    const { call, models } = calls("Here are five great questions!", GOOD);

    const generated = await generateStarterPrompts(database, REQUEST, {
      providersWithKeys: ALL_KEYS,
      call,
    });

    expect(generated.prompts).toHaveLength(5);
    expect(models).toHaveLength(2);
    expect(usageRows(database).map((row) => row.outcome)).toEqual(["retried", "success"]);
    const total = usageRows(database).reduce((sum, row) => sum + row.cost_usd, 0);
    expect(generated.costUsd).toBeCloseTo(total, 10);
  });

  it("treats a broken contract as a wrong shape: the brand in a visibility question", async () => {
    const database = open();
    const { call, models } = calls(BRAND_IN_VISIBILITY, GOOD);
    await generateStarterPrompts(database, REQUEST, { providersWithKeys: ALL_KEYS, call });
    expect(models).toHaveLength(2);
  });

  it("gives up after the one retry, says why, and logs both replies", async () => {
    const database = open();
    const { call, models } = calls(BRAND_IN_VISIBILITY, "not json");

    await expect(
      generateStarterPrompts(database, REQUEST, { providersWithKeys: ALL_KEYS, call }),
    ).rejects.toThrow(`GENERATION_FAILED: ${UNUSABLE_REPLY_REASON}`);
    expect(models).toHaveLength(2);
    expect(usageRows(database).map((row) => row.outcome)).toEqual(["retried", "failed"]);
  });

  it("names the reason for a provider failure, with no retry and no ladder", async () => {
    const cases: Array<[ProviderError, RegExp]> = [
      [
        new ProviderError("HTTP 401: invalid api key", 401, "HTTP:401"),
        /That OpenAI key was rejected\./,
      ],
      [
        new ProviderError("HTTP 429: slow down", 429, "HTTP:429"),
        /OpenAI is rate-limiting right now/,
      ],
      [
        new ProviderError("HTTP 429: insufficient_quota", 429, "HTTP:429"),
        /the organization has no credit left/,
      ],
      [new ProviderError("HTTP 503: upstream", 503, "HTTP:503"), /overloaded or unreachable/],
      [new ProviderError("fetch failed", 0, "NETWORK"), /overloaded or unreachable/],
      [
        new ProviderError("HTTP 404: The model does not exist", 404, "HTTP:404"),
        /This account cannot use that OpenAI model\./,
      ],
      [
        new ProviderError("MISSING_CREDENTIAL:openai", 400, "MISSING_CREDENTIAL:openai"),
        /Needs a provider key\. Add one in Account settings\./,
      ],
      [new ProviderError("HTTP 400: something odd", 400, "HTTP:400"), /could not classify/],
    ];
    for (const [error, reason] of cases) {
      const database = open();
      const { call, models } = calls(error);
      await expect(
        generateStarterPrompts(database, REQUEST, { providersWithKeys: ["openai"], call }),
      ).rejects.toThrow(reason);
      expect(models).toHaveLength(1);
      database.close();
      db = undefined;
    }
  });

  it("logs nothing for a refusal the provider does not bill, and the worst case for one it may", async () => {
    const refused = open();
    const unbilled = calls(new ProviderError("HTTP 401: invalid api key", 401, "HTTP:401"));
    await expect(
      generateStarterPrompts(refused, REQUEST, {
        providersWithKeys: ["openai"],
        call: unbilled.call,
      }),
    ).rejects.toThrow(/GENERATION_FAILED/);
    expect(usageRows(refused)).toHaveLength(0);
    refused.close();

    const database = open();
    const billed = calls(new ProviderError("HTTP 500: upstream", 500, "HTTP:500"));
    await expect(
      generateStarterPrompts(database, REQUEST, {
        providersWithKeys: ["openai"],
        call: billed.call,
      }),
    ).rejects.toThrow(/GENERATION_FAILED/);
    const rows = usageRows(database);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "prompt_generation", outcome: "error", input_tokens: 0 }),
    ]);
    // The worst case carries the full output cap at the model's output price.
    const terra = database
      .prepare("SELECT output_price_per_mtok FROM models WHERE model_id = 'gpt-5.6-terra'")
      .get<{ output_price_per_mtok: number }>();
    expect(rows[0]?.cost_usd).toBeGreaterThan(
      (GENERATION_MAX_TOKENS / 1e6) * (terra?.output_price_per_mtok ?? 0),
    );
  });

  it("logs a rejected response's own usage rather than a worst case", async () => {
    const database = open();
    const { call } = calls(
      new ProviderError("HTTP 500: upstream", 500, "HTTP:500", {
        inputTokens: 800,
        outputTokens: 20,
        searchCalls: 0,
      }),
    );
    await expect(
      generateStarterPrompts(database, REQUEST, { providersWithKeys: ["openai"], call }),
    ).rejects.toThrow(/GENERATION_FAILED/);
    expect(usageRows(database)).toEqual([
      expect.objectContaining({ outcome: "error", input_tokens: 800 }),
    ]);
  });
});

describe("generateStarterPrompts, through the provider layer", () => {
  it("sends the enforced shape as OpenAI strict structured outputs, and reads the reply", async () => {
    const database = open();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: GOOD } }],
          usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1_200 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const generated = await generateStarterPrompts(database, REQUEST, {
      providersWithKeys: ["openai"],
    });

    expect(generated.prompts).toHaveLength(5);
    const format = bodies[0]?.["response_format"] as {
      type: string;
      json_schema: { name: string; strict: boolean };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema).toMatchObject({ name: "starter_prompts", strict: true });
    // No search: the question is written here and asked, searching, on a run.
    expect(bodies[0]?.["tools"]).toBeUndefined();
    expect(bodies[0]?.["max_completion_tokens"]).toBe(GENERATION_MAX_TOKENS);
  });

  it("is answered by the mock seam with a deterministic five inside the contract, at no cost", async () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    // No fetch stub: a live call would throw or hang, so a clean resolve shows
    // the seam answered before any request was built.
    const database = open();
    const first = await generateStarterPrompts(database, REQUEST, { providersWithKeys: ALL_KEYS });
    const second = await generateStarterPrompts(database, REQUEST, { providersWithKeys: ALL_KEYS });

    expect(first.prompts).toEqual(second.prompts);
    expect(first.prompts).toHaveLength(5);
    expect(first.prompts[4]?.text).toBe(
      "Are there better alternatives than Acme Analytics for coworking space?",
    );
    expect(first.costUsd).toBe(0);
    expect(usageRows(database).map((row) => [row.outcome, row.cost_usd])).toEqual([
      ["success", 0],
      ["success", 0],
    ]);
  });
});
