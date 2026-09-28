import { describe, expect, it } from "vitest";
import type { MetricRow } from "./metrics";
import {
  NO_FILTER,
  applyFilter,
  applyPerceptionFilter,
  assistantLabel,
  emptyReason,
  orderAssistants,
  periodLabel,
  periodStart,
  type DashboardFilter,
  type FilterContext,
} from "./dashboard-filters";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const PROVIDERS = new Map<string, string>([
  ["claude-model", "anthropic"],
  ["gpt-model", "openai"],
  ["gemini-model", "google"],
]);

const ctx: FilterContext = {
  providerOf: (modelId) => (modelId === null ? null : (PROVIDERS.get(modelId) ?? null)),
  now: NOW,
};

let seq = 0;

function row(partial: Partial<MetricRow> = {}): MetricRow {
  return {
    id: `row-${++seq}`,
    run_id: "run-1",
    brand_id: "brand-a",
    model_id: "claude-model",
    prompt_id: "prompt-1",
    answers: 10,
    mentions: 5,
    ranked: 0,
    citations: 0,
    top_pick_share: null,
    top3_rate: null,
    created_at: new Date(NOW - DAY).toISOString(),
    ...partial,
  };
}

const filter = (patch: Partial<DashboardFilter> = {}): DashboardFilter => ({
  ...NO_FILTER,
  ...patch,
});

describe("periodStart", () => {
  it("has no lower bound for all time", () => {
    expect(periodStart("all", NOW)).toBeNull();
  });

  it("is a rolling window measured back from now", () => {
    expect(periodStart("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(periodStart("30d", NOW)).toBe(NOW - 30 * DAY);
    expect(periodStart("90d", NOW)).toBe(NOW - 90 * DAY);
  });
});

describe("assistantLabel", () => {
  it("names the assistant, not the company that makes it", () => {
    // providerLabel() in failure-reasons.ts gives "Anthropic" and "Google",
    // which is right for saying whose fault a failure was and wrong here.
    expect(assistantLabel("anthropic")).toBe("Claude");
    expect(assistantLabel("google")).toBe("Gemini");
    expect(assistantLabel("openai")).toBe("OpenAI");
  });

  it("shows an unknown provider as itself rather than hiding it", () => {
    expect(assistantLabel("someone-new")).toBe("someone-new");
  });
});

describe("orderAssistants", () => {
  it("uses a fixed order whatever order it is given", () => {
    expect(orderAssistants(["google", "anthropic", "openai"])).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
  });

  it("deduplicates, and puts anything unrecognised last", () => {
    expect(orderAssistants(["zeta", "openai", "openai", "alpha"])).toEqual([
      "openai",
      "alpha",
      "zeta",
    ]);
  });
});

describe("applyFilter", () => {
  it("keeps everything when no assistant selection has been made", () => {
    const rows = [row({ model_id: "claude-model" }), row({ model_id: "unknown-model" })];
    expect(applyFilter(rows, filter(), ctx)).toHaveLength(2);
  });

  it("keeps only the selected assistants", () => {
    const rows = [
      row({ model_id: "claude-model" }),
      row({ model_id: "gpt-model" }),
      row({ model_id: "gemini-model" }),
    ];
    const kept = applyFilter(rows, filter({ assistants: ["openai", "google"] }), ctx);
    expect(kept.map((r) => r.model_id)).toEqual(["gpt-model", "gemini-model"]);
  });

  it("drops a row whose assistant cannot be identified once a selection exists", () => {
    // Fail closed: a row that might be from anyone must not be counted as
    // though it came from the assistant the reader picked.
    const rows = [row({ model_id: "unknown-model" }), row({ model_id: null })];
    expect(applyFilter(rows, filter({ assistants: ["anthropic"] }), ctx)).toHaveLength(0);
  });

  it("selects nothing when every assistant is turned off", () => {
    const rows = [row(), row({ model_id: "gpt-model" })];
    expect(applyFilter(rows, filter({ assistants: [] }), ctx)).toHaveLength(0);
  });

  it("includes a row exactly on the period boundary and excludes one older", () => {
    const onBoundary = row({ created_at: new Date(NOW - 7 * DAY).toISOString() });
    const justOutside = row({ created_at: new Date(NOW - 7 * DAY - 1).toISOString() });
    const kept = applyFilter([onBoundary, justOutside], filter({ period: "7d" }), ctx);
    expect(kept).toEqual([onBoundary]);
  });

  it("keeps only the selected prompt", () => {
    const rows = [row({ prompt_id: "p1" }), row({ prompt_id: "p2" })];
    expect(applyFilter(rows, filter({ promptId: "p2" }), ctx).map((r) => r.prompt_id)).toEqual([
      "p2",
    ]);
  });

  it("applies every filter at once", () => {
    const wanted = row({ model_id: "gpt-model", prompt_id: "p1" });
    const rows = [
      wanted,
      row({ model_id: "claude-model", prompt_id: "p1" }),
      row({ model_id: "gpt-model", prompt_id: "p2" }),
      row({
        model_id: "gpt-model",
        prompt_id: "p1",
        created_at: new Date(NOW - 40 * DAY).toISOString(),
      }),
    ];
    const kept = applyFilter(
      rows,
      filter({ assistants: ["openai"], promptId: "p1", period: "30d" }),
      ctx,
    );
    expect(kept).toEqual([wanted]);
  });
});

describe("emptyReason", () => {
  it("is null while the filter still matches something", () => {
    expect(emptyReason([row()], filter(), ctx)).toBeNull();
  });

  it("is null when nothing has been measured at all", () => {
    // Not a filter problem. The dashboard has better words for a project with
    // no scored runs, and blaming a filter for it would be wrong.
    expect(emptyReason([], filter({ period: "7d" }), ctx)).toBeNull();
  });

  it("says so when every assistant has been switched off", () => {
    expect(emptyReason([row()], filter({ assistants: [] }), ctx)).toMatch(/No assistants selected/);
  });

  it("names the period when the period is what emptied it", () => {
    const rows = [row({ created_at: new Date(NOW - 60 * DAY).toISOString() })];
    expect(emptyReason(rows, filter({ period: "7d" }), ctx)).toBe("No runs in the last 7 days.");
  });

  it("names a single assistant", () => {
    const rows = [row({ model_id: "claude-model" })];
    expect(emptyReason(rows, filter({ assistants: ["google"] }), ctx)).toBe(
      "No answers from Gemini yet.",
    );
  });

  it("lists several assistants readably", () => {
    const rows = [row({ model_id: "claude-model" })];
    expect(emptyReason(rows, filter({ assistants: ["google", "openai"] }), ctx)).toBe(
      "No answers from OpenAI or Gemini yet.",
    );
  });

  it("names the prompt", () => {
    const rows = [row({ prompt_id: "p1" })];
    expect(emptyReason(rows, filter({ promptId: "p9" }), ctx)).toBe(
      "No data for the selected prompt yet.",
    );
  });

  it("blames the combination when no single filter is at fault", () => {
    // Each filter on its own leaves a row standing. Only together do they
    // exclude everything, and "no runs in the last 7 days" would be wrong,
    // because there is one.
    const rows = [
      row({ model_id: "claude-model", created_at: new Date(NOW - DAY).toISOString() }),
      row({ model_id: "gpt-model", created_at: new Date(NOW - 60 * DAY).toISOString() }),
    ];
    expect(emptyReason(rows, filter({ assistants: ["openai"], period: "7d" }), ctx)).toBe(
      "No data for this combination of filters yet.",
    );
  });
});

describe("periodLabel", () => {
  it("labels each period", () => {
    expect(periodLabel("all")).toBe("All time");
    expect(periodLabel("30d")).toBe("Last 30 days");
  });
});

describe("applyPerceptionFilter", () => {
  const answer = (model_id: string | null, daysAgo = 1) => ({
    model_id,
    created_at: new Date(NOW - daysAgo * DAY).toISOString(),
  });

  it("narrows to the selected assistants", () => {
    const rows = [answer("claude-model"), answer("gpt-model"), answer("gemini-model")];
    const kept = applyPerceptionFilter(rows, filter({ assistants: ["google"] }), ctx);
    expect(kept.map((r) => r.model_id)).toEqual(["gemini-model"]);
  });

  it("does NOT apply the period, which would empty the band", () => {
    // A summary is the current state of what an assistant says, not a
    // measurement taken on a date. Filtering it by period would report "no
    // perception data" about a project that has plenty.
    const rows = [answer("claude-model", 400)];
    expect(applyPerceptionFilter(rows, filter({ period: "7d" }), ctx)).toHaveLength(1);
  });

  it("ignores the prompt filter, which cannot apply", () => {
    // A perception answer has no prompt_id. Filtering to a prompt must not
    // empty the band.
    const rows = [answer("claude-model")];
    expect(applyPerceptionFilter(rows, filter({ promptId: "p1" }), ctx)).toHaveLength(1);
  });
});
