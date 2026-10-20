import { describe, expect, it } from "vitest";
import { effectiveCaps, envCap, INFLIGHT_CAP_ENV, type StoredCaps } from "./concurrency";
import { DEFAULT_PROVIDER_CAPS } from "../logic/claim-tasks";
import { standInCommand } from "./cli-test-support";

const NAMES = Object.values(INFLIGHT_CAP_ENV);
const NOTHING_SAVED: StoredCaps = { openai: null, anthropic: null, google: null };

describe("effectiveCaps", () => {
  it("returns the shipped defaults when nothing is saved or set", () => {
    expect(effectiveCaps(NOTHING_SAVED, {})).toEqual(DEFAULT_PROVIDER_CAPS);
  });

  it("applies a saved cap over the default and leaves the rest default", () => {
    expect(effectiveCaps({ ...NOTHING_SAVED, anthropic: 2 }, {})).toEqual({
      ...DEFAULT_PROVIDER_CAPS,
      anthropic: 2,
    });
  });

  it("overrides one provider from its variable and leaves the rest default", () => {
    expect(effectiveCaps(NOTHING_SAVED, { [INFLIGHT_CAP_ENV["openai"]]: "8" })).toEqual({
      ...DEFAULT_PROVIDER_CAPS,
      openai: 8,
    });
  });

  it("lets a valid variable win over the saved cap", () => {
    const caps = effectiveCaps(
      { openai: 2, anthropic: 4, google: 1 },
      { [INFLIGHT_CAP_ENV["openai"]]: "10" },
    );
    expect(caps).toEqual({ openai: 10, anthropic: 4, google: 1 });
  });

  it("falls back to the saved cap, then the default, past an invalid variable", () => {
    for (const bad of ["0", "-3", "2.5", "many", ""]) {
      const env = { [INFLIGHT_CAP_ENV["google"]]: bad };
      expect(effectiveCaps({ ...NOTHING_SAVED, google: 5 }, env).google, bad).toBe(5);
      expect(effectiveCaps(NOTHING_SAVED, env).google, bad).toBe(DEFAULT_PROVIDER_CAPS["google"]);
    }
  });

  it("ignores a saved cap outside the column's bounds, keeping the default", () => {
    for (const bad of [0, 16, 2.5]) {
      expect(effectiveCaps({ ...NOTHING_SAVED, openai: bad }, {}).openai, String(bad)).toBe(
        DEFAULT_PROVIDER_CAPS["openai"],
      );
    }
  });

  it("does not hold a variable to the saved cap's upper bound", () => {
    expect(effectiveCaps(NOTHING_SAVED, { [INFLIGHT_CAP_ENV["openai"]]: "40" }).openai).toBe(40);
  });

  it("starts a provider in subscription mode lower, and still lets a saved cap win", () => {
    process.env["OVERHEARD_ANTHROPIC_CLI"] = standInCommand();
    try {
      expect(effectiveCaps(NOTHING_SAVED, {}).anthropic).toBe(3);
      expect(effectiveCaps({ ...NOTHING_SAVED, anthropic: 5 }, {}).anthropic).toBe(5);
      expect(effectiveCaps(NOTHING_SAVED, {}).openai).toBe(DEFAULT_PROVIDER_CAPS["openai"]);
    } finally {
      delete process.env["OVERHEARD_ANTHROPIC_CLI"];
    }
  });
});

describe("envCap", () => {
  it("is null when the variable is unset or invalid, so the field stays editable", () => {
    expect(envCap("anthropic", {})).toBeNull();
    expect(envCap("anthropic", { [INFLIGHT_CAP_ENV["anthropic"]]: "0" })).toBeNull();
    expect(envCap("anthropic", { [INFLIGHT_CAP_ENV["anthropic"]]: "3" })).toBe(3);
  });

  it("names one variable per provider", () => {
    expect(NAMES).toEqual([
      "OVERHEARD_MAX_INFLIGHT_OPENAI",
      "OVERHEARD_MAX_INFLIGHT_ANTHROPIC",
      "OVERHEARD_MAX_INFLIGHT_GOOGLE",
    ]);
  });
});
