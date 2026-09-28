/**
 * When a schedule fires next, and firing the ones that are due.
 *
 * There is no cron expression: a cadence plus a day and an hour, resolved in a
 * named timezone with Intl.DateTimeFormat. DST rule, both tested: a local hour
 * that does not exist fires at the first valid instant after it, and an
 * ambiguous local hour takes the first of its two occurrences.
 */
import type { Driver } from "../db/driver";
import type { ScheduleRow } from "../db/types";
import type { EnqueueSummary, ScheduleSpec } from "./types";
import { createRun } from "./create-run";
import type { CreateRunOptions } from "./types";

const SWEEP_LIMIT = 100;

export const SKIPPED_OVERLAP =
  "SKIPPED_OVERLAP: the previous run for this project was still running.";

const DAY_MS = 86_400_000;

/** A wall clock reading with no zone attached, like a SQL `timestamp`. */
interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(timezone, found);
  }
  return found;
}

/** The wall clock a person in `timezone` reads at this instant. */
export function localTimeIn(instant: Date, timezone: string): LocalTime {
  const parts = formatter(timezone).formatToParts(instant);
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Intl writes hour 24 for midnight in some locales even under h23.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
    millisecond: instant.getUTCMilliseconds(),
  };
}

/**
 * The wall clock as a number, so two local times compare directly. It is not
 * an instant and must never be used as one.
 */
function localMillis(local: LocalTime): number {
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.millisecond,
  );
}

/** Offset of `timezone` at this instant, in milliseconds east of UTC. */
function offsetAt(instant: number, timezone: string): number {
  return localMillis(localTimeIn(new Date(instant), timezone)) - instant;
}

/**
 * The instant at which `timezone` reads this wall clock.
 *
 * Two candidates are built from the offsets a day either side. When both are
 * valid the local time is ambiguous, which happens on a fall-back day, and the
 * earlier one wins. When neither is valid the local time does not exist, which
 * happens on a spring-forward day, and the later one wins, which is the first
 * valid instant after the gap.
 */
export function instantOf(local: LocalTime, timezone: string): Date {
  const wall = localMillis(local);
  const before = wall - offsetAt(wall - DAY_MS, timezone);
  const after = wall - offsetAt(wall + DAY_MS, timezone);

  const valid = [before, after].filter(
    (candidate) => localMillis(localTimeIn(new Date(candidate), timezone)) === wall,
  );
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(Math.max(before, after));
}

function dayOfWeekOf(local: LocalTime): number {
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
}

/** Adds whole days to a wall clock, which cannot overflow a DST boundary. */
function addDays(local: LocalTime, days: number): LocalTime {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day) + days * DAY_MS);
  return {
    ...local,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function atHour(local: LocalTime, hour: number): LocalTime {
  return { ...local, hour, minute: 0, second: 0, millisecond: 0 };
}

/**
 * The first occurrence strictly after `from`. Everything is computed on the
 * schedule's local wall clock and converted to an instant once, at the end.
 */
export function nextOccurrence(spec: ScheduleSpec, from: Date = new Date()): Date {
  const now = localTimeIn(from, spec.timezone);
  const nowMillis = localMillis(now);
  let candidate = atHour(now, spec.hourUtc);

  if (spec.cadence === "daily") {
    if (localMillis(candidate) <= nowMillis) candidate = addDays(candidate, 1);
  } else if (spec.cadence === "weekly") {
    const wanted = spec.dayOfWeek ?? 1;
    candidate = addDays(candidate, (wanted - dayOfWeekOf(candidate) + 7) % 7);
    if (localMillis(candidate) <= nowMillis) candidate = addDays(candidate, 7);
  } else {
    // day_of_month is capped at 28 by the schema, so every month has this day.
    const day = spec.dayOfMonth ?? 1;
    candidate = atHour({ ...now, day }, spec.hourUtc);
    if (localMillis(candidate) <= nowMillis) {
      const month = now.month === 12 ? 1 : now.month + 1;
      const year = now.month === 12 ? now.year + 1 : now.year;
      candidate = atHour({ ...now, year, month, day }, spec.hourUtc);
    }
  }

  return instantOf(candidate, spec.timezone);
}

/** The spec a stored schedule row describes. */
export function specOf(row: ScheduleRow): ScheduleSpec {
  return {
    cadence: row.cadence,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    hourUtc: row.hour_utc,
    timezone: row.timezone,
  };
}

/** The run creator the sweep calls. Swappable so a test can watch the calls. */
export type CreateRunFn = (db: Driver, projectId: string, opts: CreateRunOptions) => string;

function projectIsBusy(db: Driver, projectId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS busy FROM runs WHERE project_id = ? AND status IN ('queued','running') LIMIT 1",
    )
    .get<{ busy: number }>(projectId);
  return row !== undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a run for every active schedule whose next_run_at has passed, capped
 * at SWEEP_LIMIT per call. The query excludes the demo project, whose history
 * is generated and must stay as shipped. A project that already has a queued
 * or running run is skipped with SKIPPED_OVERLAP. next_run_at always advances,
 * computed from now and not from the missed occurrence, so downtime produces
 * one catch-up run and not a backlog, and a failing project cannot spin. A
 * failure is recorded in last_skip_reason, never raised: one bad project must
 * not abort the sweep.
 */
export function enqueueScheduledRuns(
  db: Driver,
  now: Date = new Date(),
  createRunFn: CreateRunFn = createRun,
): EnqueueSummary {
  const stamp = now.toISOString();
  const due = db
    .prepare(
      `SELECT s.* FROM schedules s
         JOIN projects p ON p.id = s.project_id
        WHERE s.is_active = 1 AND s.next_run_at <= ? AND p.is_demo = 0
        ORDER BY s.next_run_at
        LIMIT ?`,
    )
    .all<ScheduleRow>(stamp, SWEEP_LIMIT);

  let created = 0;
  let skipped = 0;

  for (const schedule of due) {
    const advanced = db.immediateTransaction(() => {
      // Claim the occurrence first. Zero rows changed means another process took
      // it between the read above and this write, so this tick leaves it alone.
      const claimed = db
        .prepare("UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?")
        .run(
          nextOccurrence(specOf(schedule), now).toISOString(),
          schedule.id,
          schedule.next_run_at,
        ).changes;
      if (claimed === 0) return false;

      let reason: string | null = null;
      if (projectIsBusy(db, schedule.project_id)) {
        reason = SKIPPED_OVERLAP;
      } else {
        try {
          createRunFn(db, schedule.project_id, {
            trigger: "scheduled",
            configSnapshot: { scheduled: true },
          });
        } catch (error) {
          reason = messageOf(error);
        }
      }

      // last_run_at moves only on success, last_skipped_at only on a skip or a
      // failure, and last_skip_reason is cleared by a success.
      db.prepare(
        `UPDATE schedules
            SET last_run_at = CASE WHEN ? IS NULL THEN ? ELSE last_run_at END,
                last_skip_reason = ?,
                last_skipped_at = CASE WHEN ? IS NULL THEN last_skipped_at ELSE ? END
          WHERE id = ?`,
      ).run(reason, stamp, reason, reason, stamp, schedule.id);

      if (reason === null) created += 1;
      else skipped += 1;
      return true;
    });

    if (!advanced) continue;
  }

  return { created, skipped };
}
