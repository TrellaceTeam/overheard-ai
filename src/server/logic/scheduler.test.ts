/**
 * nextOccurrence and the sweep that fires it.
 *
 * The DST edges are pinned here: a local hour that does not exist fires at the
 * first valid instant after it, and an hour that happens twice takes the first
 * of the two.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { RunRow, ScheduleRow } from "../db/types";
import { enqueueScheduledRuns, nextOccurrence, SKIPPED_OVERLAP } from "./scheduler";
import type { Cadence, CreateRunOptions, ScheduleSpec } from "./types";
import { freshDb, seedProject } from "./test-support";

function spec(partial: Partial<ScheduleSpec> & { cadence: Cadence }): ScheduleSpec {
  return {
    dayOfWeek: null,
    dayOfMonth: null,
    hourUtc: 8,
    timezone: "UTC",
    ...partial,
  };
}

function at(iso: string): Date {
  return new Date(iso);
}

describe("nextOccurrence, daily", () => {
  it("takes today's slot when it is still ahead", () => {
    expect(
      nextOccurrence(spec({ cadence: "daily" }), at("2026-09-22T07:00:00Z")).toISOString(),
    ).toBe("2026-09-22T08:00:00.000Z");
  });

  it("rolls to tomorrow on an exact hit, so a slot cannot fire twice", () => {
    expect(
      nextOccurrence(spec({ cadence: "daily" }), at("2026-09-22T08:00:00Z")).toISOString(),
    ).toBe("2026-09-23T08:00:00.000Z");
  });

  it("rolls to tomorrow once the slot has gone", () => {
    expect(
      nextOccurrence(spec({ cadence: "daily" }), at("2026-09-22T09:00:00Z")).toISOString(),
    ).toBe("2026-09-23T08:00:00.000Z");
  });

  it("reads the hour in the schedule's own timezone", () => {
    // London is on BST in September, so 08:00 local is 07:00 UTC.
    const london = spec({ cadence: "daily", timezone: "Europe/London" });
    expect(nextOccurrence(london, at("2026-09-22T06:00:00Z")).toISOString()).toBe(
      "2026-09-22T07:00:00.000Z",
    );

    // New York is five hours behind in January, so 08:00 local is 13:00 UTC.
    const newYork = spec({ cadence: "daily", timezone: "America/New_York" });
    expect(nextOccurrence(newYork, at("2026-01-15T06:00:00Z")).toISOString()).toBe(
      "2026-01-15T13:00:00.000Z",
    );
  });

  it("crosses the local date boundary rather than the UTC one", () => {
    // 23:00 UTC on 21 September is 19:00 in New York, so the 08:00 slot is the
    // morning of the 22nd local, which is 12:00 UTC.
    const newYork = spec({ cadence: "daily", timezone: "America/New_York" });
    expect(nextOccurrence(newYork, at("2026-09-21T23:00:00Z")).toISOString()).toBe(
      "2026-09-22T12:00:00.000Z",
    );
  });
});

describe("nextOccurrence, weekly", () => {
  it("snaps forward to the requested day of week", () => {
    // 23 September 2026 is a Wednesday; the next Monday is the 28th.
    const monday = spec({ cadence: "weekly", dayOfWeek: 1, hourUtc: 9 });
    expect(nextOccurrence(monday, at("2026-09-23T10:00:00Z")).toISOString()).toBe(
      "2026-09-28T09:00:00.000Z",
    );
  });

  it("takes today when today is the day and the hour is ahead", () => {
    // 22 September 2026 is a Tuesday.
    const tuesday = spec({ cadence: "weekly", dayOfWeek: 2, hourUtc: 9 });
    expect(nextOccurrence(tuesday, at("2026-09-22T08:00:00Z")).toISOString()).toBe(
      "2026-09-22T09:00:00.000Z",
    );
  });

  it("rolls a whole week when today's slot has gone", () => {
    const tuesday = spec({ cadence: "weekly", dayOfWeek: 2, hourUtc: 9 });
    expect(nextOccurrence(tuesday, at("2026-09-22T10:00:00Z")).toISOString()).toBe(
      "2026-09-29T09:00:00.000Z",
    );
  });

  it("defaults to Monday when no day is stored", () => {
    const noDay = spec({ cadence: "weekly", dayOfWeek: null, hourUtc: 9 });
    expect(nextOccurrence(noDay, at("2026-09-23T10:00:00Z")).toISOString()).toBe(
      "2026-09-28T09:00:00.000Z",
    );
  });

  it("handles Sunday, which is day 0", () => {
    const sunday = spec({ cadence: "weekly", dayOfWeek: 0, hourUtc: 9 });
    expect(nextOccurrence(sunday, at("2026-09-23T10:00:00Z")).toISOString()).toBe(
      "2026-09-27T09:00:00.000Z",
    );
  });
});

describe("nextOccurrence, monthly", () => {
  it("takes this month when the day is still ahead", () => {
    const fifteenth = spec({ cadence: "monthly", dayOfMonth: 15, hourUtc: 6 });
    expect(nextOccurrence(fifteenth, at("2026-09-01T00:00:00Z")).toISOString()).toBe(
      "2026-09-15T06:00:00.000Z",
    );
  });

  it("rolls to next month once the day has gone", () => {
    const fifteenth = spec({ cadence: "monthly", dayOfMonth: 15, hourUtc: 6 });
    expect(nextOccurrence(fifteenth, at("2026-09-22T00:00:00Z")).toISOString()).toBe(
      "2026-10-15T06:00:00.000Z",
    );
  });

  it("rolls across the year boundary", () => {
    const fifteenth = spec({ cadence: "monthly", dayOfMonth: 15, hourUtc: 6 });
    expect(nextOccurrence(fifteenth, at("2026-12-20T00:00:00Z")).toISOString()).toBe(
      "2027-01-15T06:00:00.000Z",
    );
  });

  it("defaults to the first of the month", () => {
    const first = spec({ cadence: "monthly", dayOfMonth: null, hourUtc: 6 });
    expect(nextOccurrence(first, at("2026-09-22T00:00:00Z")).toISOString()).toBe(
      "2026-10-01T06:00:00.000Z",
    );
  });

  it("exists in February, because the schema caps the day at 28", () => {
    const twentyEighth = spec({ cadence: "monthly", dayOfMonth: 28, hourUtc: 6 });
    expect(nextOccurrence(twentyEighth, at("2026-02-01T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T06:00:00.000Z",
    );
  });
});

describe("nextOccurrence, daylight saving", () => {
  it("fires at the first valid instant after a nonexistent New York hour", () => {
    // Clocks go from 01:59:59 EST to 03:00:00 EDT on 8 March 2026, so 02:00
    // local never happens. The first valid instant after it is 07:00 UTC.
    const twoAm = spec({ cadence: "daily", hourUtc: 2, timezone: "America/New_York" });
    expect(nextOccurrence(twoAm, at("2026-03-07T12:00:00Z")).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  it("takes the first of two ambiguous New York hours", () => {
    // 01:00 local happens twice on 1 November 2026: 05:00 UTC on daylight time
    // and 06:00 UTC on standard time. The earlier one wins.
    const oneAm = spec({ cadence: "daily", hourUtc: 1, timezone: "America/New_York" });
    expect(nextOccurrence(oneAm, at("2026-10-31T12:00:00Z")).toISOString()).toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });

  it("fires at the first valid instant after a nonexistent London hour", () => {
    // Clocks go from 00:59:59 GMT to 02:00:00 BST on 29 March 2026.
    const oneAm = spec({ cadence: "daily", hourUtc: 1, timezone: "Europe/London" });
    expect(nextOccurrence(oneAm, at("2026-03-28T12:00:00Z")).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });

  it("takes the first of two ambiguous London hours", () => {
    // 01:00 local happens twice on 25 October 2026: 00:00 UTC on BST and 01:00
    // UTC on GMT.
    const oneAm = spec({ cadence: "daily", hourUtc: 1, timezone: "Europe/London" });
    expect(nextOccurrence(oneAm, at("2026-10-24T12:00:00Z")).toISOString()).toBe(
      "2026-10-25T00:00:00.000Z",
    );
  });

  it("keeps the local hour steady across a daylight change", () => {
    const nineAm = spec({ cadence: "daily", hourUtc: 9, timezone: "America/New_York" });
    const before = nextOccurrence(nineAm, at("2026-03-06T12:00:00Z"));
    const after = nextOccurrence(nineAm, at("2026-03-09T12:00:00Z"));

    const reader = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    });
    expect(reader.format(before)).toBe("09");
    expect(reader.format(after)).toBe("09");
    // The same wall clock hour, a different UTC hour.
    expect(before.getUTCHours()).toBe(14);
    expect(after.getUTCHours()).toBe(13);
  });
});

describe("enqueueScheduledRuns", () => {
  let db: Driver;

  beforeEach(() => {
    db = freshDb();
    seedProject(db);
  });

  afterEach(() => {
    db.close();
  });

  function addSchedule(
    id: string,
    projectId: string,
    nextRunAt: string,
    isActive: 0 | 1 = 1,
  ): void {
    db.prepare(
      `INSERT INTO schedules (id, project_id, cadence, hour_utc, timezone, is_active, next_run_at)
       VALUES (?, ?, 'daily', 8, 'UTC', ?, ?)`,
    ).run(id, projectId, isActive, nextRunAt);
  }

  function scheduleOf(id: string): ScheduleRow {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get<ScheduleRow>(id);
    if (!row) throw new Error("no schedule");
    return row;
  }

  function runs(): RunRow[] {
    return db.prepare("SELECT * FROM runs").all<RunRow>();
  }

  it("fires a due schedule and stamps the run as scheduled", () => {
    addSchedule("s1", "p1", "2026-09-22T08:00:00.000Z");

    const summary = enqueueScheduledRuns(db, at("2026-09-22T08:00:30Z"));

    expect(summary).toEqual({ created: 1, skipped: 0 });
    const created = runs();
    expect(created).toHaveLength(1);
    expect(created[0]?.trigger).toBe("scheduled");
    expect(JSON.parse(created[0]?.config_snapshot ?? "{}")).toEqual({ scheduled: true });
  });

  it("advances next_run_at from now, so three missed days fire once", () => {
    addSchedule("s1", "p1", "2026-09-19T08:00:00.000Z");
    const now = at("2026-09-22T12:00:00Z");

    expect(enqueueScheduledRuns(db, now)).toEqual({ created: 1, skipped: 0 });

    // The two intermediate occurrences are not backfilled.
    expect(scheduleOf("s1").next_run_at).toBe("2026-09-23T08:00:00.000Z");
    expect(enqueueScheduledRuns(db, now)).toEqual({ created: 0, skipped: 0 });
    expect(runs()).toHaveLength(1);
  });

  it("records last_run_at and clears the previous skip reason on success", () => {
    addSchedule("s1", "p1", "2026-09-22T08:00:00.000Z");
    db.prepare(
      "UPDATE schedules SET last_skip_reason = 'stale', last_skipped_at = '2026-09-01T00:00:00.000Z' WHERE id = 's1'",
    ).run();

    enqueueScheduledRuns(db, at("2026-09-22T09:00:00Z"));
    const schedule = scheduleOf("s1");

    expect(schedule.last_run_at).toBe("2026-09-22T09:00:00.000Z");
    expect(schedule.last_skip_reason).toBeNull();
    expect(schedule.last_skipped_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("suppresses an occurrence while the project already has a run going", () => {
    addSchedule("s1", "p1", "2026-09-22T08:00:00.000Z");
    db.prepare(
      "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('busy','p1','running',2,'{}')",
    ).run();

    const summary = enqueueScheduledRuns(db, at("2026-09-22T09:00:00Z"));
    const schedule = scheduleOf("s1");

    expect(summary).toEqual({ created: 0, skipped: 1 });
    expect(runs()).toHaveLength(1);
    expect(schedule.last_skip_reason).toBe(SKIPPED_OVERLAP);
    expect(schedule.last_skipped_at).toBe("2026-09-22T09:00:00.000Z");
    expect(schedule.last_run_at).toBeNull();
    // The advance still happens, so the schedule does not retry every tick.
    expect(schedule.next_run_at).toBe("2026-09-23T08:00:00.000Z");
  });

  it("suppresses an occurrence while a queued run is waiting too", () => {
    addSchedule("s1", "p1", "2026-09-22T08:00:00.000Z");
    db.prepare(
      "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('busy','p1','queued',2,'{}')",
    ).run();

    expect(enqueueScheduledRuns(db, at("2026-09-22T09:00:00Z")).skipped).toBe(1);
  });

  it("fires again once the previous run has finished", () => {
    addSchedule("s1", "p1", "2026-09-22T08:00:00.000Z");
    db.prepare(
      "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('old','p1','completed',2,'{}')",
    ).run();

    expect(enqueueScheduledRuns(db, at("2026-09-22T09:00:00Z")).created).toBe(1);
  });

  it("records a failure instead of raising it, and carries on to the next schedule", () => {
    seedProject(db, {
      id: "p2",
      name: "Northwind Metrics",
      prompts: [{ id: "p2-q1", text: "top search platforms" }],
    });
    addSchedule("s1", "p1", "2026-09-22T08:00:00.000Z");
    addSchedule("s2", "p2", "2026-09-22T08:00:00.000Z");

    const failing = (_db: Driver, projectId: string, opts: CreateRunOptions): string => {
      if (projectId === "p1") throw new Error("NO_PROMPTS: add at least one active prompt");
      db.prepare(
        "INSERT INTO runs (id, project_id, trigger, status, planned_calls, config_snapshot) VALUES ('ok', ?, ?, 'queued', 2, '{}')",
      ).run(projectId, opts.trigger ?? "manual");
      return "ok";
    };

    const summary = enqueueScheduledRuns(db, at("2026-09-22T09:00:00Z"), failing);

    expect(summary).toEqual({ created: 1, skipped: 1 });
    expect(scheduleOf("s1").last_skip_reason).toMatch(/NO_PROMPTS/);
    expect(scheduleOf("s1").next_run_at).toBe("2026-09-23T08:00:00.000Z");
    expect(scheduleOf("s2").last_skip_reason).toBeNull();
  });

  it("ignores a schedule that is not due, and one that is switched off", () => {
    addSchedule("s1", "p1", "2026-09-23T08:00:00.000Z");
    seedProject(db, {
      id: "p2",
      name: "Northwind Metrics",
      prompts: [{ id: "p2-q1", text: "top search platforms" }],
    });
    addSchedule("s2", "p2", "2026-09-01T08:00:00.000Z", 0);

    expect(enqueueScheduledRuns(db, at("2026-09-22T09:00:00Z"))).toEqual({
      created: 0,
      skipped: 0,
    });
    expect(runs()).toHaveLength(0);
  });
});
