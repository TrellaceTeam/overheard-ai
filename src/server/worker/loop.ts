/**
 * The in-process worker loop: one per database file, started once at server
 * boot. It ticks every 2 s while there is claimable work, backs off to 15 s
 * when a pass finds nothing, and wakes immediately when a run is created.
 *
 * Held on globalThis for the same reason the database handle is: a dev hot
 * reload re-imports the module and would otherwise leave two loops claiming
 * from the same queue.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import { bootRecovery } from "../logic/recovery";
import { runWorkerPass, type WorkerPassResult } from "./pass";

/** While work is arriving, a short tick keeps a run moving. */
export const ACTIVE_TICK_MS = 2_000;

/** Idle, a long tick keeps a laptop quiet. A kick short-circuits it anyway. */
export const IDLE_TICK_MS = 15_000;

/**
 * The stamp written into run_tasks.locked_by by every claim this process makes.
 *
 * Process id plus a boot id, because the operating system reuses process ids.
 * Rows left locked by a crashed process would otherwise read as this
 * process's own when the id comes round again.
 */
export const WORKER_ID = `pid${process.pid}-${randomUUID().slice(0, 8)}`;

interface WorkerHandle {
  db: Driver;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
  /** Set by kick() while a pass is in flight, so the wake is not lost. */
  pendingKick: boolean;
  lastResult: WorkerPassResult | null;
}

const WORKER_KEY = Symbol.for("overheard.worker");

type WorkerGlobal = typeof globalThis & { [WORKER_KEY]?: WorkerHandle };

function held(): WorkerHandle | undefined {
  return (globalThis as WorkerGlobal)[WORKER_KEY];
}

export interface StartWorkerOptions {
  /** Budget for one pass. The loop yields between passes regardless. */
  budgetMs?: number;
}

/**
 * Start the loop, or return the running one. Idempotent: calling it twice with
 * the same handle does nothing the second time.
 *
 * Boot recovery runs once, before the first pass. No call from this process can
 * be in flight at boot, so every locked task is released regardless of how
 * recently it was locked.
 */
export function startWorker(db: Driver, options: StartWorkerOptions = {}): void {
  const existing = held();
  if (existing && !existing.stopped) return;

  const handle: WorkerHandle = {
    db,
    timer: null,
    running: false,
    stopped: false,
    pendingKick: false,
    lastResult: null,
  };
  (globalThis as WorkerGlobal)[WORKER_KEY] = handle;

  bootRecovery(db);
  void tick(handle, options.budgetMs);
}

/** Stop the loop and forget the handle. Used by tests and by shutdown. */
export function stopWorker(): void {
  const handle = held();
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = null;
  delete (globalThis as WorkerGlobal)[WORKER_KEY];
}

/**
 * Wake the loop now rather than at the next tick. Run creation calls this, so
 * the Run button is followed by work starting rather than by a wait.
 */
export function kickWorker(): void {
  const handle = held();
  if (!handle || handle.stopped) return;
  if (handle.running) {
    // A pass is already in flight. Remember the kick so the next schedule is
    // immediate instead of the idle interval.
    handle.pendingKick = true;
    return;
  }
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = null;
  void tick(handle);
}

/** Whether a loop is running, for the Settings screen's worker status line. */
export function workerStatus(): { running: boolean; lastResult: WorkerPassResult | null } {
  const handle = held();
  return {
    running: Boolean(handle && !handle.stopped),
    lastResult: handle?.lastResult ?? null,
  };
}

async function tick(handle: WorkerHandle, budgetMs?: number): Promise<void> {
  if (handle.stopped || handle.running) return;
  handle.running = true;
  let processed = 0;
  try {
    const result = await runWorkerPass(
      handle.db,
      budgetMs === undefined ? { lockedBy: WORKER_ID } : { budgetMs, lockedBy: WORKER_ID },
    );
    handle.lastResult = result;
    processed = result.processed;
  } catch (err) {
    // A pass that throws is a bug, not a task failure, and must not stop the
    // loop: the next tick starts clean.
    console.error("[worker] pass failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    handle.running = false;
  }

  if (handle.stopped) return;

  const kicked = handle.pendingKick;
  handle.pendingKick = false;
  const delay = kicked || processed > 0 ? ACTIVE_TICK_MS : IDLE_TICK_MS;
  handle.timer = setTimeout(() => {
    void tick(handle, budgetMs);
  }, delay);
  // Do not hold the process open for a tick that has nothing to do.
  handle.timer.unref?.();
}
