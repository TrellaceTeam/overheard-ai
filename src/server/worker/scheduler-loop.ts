/**
 * The schedule timer: one tick at startup, then one every 60 seconds, each
 * asking the logic layer whether any schedule has come due. Only the running
 * process can notice a schedule, so schedules fire only while Overheard AI is
 * running, and a missed one runs once at the next launch. The catch-up rule
 * lives in enqueueScheduledRuns. This module owns only the clock.
 *
 * Held on globalThis for the same reason the worker loop is: a dev hot reload
 * re-imports the module, and two timers would create two runs for one schedule.
 */
import type { Driver } from "../db/driver";
import { enqueueScheduledRuns } from "../logic/scheduler";
import type { EnqueueSummary } from "../logic/types";
import { kickWorker } from "./loop";

/** ADR 0004: one tick at startup, then every 60 s. */
export const SCHEDULER_TICK_MS = 60_000;

interface SchedulerHandle {
  db: Driver;
  timer: ReturnType<typeof setTimeout> | null;
  /** Reentrancy guard. A sweep never overlaps itself. */
  running: boolean;
  stopped: boolean;
  lastSummary: EnqueueSummary | null;
  lastError: string | null;
}

const SCHEDULER_KEY = Symbol.for("overheard.scheduler");

type SchedulerGlobal = typeof globalThis & { [SCHEDULER_KEY]?: SchedulerHandle };

function held(): SchedulerHandle | undefined {
  return (globalThis as SchedulerGlobal)[SCHEDULER_KEY];
}

/**
 * Start the timer, or leave the running one alone. Idempotent, so boot() can be
 * called from more than one entry point without creating a second sweep.
 */
export function startScheduler(db: Driver): void {
  const existing = held();
  if (existing && !existing.stopped) return;

  const handle: SchedulerHandle = {
    db,
    timer: null,
    running: false,
    stopped: false,
    lastSummary: null,
    lastError: null,
  };
  (globalThis as SchedulerGlobal)[SCHEDULER_KEY] = handle;

  tick(handle);
}

/** Stop the timer and forget the handle. Used by tests and by shutdown. */
export function stopScheduler(): void {
  const handle = held();
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = null;
  delete (globalThis as SchedulerGlobal)[SCHEDULER_KEY];
}

/** Whether the sweep is live, for the Settings screen. */
export function schedulerStatus(): {
  running: boolean;
  lastSummary: EnqueueSummary | null;
  lastError: string | null;
} {
  const handle = held();
  return {
    running: Boolean(handle && !handle.stopped),
    lastSummary: handle?.lastSummary ?? null,
    lastError: handle?.lastError ?? null,
  };
}

/** Run one sweep now. Exported for the tests and for a manual nudge. */
export function schedulerTick(): EnqueueSummary | null {
  const handle = held();
  if (!handle || handle.stopped) return null;
  return sweep(handle);
}

function sweep(handle: SchedulerHandle): EnqueueSummary | null {
  // A sweep is synchronous, so this is only true for a tick fired from inside
  // a tick.
  if (handle.running) return null;
  handle.running = true;
  try {
    const summary = enqueueScheduledRuns(handle.db);
    handle.lastSummary = summary;
    handle.lastError = null;
    // Only wake the worker when there is something new to do. An empty sweep
    // must not drag the worker back to its 2 s tick.
    if (summary.created > 0) kickWorker();
    return summary;
  } catch (err) {
    // A sweep that throws is a bug, not a schedule failure: enqueueScheduledRuns
    // records a per-project failure itself and does not raise. The timer must
    // survive it.
    handle.lastError = err instanceof Error ? err.message : String(err);
    console.error("[scheduler] sweep failed", { message: handle.lastError });
    return null;
  } finally {
    handle.running = false;
  }
}

function tick(handle: SchedulerHandle): void {
  if (handle.stopped) return;
  sweep(handle);
  if (handle.stopped) return;
  handle.timer = setTimeout(() => {
    tick(handle);
  }, SCHEDULER_TICK_MS);
  // Do not hold the process open for a sweep that has nothing to do.
  handle.timer.unref?.();
}
