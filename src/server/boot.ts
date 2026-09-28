/**
 * Everything that has to happen once before the first request is served, in the
 * order it has to happen in.
 *
 * getDb migrates and seeds. bootRecovery releases every lock left behind by a
 * process that died mid-run, which is safe only at boot, when no call from
 * this process can be in flight. Then the worker loop starts, and then the
 * schedule sweep, which needs the worker to exist so it can wake it.
 *
 * Idempotent and held on globalThis, because a dev hot reload re-imports the
 * module and the second boot must be a no-op, not a second worker.
 */
import { getDb } from "./db/client";
import { databasePathFromEnv, type Driver } from "./db/driver";
import { bootRecovery } from "./logic/recovery";
import { watchEnvFile } from "./worker/env-file";
import { configuredProviders } from "./worker/keys";
import { mockProvidersEnabled } from "./worker/mock-provider";
import { startWorker, stopWorker, workerStatus, WORKER_ID } from "./worker/loop";
import { startScheduler, schedulerStatus, stopScheduler } from "./worker/scheduler-loop";

export interface BootSummary {
  /** The lock stamp this process writes on every task it claims. */
  workerId: string;
  databasePath: string;
  driverModule: string;
  /** Tasks the previous process left locked, returned to a claimable status. */
  recovered: { requeued: number; returnedToAnswered: number; exhausted: number };
  providers: string[];
  mockProviders: boolean;
  /** Which timers this process is running, read back after starting. */
  loops: { worker: boolean; scheduler: boolean };
  bootedAt: string;
}

const BOOT_KEY = Symbol.for("overheard.boot");

type BootGlobal = typeof globalThis & { [BOOT_KEY]?: BootSummary };

export interface BootOptions {
  /** Injected by the tests. The running app always boots the real handle. */
  db?: Driver;
  /** Set false in a test that does not want a timer. Defaults to true. */
  startLoops?: boolean;
  /** Set false to boot quietly. The app logs one line. */
  log?: boolean;
  /**
   * The .env file to re-read provider keys from while running. Only the app
   * entry passes it, so no test reads a real .env.
   */
  envFile?: string;
}

/**
 * Start Overheard AI. Returns the summary, whether this call did the work or an
 * earlier one did.
 */
export function boot(options: BootOptions = {}): BootSummary {
  const holder = globalThis as BootGlobal;
  const already = holder[BOOT_KEY];
  if (already) return already;

  if (options.envFile) watchEnvFile(options.envFile);
  const db = options.db ?? getDb();
  const recovered = bootRecovery(db);

  if (options.startLoops !== false) {
    startWorker(db);
    startScheduler(db);
  }

  const summary: BootSummary = {
    workerId: WORKER_ID,
    databasePath: databasePathFromEnv(),
    driverModule: db.driverModule,
    recovered,
    providers: configuredProviders(),
    mockProviders: mockProvidersEnabled(),
    // Read back from the loops, not assumed from startLoops, so the log line
    // reports what is running.
    loops: { worker: workerStatus().running, scheduler: schedulerStatus().running },
    bootedAt: new Date().toISOString(),
  };
  holder[BOOT_KEY] = summary;

  if (options.log !== false) {
    // One line, and no key material in it: provider names only, never values.
    console.log(
      `[boot] Overheard AI ready db=${summary.databasePath} driver=${summary.driverModule} ` +
        `worker=${summary.workerId} providers=${summary.providers.join(",") || "none"} ` +
        `loops=${loopLabel(summary.loops)}` +
        (summary.mockProviders ? " mock-providers=on" : "") +
        ` recovered=${recovered.requeued}/${recovered.returnedToAnswered}/${recovered.exhausted}`,
    );
  }

  return summary;
}

function loopLabel(loops: BootSummary["loops"]): string {
  const live = [loops.worker ? "worker" : null, loops.scheduler ? "scheduler" : null].filter(
    (name): name is string => name !== null,
  );
  return live.join("+") || "off";
}

/** What boot() decided, or null when the process has not booted. */
export function bootSummary(): BootSummary | null {
  return (globalThis as BootGlobal)[BOOT_KEY] ?? null;
}

/** Stop the loops and forget the boot. For tests and for a clean shutdown. */
export function shutdown(): void {
  stopScheduler();
  stopWorker();
  delete (globalThis as BootGlobal)[BOOT_KEY];
}
