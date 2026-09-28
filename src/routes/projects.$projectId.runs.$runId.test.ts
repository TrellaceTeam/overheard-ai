// @vitest-environment jsdom
/**
 * The run screen's own decisions: when to keep asking the server, what it says
 * while statistics are pending or the list is capped, and how a spend that is
 * usually fractions of a cent is written down.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  awaitingStatistics,
  emptyResultsNotice,
  isMissingRun,
  money,
  runPollInterval,
  Route,
  truncationNotice,
} from "./projects.$projectId.runs.$runId";

describe("runPollInterval", () => {
  it("polls every two seconds while the run is in flight", () => {
    expect(runPollInterval("queued")).toBe(2000);
    expect(runPollInterval("running")).toBe(2000);
  });

  it("stops once the run is terminal", () => {
    for (const status of ["completed", "partial", "failed", "cancelled"]) {
      expect(runPollInterval(status)).toBe(false);
    }
  });

  it("stops rather than hammering when the run has not loaded", () => {
    expect(runPollInterval(null)).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
  });

  it("keeps the two active statuses in one place", () => {
    expect(ACTIVE_STATUSES).toEqual(["queued", "running"]);
  });

  it("keeps polling a finished run whose statistics are not written yet", () => {
    // The last answer lands before the worker finalises the run, so a page that
    // stopped at "completed" would miss the statistics until a reload.
    expect(runPollInterval("completed", true)).toBe(3000);
    expect(runPollInterval("completed", false)).toBe(false);
  });
});

describe("awaitingStatistics", () => {
  it("is true while the run is in flight", () => {
    expect(awaitingStatistics("running", null, 0)).toBe(true);
  });

  it("is true for a finished run with answers that has not been finalised", () => {
    expect(awaitingStatistics("completed", null, 3)).toBe(true);
  });

  it("is false once finalised, or when nothing was answered at all", () => {
    expect(awaitingStatistics("completed", "2026-01-01T00:00:00.000Z", 3)).toBe(false);
    // A run whose every call failed has nothing to score, so nothing to wait for.
    expect(awaitingStatistics("failed", null, 0)).toBe(false);
  });
});

describe("truncationNotice", () => {
  it("says nothing while the whole run is on the page", () => {
    expect(truncationNotice(12, 400)).toBeNull();
    expect(truncationNotice(400, 400)).toBeNull();
  });

  it("says nothing before the run has loaded", () => {
    expect(truncationNotice(undefined, undefined)).toBeNull();
    expect(truncationNotice(504, undefined)).toBeNull();
  });

  it("counts the page and the run when the list is capped", () => {
    // 400 rows under a header counting 504 look like a hundred lost answers.
    expect(truncationNotice(504, 400)).toBe("Showing the first 400 of 504 answers.");
  });
});

describe("emptyResultsNotice", () => {
  it("says the run is still being scored while its statistics are on the way", () => {
    expect(emptyResultsNotice(true)).toBe("Scoring this run. Statistics appear here in a moment.");
  });

  it("says nothing in it counts once scoring is over, rather than scoring forever", () => {
    // A finished, finalised run can have no row that counts, and no amount of
    // waiting changes that.
    expect(emptyResultsNotice(false)).toBe("Nothing in this run counts toward statistics.");
  });
});

describe("money", () => {
  it("writes nothing spent as nothing", () => {
    expect(money(0)).toBe("$0.00");
  });

  it("keeps four decimals under a cent, so a real spend never reads as zero", () => {
    expect(money(0.0031)).toBe("$0.0031");
  });

  it("uses two decimals once there is a cent to show", () => {
    expect(money(1.239)).toBe("$1.24");
  });
});

describe("isMissingRun", () => {
  it("recognises the server's own refusal", () => {
    expect(isMissingRun(new Error("RUN_NOT_FOUND: that run does not exist"))).toBe(true);
  });

  it("does not claim a run is missing when the load simply failed", () => {
    // A deleted run and an unreachable server look the same to the query. Only
    // the first means "stop waiting, this link is stale".
    expect(isMissingRun(new Error("Failed to fetch"))).toBe(false);
    expect(isMissingRun(undefined)).toBe(false);
    expect(isMissingRun("RUN_NOT_FOUND")).toBe(false);
  });
});

describe("route metadata", () => {
  it("names Overheard AI", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Run detail - Overheard AI"]);
  });
});
