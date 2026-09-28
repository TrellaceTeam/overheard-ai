import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, seedProject } from "../../logic/test-support";
import {
  disableSchedule,
  getSchedule,
  nextRunPreviewFor,
  previewNextOccurrence,
  saveSchedule,
} from "./schedules";

// Nullable, because the two pure preview tests never open a database.
let db: Driver | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function open(): Driver {
  db = freshDb();
  seedProject(db);
  return db;
}

describe("saveSchedule", () => {
  it("creates the row and computes when it next fires", () => {
    const db = open();
    const result = saveSchedule(db, {
      projectId: "p1",
      cadence: "weekly",
      dayOfWeek: 1,
      hourUtc: 8,
      timezone: "UTC",
    });

    const stored = getSchedule(db, "p1");
    expect(stored).toMatchObject({
      cadence: "weekly",
      dayOfWeek: 1,
      dayOfMonth: null,
      hourUtc: 8,
      timezone: "UTC",
      isActive: true,
      nextRunAt: result.nextRunAt,
    });
    expect(new Date(result.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("replaces the one row rather than adding a second", () => {
    const db = open();
    saveSchedule(db, {
      projectId: "p1",
      cadence: "weekly",
      dayOfWeek: 1,
      hourUtc: 8,
      timezone: "UTC",
    });
    saveSchedule(db, { projectId: "p1", cadence: "daily", hourUtc: 9, timezone: "UTC" });

    const rows = db
      .prepare("SELECT count(*) AS n FROM schedules WHERE project_id = 'p1'")
      .get<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(getSchedule(db, "p1")).toMatchObject({ cadence: "daily", hourUtc: 9, dayOfWeek: null });
  });

  it("stores the day the cadence reads and nulls the one it does not", () => {
    const db = open();
    saveSchedule(db, {
      projectId: "p1",
      cadence: "monthly",
      dayOfWeek: 4,
      hourUtc: 6,
      timezone: "Europe/London",
    });
    expect(getSchedule(db, "p1")).toMatchObject({ dayOfWeek: null, dayOfMonth: 1 });
  });

  it("refuses a time zone that is not one", () => {
    const db = open();
    expect(() =>
      saveSchedule(db, { projectId: "p1", cadence: "daily", hourUtc: 8, timezone: "Mars/Olympus" }),
    ).toThrow(/BAD_TIMEZONE/);
  });

  it("refuses an hour outside the day", () => {
    const db = open();
    expect(() =>
      saveSchedule(db, { projectId: "p1", cadence: "daily", hourUtc: 24, timezone: "UTC" }),
    ).toThrow(/BAD_HOUR/);
  });
});

describe("disableSchedule", () => {
  it("switches it off and keeps the settings", () => {
    const db = open();
    const saved = saveSchedule(db, {
      projectId: "p1",
      cadence: "daily",
      hourUtc: 8,
      timezone: "UTC",
    });
    disableSchedule(db, "p1");

    expect(getSchedule(db, "p1")).toMatchObject({
      isActive: false,
      hourUtc: 8,
      nextRunAt: saved.nextRunAt,
    });
  });

  it("says so when there is no schedule to switch off", () => {
    const db = open();
    expect(() => disableSchedule(db, "p1")).toThrow(/SCHEDULE_NOT_FOUND/);
  });
});

describe("previewNextOccurrence", () => {
  it("is pure: it answers without writing a row", () => {
    const db = open();
    const preview = previewNextOccurrence({
      cadence: "daily",
      hourUtc: 9,
      timezone: "UTC",
      from: "2026-03-01T10:00:00.000Z",
    });

    expect(preview.nextRunAt).toBe("2026-03-02T09:00:00.000Z");
    expect(getSchedule(db, "p1")).toBeNull();
  });

  it("reads the hour as a local hour in the given zone", () => {
    const summer = previewNextOccurrence({
      cadence: "daily",
      hourUtc: 9,
      timezone: "Europe/London",
      from: "2026-07-01T10:00:00.000Z",
    });
    // British Summer Time: 09:00 local is 08:00 UTC.
    expect(summer.nextRunAt).toBe("2026-07-02T08:00:00.000Z");
  });

  it("refuses a date that is not one", () => {
    expect(() =>
      previewNextOccurrence({ cadence: "daily", hourUtc: 9, timezone: "UTC", from: "not a date" }),
    ).toThrow(/BAD_DATE/);
  });
});

describe("nextRunPreviewFor", () => {
  it("recomputes the stored schedule from now, and is null without one", () => {
    const db = open();
    expect(nextRunPreviewFor(db, "p1")).toBeNull();

    saveSchedule(db, { projectId: "p1", cadence: "daily", hourUtc: 8, timezone: "UTC" });
    const preview = nextRunPreviewFor(db, "p1");
    expect(preview).toBe(getSchedule(db, "p1")?.nextRunAt);
  });
});
