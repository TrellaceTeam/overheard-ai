/**
 * Schedules: one per project, and the next time it will fire.
 *
 * next_run_at is computed on save, on the server, by the same nextOccurrence
 * the sweep uses, so the card and the sweep agree across a daylight-saving
 * boundary.
 *
 * hour_utc is the local hour in `timezone`, not a UTC hour, despite its name.
 */
import { stripCode } from "../../../lib/error-text";
import type { Driver } from "../../db/driver";
import type { Cadence, ScheduleRow } from "../../db/types";
import { nextOccurrence, specOf } from "../../logic/scheduler";
import {
  expectChanged,
  InvalidInputError,
  newId,
  nowIso,
  refuseDemoProject,
  toSqlBool,
} from "./shared";

export interface ScheduleView {
  id: string;
  projectId: string;
  cadence: Cadence;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourUtc: number;
  timezone: string;
  isActive: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastSkipReason: string | null;
  lastSkippedAt: string | null;
}

function toView(row: ScheduleRow): ScheduleView {
  return {
    id: row.id,
    projectId: row.project_id,
    cadence: row.cadence,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    hourUtc: row.hour_utc,
    timezone: row.timezone,
    isActive: row.is_active === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    // Skip reasons are stored with a machine prefix like every other refusal,
    // so the code is stripped before the card shows it.
    lastSkipReason: row.last_skip_reason === null ? null : stripCode(row.last_skip_reason),
    lastSkippedAt: row.last_skipped_at,
  };
}

/** The project's schedule, or null when it has never had one. */
export function getSchedule(db: Driver, projectId: string): ScheduleView | null {
  const row = db
    .prepare("SELECT * FROM schedules WHERE project_id = ?")
    .get<ScheduleRow>(projectId);
  return row ? toView(row) : null;
}

export interface SaveScheduleInput {
  projectId: string;
  cadence: Cadence;
  /** 0 is Sunday. Read only for a weekly schedule. */
  dayOfWeek?: number | null | undefined;
  /** 1 to 28, so a monthly schedule exists in every month. Defaults to 1. */
  dayOfMonth?: number | null | undefined;
  /** The hour of day in `timezone`, 0 to 23. */
  hourUtc: number;
  timezone: string;
  isActive?: boolean | undefined;
}

/**
 * Create or replace the project's schedule and compute when it next fires. A
 * UNIQUE constraint on schedules.project_id keeps it to one row per project.
 */
export function saveSchedule(
  db: Driver,
  input: SaveScheduleInput,
): { ok: true; nextRunAt: string } {
  refuseDemoProject(db, input.projectId);
  assertTimezone(input.timezone);
  if (!Number.isInteger(input.hourUtc) || input.hourUtc < 0 || input.hourUtc > 23) {
    throw new InvalidInputError("BAD_HOUR", "pick an hour between 0 and 23");
  }

  // Days that the cadence does not read are stored null, so a row never carries
  // a day that nothing uses and nobody can see in the card.
  const dayOfWeek = input.cadence === "weekly" ? clampDayOfWeek(input.dayOfWeek ?? 1) : null;
  const dayOfMonth = input.cadence === "monthly" ? clampDayOfMonth(input.dayOfMonth ?? 1) : null;
  const isActive = input.isActive ?? true;

  const nextRunAt = nextOccurrence({
    cadence: input.cadence,
    dayOfWeek,
    dayOfMonth,
    hourUtc: input.hourUtc,
    timezone: input.timezone,
  }).toISOString();

  const existing = db
    .prepare("SELECT id FROM schedules WHERE project_id = ?")
    .get<{ id: string }>(input.projectId);

  if (existing) {
    db.prepare(
      `UPDATE schedules
          SET cadence = ?, day_of_week = ?, day_of_month = ?, hour_utc = ?,
              timezone = ?, is_active = ?, next_run_at = ?
        WHERE id = ?`,
    ).run(
      input.cadence,
      dayOfWeek,
      dayOfMonth,
      input.hourUtc,
      input.timezone,
      toSqlBool(isActive),
      nextRunAt,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO schedules
         (id, project_id, cadence, day_of_week, day_of_month, hour_utc, timezone,
          is_active, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      input.projectId,
      input.cadence,
      dayOfWeek,
      dayOfMonth,
      input.hourUtc,
      input.timezone,
      toSqlBool(isActive),
      nextRunAt,
      nowIso(),
    );
  }

  return { ok: true, nextRunAt };
}

/**
 * Switch the schedule off without forgetting it.
 *
 * next_run_at is left where it is. The sweep reads is_active first, so a
 * dormant row cannot fire, and switching it back on shows the user the time
 * they set rather than a blank.
 */
export function disableSchedule(db: Driver, projectId: string): { ok: true } {
  refuseDemoProject(db, projectId);
  const changes = db
    .prepare("UPDATE schedules SET is_active = 0 WHERE project_id = ?")
    .run(projectId).changes;
  expectChanged(changes, "SCHEDULE_NOT_FOUND", "this project has no schedule");
  return { ok: true };
}

export interface NextOccurrenceInput {
  cadence: Cadence;
  dayOfWeek?: number | null | undefined;
  dayOfMonth?: number | null | undefined;
  hourUtc: number;
  timezone: string;
  /** ISO-8601. Defaults to now. Present so the preview is testable. */
  from?: string | undefined;
}

/**
 * When a schedule with these settings would next fire. Pure: nothing is written,
 * so the card can preview a change the user has not saved.
 */
export function previewNextOccurrence(input: NextOccurrenceInput): { nextRunAt: string } {
  assertTimezone(input.timezone);
  const from = input.from ? new Date(input.from) : new Date();
  if (Number.isNaN(from.getTime())) {
    throw new InvalidInputError("BAD_DATE", "that is not a date");
  }
  const next = nextOccurrence(
    {
      cadence: input.cadence,
      dayOfWeek: input.cadence === "weekly" ? clampDayOfWeek(input.dayOfWeek ?? 1) : null,
      dayOfMonth: input.cadence === "monthly" ? clampDayOfMonth(input.dayOfMonth ?? 1) : null,
      hourUtc: input.hourUtc,
      timezone: input.timezone,
    },
    from,
  );
  return { nextRunAt: next.toISOString() };
}

/** The next fire time of the stored schedule, recomputed from now. */
export function nextRunPreviewFor(db: Driver, projectId: string): string | null {
  const row = db
    .prepare("SELECT * FROM schedules WHERE project_id = ?")
    .get<ScheduleRow>(projectId);
  if (!row) return null;
  return nextOccurrence(specOf(row)).toISOString();
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch {
    throw new InvalidInputError("BAD_TIMEZONE", `${timezone} is not a time zone name`);
  }
}

function clampDayOfWeek(value: number): number {
  return Math.min(6, Math.max(0, Math.round(value)));
}

function clampDayOfMonth(value: number): number {
  return Math.min(28, Math.max(1, Math.round(value)));
}
