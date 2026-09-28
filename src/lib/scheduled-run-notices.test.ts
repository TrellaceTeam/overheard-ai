import { describe, expect, it } from "vitest";
import { CALLS_PER_ANSWER } from "./run-progress";
import {
  advanceSeen,
  claimUnseen,
  type FinishedScheduledRun,
  mayClaim,
  NOTICE_SEEN_KEY,
  NOTIFY_OPT_IN_KEY,
  type NoticeStorage,
  notificationOptIn,
  readSeen,
  runNotice,
  unseenRuns,
} from "./scheduled-run-notices";

/** Runs store provider calls; a person reads answers. Build inputs in answers. */
const calls = (answers: number) => answers * CALLS_PER_ANSWER;

function run(overrides: Partial<FinishedScheduledRun> = {}): FinishedScheduledRun {
  return {
    runId: "r1",
    projectId: "p1",
    projectName: "Acme Analytics",
    status: "completed",
    plannedCalls: calls(10),
    completedCalls: calls(10),
    failedCalls: 0,
    finishedAt: "2026-09-27T10:00:00.000Z",
    ...overrides,
  };
}

/** One browser's localStorage, shared by every tab of it. */
function storage(
  initial: Record<string, string> = {},
): NoticeStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

const NOW = new Date("2026-09-27T12:00:00.000Z");

describe("the stored keys", () => {
  it("sit under the app's prefix, beside its other stored keys", () => {
    expect(NOTICE_SEEN_KEY).toBe("overheard:scheduled-runs-seen");
    expect(NOTIFY_OPT_IN_KEY).toBe("overheard:scheduled-run-notifications");
  });
});

describe("readSeen", () => {
  it("starts a browser's first visit from now, so old runs do not flood in", () => {
    const store = storage();
    expect(readSeen(store, NOW)).toBe(NOW.toISOString());
    expect(store.values.get(NOTICE_SEEN_KEY)).toBe(NOW.toISOString());
  });

  it("keeps a stored timestamp, so a run finished while no tab was open is still new", () => {
    const store = storage({ [NOTICE_SEEN_KEY]: "2026-09-20T08:00:00.000Z" });
    expect(readSeen(store, NOW)).toBe("2026-09-20T08:00:00.000Z");
  });

  it("starts again from now when the stored value is not a timestamp", () => {
    const store = storage({ [NOTICE_SEEN_KEY]: "soon" });
    expect(readSeen(store, NOW)).toBe(NOW.toISOString());
  });

  it("brings a timestamp in the future back to now, or runs until then would pass unannounced", () => {
    const store = storage({ [NOTICE_SEEN_KEY]: "2027-01-01T00:00:00.000Z" });
    expect(readSeen(store, NOW)).toBe(NOW.toISOString());
  });
});

describe("unseenRuns", () => {
  it("keeps only the runs that finished after the seen timestamp", () => {
    const runs = [
      run({ runId: "before", finishedAt: "2026-09-27T09:00:00.000Z" }),
      run({ runId: "at", finishedAt: "2026-09-27T10:00:00.000Z" }),
      run({ runId: "after", finishedAt: "2026-09-27T11:00:00.000Z" }),
    ];
    expect(unseenRuns(runs, "2026-09-27T10:00:00.000Z").map((r) => r.runId)).toEqual(["after"]);
  });

  it("orders them oldest first, so the newest notice lands on top", () => {
    const runs = [
      run({ runId: "newer", finishedAt: "2026-09-27T11:30:00.000Z" }),
      run({ runId: "older", finishedAt: "2026-09-27T11:00:00.000Z" }),
    ];
    expect(unseenRuns(runs, "2026-09-27T10:00:00.000Z").map((r) => r.runId)).toEqual([
      "older",
      "newer",
    ]);
  });

  it("announces a run listed twice once", () => {
    const twice = [run({ finishedAt: "2026-09-27T11:00:00.000Z" }), run()];
    expect(unseenRuns(twice, "2026-09-27T09:00:00.000Z")).toHaveLength(1);
  });
});

describe("advanceSeen", () => {
  it("moves to the latest finish announced", () => {
    const runs = [
      run({ finishedAt: "2026-09-27T11:00:00.000Z" }),
      run({ runId: "r2", finishedAt: "2026-09-27T11:30:00.000Z" }),
    ];
    expect(advanceSeen("2026-09-27T10:00:00.000Z", runs)).toBe("2026-09-27T11:30:00.000Z");
  });

  it("never moves back", () => {
    const runs = [run({ finishedAt: "2026-09-27T09:00:00.000Z" })];
    expect(advanceSeen("2026-09-27T10:00:00.000Z", runs)).toBe("2026-09-27T10:00:00.000Z");
  });
});

describe("claimUnseen", () => {
  it("hands a run to the first tab that claims it, and to no tab after", () => {
    // Two tabs of one browser share one localStorage and poll the same runs.
    const store = storage({ [NOTICE_SEEN_KEY]: "2026-09-27T09:00:00.000Z" });
    const polled = [run({ finishedAt: "2026-09-27T11:00:00.000Z" })];

    expect(claimUnseen(store, polled, NOW).map((r) => r.runId)).toEqual(["r1"]);
    expect(claimUnseen(store, polled, NOW)).toEqual([]);
    expect(store.values.get(NOTICE_SEEN_KEY)).toBe("2026-09-27T11:00:00.000Z");
  });

  it("announces a run that finished after the last claim", () => {
    const store = storage({ [NOTICE_SEEN_KEY]: "2026-09-27T09:00:00.000Z" });
    claimUnseen(store, [run({ finishedAt: "2026-09-27T10:00:00.000Z" })], NOW);
    const later = run({ runId: "r2", finishedAt: "2026-09-27T11:00:00.000Z" });
    expect(claimUnseen(store, [later], NOW).map((r) => r.runId)).toEqual(["r2"]);
  });

  it("claims nothing on a first visit, whatever the poll returned", () => {
    const store = storage();
    expect(claimUnseen(store, [run()], NOW)).toEqual([]);
  });
});

describe("mayClaim", () => {
  it("claims in a tab in view", () => {
    expect(mayClaim(false, false)).toBe(true);
  });

  it("leaves the run for a tab in view when this one is hidden and has no notification to raise", () => {
    expect(mayClaim(true, false)).toBe(false);
  });

  it("claims in a hidden tab that can raise a browser notification", () => {
    expect(mayClaim(true, true)).toBe(true);
  });
});

describe("notificationOptIn", () => {
  it("is unsupported when the browser has no Notification API", () => {
    expect(notificationOptIn(null, true)).toBe("unsupported");
  });

  it("is denied once the browser has refused, whatever was stored", () => {
    expect(notificationOptIn("denied", true)).toBe("denied");
  });

  it("is on only with the opt-in stored and permission granted", () => {
    expect(notificationOptIn("granted", true)).toBe("on");
    expect(notificationOptIn("granted", false)).toBe("off");
    // Permission reset in the browser: asking again is the way back on.
    expect(notificationOptIn("default", true)).toBe("off");
  });
});

describe("runNotice", () => {
  it("says a run collected every answer", () => {
    const notice = runNotice(run());
    expect(notice.tone).toBe("success");
    expect(notice.title).toBe("Scheduled run complete: Acme Analytics");
    expect(notice.description).toBe("All 10 answers collected");
  });

  it("says a run finished with some answers failed, with both counts", () => {
    const notice = runNotice(
      run({ status: "partial", completedCalls: calls(7), failedCalls: calls(3) }),
    );
    expect(notice.tone).toBe("partial");
    expect(notice.title).toBe("Scheduled run finished with failures: Acme Analytics");
    expect(notice.description).toBe("7 of 10 answers collected. 3 failed");
  });

  it("says a run failed", () => {
    const notice = runNotice(run({ status: "failed", completedCalls: 0, failedCalls: calls(10) }));
    expect(notice.tone).toBe("failed");
    expect(notice.title).toBe("Scheduled run failed: Acme Analytics");
    expect(notice.description).toBe("No answers collected. All 10 answers failed");
  });

  it("ends without a period, as every toast does", () => {
    for (const status of ["completed", "partial", "failed"] as const) {
      const { title, description } = runNotice(run({ status, failedCalls: calls(3) }));
      expect(title.endsWith(".")).toBe(false);
      expect(description.endsWith(".")).toBe(false);
    }
  });
});
