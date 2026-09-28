import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb } from "../../logic/test-support";
import { stopWorker } from "../../worker/loop";
import { stopScheduler } from "../../worker/scheduler-loop";
import { INFLIGHT_CAP_ENV } from "../../worker/concurrency";
import {
  callLimit,
  databaseInfo,
  inflightCaps,
  providerKeyStatus,
  setCallLimit,
  setInflightCap,
  workerStatusView,
} from "./settings";

let db: Driver;
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  db = freshDb();
  const caps = Object.values(INFLIGHT_CAP_ENV);
  for (const name of [...KEYS, ...caps, "OVERHEARD_MOCK_PROVIDERS", "DATABASE_PATH"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  stopScheduler();
  stopWorker();
  db.close();
});

describe("providerKeyStatus", () => {
  it("reports booleans and never a value", () => {
    process.env["OPENAI_API_KEY"] = "sk-not-a-real-key";
    const status = providerKeyStatus();

    expect(status).toEqual([
      { provider: "openai", configured: true, source: "env", problem: null },
      { provider: "anthropic", configured: false, source: "none", problem: null },
      { provider: "google", configured: false, source: "none", problem: null },
    ]);
    expect(JSON.stringify(status)).not.toContain("sk-");
  });

  it("accepts GEMINI_API_KEY as the Google alias", () => {
    process.env["GEMINI_API_KEY"] = "a-google-key";
    const configured = providerKeyStatus().filter((row) => row.configured);
    expect(configured.map((row) => row.provider)).toEqual(["google"]);
  });

  it("reports nothing configured when the environment is empty", () => {
    expect(providerKeyStatus().some((row) => row.configured)).toBe(false);
  });
});

describe("databaseInfo", () => {
  it("describes an in-memory database without inventing a size", () => {
    process.env["DATABASE_PATH"] = ":memory:";
    expect(databaseInfo(db)).toEqual({
      path: ":memory:",
      sizeBytes: null,
      exists: true,
      driverModule: db.driverModule,
    });
  });

  it("resolves a file path to an absolute one and says it is missing", () => {
    process.env["DATABASE_PATH"] = "./data/does-not-exist.db";
    const info = databaseInfo(db);

    expect(info.exists).toBe(false);
    expect(info.sizeBytes).toBeNull();
    expect(info.path).toMatch(/does-not-exist\.db$/);
    expect(info.path).not.toBe("./data/does-not-exist.db");
  });
});

describe("workerStatusView", () => {
  it("says the loops are stopped when nothing has started them", () => {
    expect(workerStatusView()).toEqual({
      running: false,
      lastPass: null,
      scheduler: { running: false, lastSummary: null, lastError: null },
      mockProviders: false,
    });
  });

  it("says out loud when the mock provider seam is on", () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    expect(workerStatusView().mockProviders).toBe(true);
  });
});

describe("callLimit", () => {
  it("reads the default on a fresh database, and names it so the UI can offer a reset", () => {
    expect(callLimit(db)).toEqual({ limit: 1000, defaultLimit: 1000 });
  });

  it("reads back what setCallLimit wrote", () => {
    expect(setCallLimit(db, 250)).toEqual({ ok: true });
    expect(callLimit(db)).toEqual({ limit: 250, defaultLimit: 1000 });
  });

  it("restores the default through the same setter the Reset button uses", () => {
    setCallLimit(db, 250);
    setCallLimit(db, callLimit(db).defaultLimit);
    expect(callLimit(db).limit).toBe(1000);
  });

  it("refuses values the column would refuse, without writing", () => {
    expect(() => setCallLimit(db, 0)).toThrow();
    expect(() => setCallLimit(db, 10000001)).toThrow();
    expect(() => setCallLimit(db, 1.5)).toThrow();
    expect(callLimit(db).limit).toBe(1000);
  });
});

describe("inflightCaps", () => {
  const openai = () => inflightCaps(db).find((row) => row.provider === "openai")!;

  it("reads the defaults on a fresh database, one row per provider", () => {
    expect(inflightCaps(db)).toEqual([
      {
        provider: "openai",
        effective: 6,
        defaultCap: 6,
        stored: null,
        envName: "OVERHEARD_MAX_INFLIGHT_OPENAI",
        envOverrides: false,
      },
      {
        provider: "anthropic",
        effective: 6,
        defaultCap: 6,
        stored: null,
        envName: "OVERHEARD_MAX_INFLIGHT_ANTHROPIC",
        envOverrides: false,
      },
      {
        provider: "google",
        effective: 3,
        defaultCap: 3,
        stored: null,
        envName: "OVERHEARD_MAX_INFLIGHT_GOOGLE",
        envOverrides: false,
      },
    ]);
  });

  it("reads back what setInflightCap saved, for that provider only", () => {
    expect(setInflightCap(db, "openai", 2)).toEqual({ ok: true });
    expect(openai()).toMatchObject({ effective: 2, stored: 2 });
    expect(inflightCaps(db).find((row) => row.provider === "google")?.stored).toBeNull();
  });

  it("resets a cap to the default when it saves null", () => {
    setInflightCap(db, "openai", 2);
    setInflightCap(db, "openai", null);
    expect(openai()).toMatchObject({ effective: 6, stored: null });
  });

  it("says a valid variable wins, and shows its value over the saved one", () => {
    setInflightCap(db, "openai", 2);
    process.env["OVERHEARD_MAX_INFLIGHT_OPENAI"] = "9";
    expect(openai()).toMatchObject({ effective: 9, stored: 2, envOverrides: true });
  });

  it("does not count an invalid variable as an override", () => {
    process.env["OVERHEARD_MAX_INFLIGHT_OPENAI"] = "lots";
    expect(openai()).toMatchObject({ effective: 6, envOverrides: false });
  });

  it("refuses values the column would refuse with a coded error, without writing", () => {
    setInflightCap(db, "openai", 4);
    for (const bad of [0, 16, 2.5, -1]) {
      expect(() => setInflightCap(db, "openai", bad), String(bad)).toThrow(/^INFLIGHT_CAP_INVALID/);
    }
    expect(openai().stored).toBe(4);
  });

  it("refuses a provider it has no column for", () => {
    // Cast past the type, as input that skipped the server function's
    // validator would arrive.
    expect(() => setInflightCap(db, "perplexity" as never, 4)).toThrow(/^INFLIGHT_CAP_INVALID/);
  });

  it("saves on a database that lost its app_state row", () => {
    db.prepare("DELETE FROM app_state").run();
    expect(openai().stored).toBeNull();
    setInflightCap(db, "openai", 3);
    expect(openai().stored).toBe(3);
  });
});
