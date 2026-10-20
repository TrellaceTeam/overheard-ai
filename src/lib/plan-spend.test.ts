import { describe, expect, it } from "vitest";
import { andList, callsByProvider, payerPhrase, planCallsPhrase, runSpend } from "./plan-spend";

const CLAUDE_PLAN = new Set(["anthropic"]);
const BOTH_PLANS = new Set(["anthropic", "openai"]);
const NO_PLANS = new Set<string>();

describe("andList", () => {
  it("joins one, two and three names the way a sentence does", () => {
    expect(andList(["Claude"])).toBe("Claude");
    expect(andList(["Claude", "ChatGPT"])).toBe("Claude and ChatGPT");
    expect(andList(["OpenAI", "Anthropic", "Google"])).toBe("OpenAI, Anthropic and Google");
  });
});

describe("payerPhrase", () => {
  it("keeps the keys wording when nothing goes through a plan", () => {
    expect(payerPhrase(["openai", "google"], NO_PLANS)).toBe("on your own keys");
    expect(payerPhrase([], CLAUDE_PLAN)).toBe("on your own keys");
  });

  it("names the plans when every call goes through one", () => {
    expect(payerPhrase(["anthropic"], CLAUDE_PLAN)).toBe("on your Claude plan");
    expect(payerPhrase(["anthropic", "openai", "anthropic"], BOTH_PLANS)).toBe(
      "on your Claude and ChatGPT plans",
    );
  });

  it("names both when some calls bill a key and some count against a plan", () => {
    expect(payerPhrase(["openai", "anthropic"], CLAUDE_PLAN)).toBe(
      "on your own keys and your Claude plan",
    );
  });

  it("says or for one call that goes to either", () => {
    expect(payerPhrase(["openai", "anthropic"], CLAUDE_PLAN, "or")).toBe(
      "on your own keys or your Claude plan",
    );
  });
});

describe("callsByProvider", () => {
  it("counts one ask per answer for each assistant and one read per answer for the extractor", () => {
    const calls = callsByProvider({
      totalIterations: 9,
      assistants: [{ provider: "anthropic" }, { provider: "openai" }],
      extractor: { provider: "openai" },
      includePerception: false,
    });
    expect(Object.fromEntries(calls)).toEqual({ anthropic: 9, openai: 27 });
  });

  it("adds the perception answer to each assistant and to the extractor", () => {
    const calls = callsByProvider({
      totalIterations: 9,
      assistants: [{ provider: "anthropic" }],
      extractor: { provider: "anthropic" },
      includePerception: true,
    });
    expect(calls.get("anthropic")).toBe(20);
  });
});

describe("runSpend", () => {
  const calls = new Map([
    ["anthropic", 18],
    ["openai", 18],
  ]);

  it("is a key estimate when no provider is on a plan", () => {
    expect(runSpend(1.2, calls, NO_PLANS)).toEqual({ kind: "keys", usd: 1.2 });
  });

  it("drops the dollars when every call counts against a plan", () => {
    expect(runSpend(0, calls, BOTH_PLANS)).toEqual({ kind: "plans", plans: ["Claude", "ChatGPT"] });
  });

  it("keeps the key dollars and counts the plan calls when a run uses both", () => {
    const spend = runSpend(1.2, calls, CLAUDE_PLAN);
    expect(spend).toEqual({
      kind: "mixed",
      usd: 1.2,
      keys: ["OpenAI"],
      planCalls: [{ plan: "Claude", calls: 18 }],
    });
  });

  it("ignores a provider the run sends no calls to", () => {
    expect(
      runSpend(
        1.2,
        new Map([
          ["openai", 18],
          ["anthropic", 0],
        ]),
        CLAUDE_PLAN,
      ),
    ).toEqual({
      kind: "keys",
      usd: 1.2,
    });
  });
});

describe("planCallsPhrase", () => {
  it("counts the calls per plan, naming the unit once", () => {
    expect(planCallsPhrase([{ plan: "Claude", calls: 18 }])).toBe("18 calls on your Claude plan");
    expect(planCallsPhrase([{ plan: "Claude", calls: 1 }])).toBe("1 call on your Claude plan");
    expect(
      planCallsPhrase([
        { plan: "Claude", calls: 18 },
        { plan: "ChatGPT", calls: 12 },
      ]),
    ).toBe("18 calls on your Claude plan and 12 on your ChatGPT plan");
  });
});
