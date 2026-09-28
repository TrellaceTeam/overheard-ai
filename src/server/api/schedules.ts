/**
 * The schedule server functions: read it, save it, switch it off, and preview
 * when a set of settings would next fire.
 *
 * The preview writes nothing, so the card can show the effect of a change the
 * user has not committed to yet.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const projectId = z.object({ projectId: z.string().min(1) });
const cadence = z.enum(["daily", "weekly", "monthly"]);

const saveScheduleInput = z.object({
  projectId: z.string().min(1),
  cadence,
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  hourUtc: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(100),
  isActive: z.boolean().optional(),
});

const previewInput = z.object({
  cadence,
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  hourUtc: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(100),
  from: z.string().max(40).optional(),
});

export const getSchedule = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { getSchedule: op } = await import("./ops/schedules");
    return op(getDb(), data.projectId);
  });

/** Create or replace the schedule, and compute when it next fires. */
export const saveSchedule = createServerFn({ method: "POST" })
  .validator((data: unknown) => saveScheduleInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { saveSchedule: op } = await import("./ops/schedules");
    return op(getDb(), data);
  });

/** Switch the schedule off without forgetting the settings. */
export const disableSchedule = createServerFn({ method: "POST" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { disableSchedule: op } = await import("./ops/schedules");
    return op(getDb(), data.projectId);
  });

/** When these settings would next fire. Pure: nothing is written. */
export const nextOccurrence = createServerFn({ method: "GET" })
  .validator((data: unknown) => previewInput.parse(data))
  .handler(async ({ data }) => {
    const { previewNextOccurrence } = await import("./ops/schedules");
    return previewNextOccurrence(data);
  });
