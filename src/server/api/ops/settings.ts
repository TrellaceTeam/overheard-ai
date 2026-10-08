/**
 * The application settings screen: which provider keys the environment holds,
 * whether they work, where the database file is and how big it has grown,
 * whether the worker and the schedule sweep are running, the install-wide
 * limits: the run size limit and each provider's calls in flight, whether the
 * icon rebuilds before it opens the app, and Quit.
 *
 * Nothing here returns a key value, a prefix or a length, so a screenshot of
 * the settings page can go into a bug report without redaction.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { shutdown } from "../../boot";
import { databasePathFromEnv, type Driver } from "../../db/driver";
import type { Provider } from "../../db/types";
import { DEFAULT_PROVIDER_CAPS } from "../../logic/claim-tasks";
import { effectiveCallLimit } from "../../logic/plan-run";
import { CALL_LIMIT_MAX, CALL_LIMIT_MIN, DEFAULT_MAX_PLANNED_CALLS } from "../../logic/types";
import { effectiveCaps, envCap, INFLIGHT_CAP_ENV } from "../../worker/concurrency";
import { keyStatus, type ProviderKeyStatus } from "../../worker/keys";
import { mockProvidersEnabled } from "../../worker/mock-provider";
import { workerStatus, type StartWorkerOptions } from "../../worker/loop";
import { getStoredCaps } from "../../worker/queries";
import { schedulerStatus } from "../../worker/scheduler-loop";
import { nowIso, toSqlBool } from "./shared";
import { INFLIGHT_CAP_MAX, INFLIGHT_CAP_MIN, isInflightCap } from "@/lib/inflight-caps";

export type { ProviderKeyStatus, StartWorkerOptions };

/** Which providers have a key, as booleans. Never a value. */
export function providerKeyStatus(): ProviderKeyStatus[] {
  return keyStatus();
}

export interface DatabaseInfo {
  /** Absolute, so a user can find the file to copy it. */
  path: string;
  /** Bytes, including the write-ahead log, or null when the file is in memory. */
  sizeBytes: number | null;
  exists: boolean;
  /** `node:sqlite` or `bun:sqlite`, whichever runtime opened it. */
  driverModule: string;
}

/**
 * Where the data lives and how big it is.
 *
 * The -wal and -shm files are counted because they are part of the database.
 * A backup that copies the .db and leaves the -wal behind can lose the most
 * recent run, so the size shown is the size of everything worth copying.
 */
export function databaseInfo(db: Driver): DatabaseInfo {
  const configured = databasePathFromEnv();
  const inMemory = configured === ":memory:" || configured.startsWith("file::memory:");
  const path = inMemory ? configured : resolve(configured);

  if (inMemory) {
    return { path, sizeBytes: null, exists: true, driverModule: db.driverModule };
  }

  let sizeBytes: number | null = null;
  let exists = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stats = statSync(`${path}${suffix}`);
      sizeBytes = (sizeBytes ?? 0) + stats.size;
      if (suffix === "") exists = true;
    } catch {
      // A missing -wal is normal, and a missing database file is what `exists`
      // reports rather than an error: the next write creates it.
    }
  }

  return { path, sizeBytes, exists, driverModule: db.driverModule };
}

export interface WorkerStatusView {
  running: boolean;
  lastPass: { processed: number; finalised: number } | null;
  scheduler: {
    running: boolean;
    lastSummary: { created: number; skipped: number } | null;
    lastError: string | null;
  };
  /** True when OVERHEARD_MOCK_PROVIDERS=1, so the screen can say so. */
  mockProviders: boolean;
}

/** The worker line on the settings screen. */
export function workerStatusView(): WorkerStatusView {
  const worker = workerStatus();
  return {
    running: worker.running,
    lastPass: worker.lastResult,
    scheduler: schedulerStatus(),
    mockProviders: mockProvidersEnabled(),
  };
}

export interface CallLimitView {
  /** The ceiling planRun refuses above, live from app_state. */
  limit: number;
  /** What Reset restores. Also the migration's column default. */
  defaultLimit: number;
}

/**
 * The run call ceiling the planner will use. It is the same read planRun does,
 * so the screen and the refusal message agree.
 */
export function callLimit(db: Driver): CallLimitView {
  return { limit: effectiveCallLimit(db), defaultLimit: DEFAULT_MAX_PLANNED_CALLS };
}

/**
 * Writes the ceiling. Validates first, so the caller gets a readable message
 * instead of a CHECK failure and a bad value never reaches the column. The
 * Reset button is `setCallLimit(db, callLimit(db).defaultLimit)`.
 */
export function setCallLimit(db: Driver, limit: number): { ok: true } {
  if (!Number.isInteger(limit) || limit < CALL_LIMIT_MIN || limit > CALL_LIMIT_MAX) {
    throw new Error(
      `CALL_LIMIT_INVALID: the limit must be a whole number between ${CALL_LIMIT_MIN} and ${CALL_LIMIT_MAX}`,
    );
  }
  const changes = db
    .prepare("UPDATE app_state SET max_planned_calls = ?, updated_at = ? WHERE id = 1")
    .run(limit, nowIso()).changes;
  if (changes === 0) {
    // Migration 0003 inserts the row, so this only runs on a database that
    // lost it. Inserting it here keeps the save from failing.
    db.prepare("INSERT INTO app_state (id, max_planned_calls, updated_at) VALUES (1, ?, ?)").run(
      limit,
      nowIso(),
    );
  }
  return { ok: true };
}

export interface InflightCapView {
  provider: Provider;
  /** What the next pass claims under: the variable, else the saved value, else the default. */
  effective: number;
  /** What Reset restores. */
  defaultCap: number;
  /** The value saved in Account settings, or null when none is. */
  stored: number | null;
  /** The variable that wins over the saved value when it holds a positive whole number. */
  envName: string;
  /** True when envName holds a valid value, so the field cannot change what applies. */
  envOverrides: boolean;
}

const CAP_COLUMN: Record<Provider, string> = {
  openai: "max_inflight_openai",
  anthropic: "max_inflight_anthropic",
  google: "max_inflight_google",
};

/**
 * Each provider's calls in flight, resolved the way the worker resolves them,
 * so the screen shows the caps the next pass applies.
 */
export function inflightCaps(db: Driver): InflightCapView[] {
  const stored = getStoredCaps(db);
  const effective = effectiveCaps(stored);
  return (Object.keys(CAP_COLUMN) as Provider[]).map((provider) => ({
    provider,
    effective: effective[provider],
    defaultCap: DEFAULT_PROVIDER_CAPS[provider],
    stored: stored[provider],
    envName: INFLIGHT_CAP_ENV[provider],
    envOverrides: envCap(provider) !== null,
  }));
}

/**
 * Saves one provider's cap, or clears it with null so the default applies.
 * Validates first, so the caller gets a readable message instead of a CHECK
 * failure. A saved value under a winning variable is kept, and applies once
 * the variable is gone.
 */
export function setInflightCap(db: Driver, provider: Provider, cap: number | null): { ok: true } {
  // The column name is interpolated, so only a known provider reaches the SQL.
  if (!Object.hasOwn(CAP_COLUMN, provider)) {
    throw new Error(`INFLIGHT_CAP_INVALID: no provider called ${String(provider)}`);
  }
  if (cap !== null && !isInflightCap(cap)) {
    throw new Error(
      `INFLIGHT_CAP_INVALID: the cap must be a whole number between ${INFLIGHT_CAP_MIN} and ${INFLIGHT_CAP_MAX}`,
    );
  }
  const column = CAP_COLUMN[provider];
  const changes = db
    .prepare(`UPDATE app_state SET ${column} = ?, updated_at = ? WHERE id = 1`)
    .run(cap, nowIso()).changes;
  if (changes === 0) {
    // Migration 0003 inserts the row, so this only runs on a database that
    // lost it.
    db.prepare(`INSERT INTO app_state (id, ${column}, updated_at) VALUES (1, ?, ?)`).run(
      cap,
      nowIso(),
    );
  }
  return { ok: true };
}

/**
 * Whether the icon rebuilds a stale build before starting the app. A missing
 * row reads as on, the column's default, which is also how server/index.mjs
 * reads anything it cannot find.
 */
export function rebuildOnOpen(db: Driver): { on: boolean } {
  const row = db
    .prepare("SELECT rebuild_on_open FROM app_state WHERE id = 1")
    .get<{ rebuild_on_open: number }>();
  return { on: row?.rebuild_on_open !== 0 };
}

export function setRebuildOnOpen(db: Driver, on: boolean): { ok: true } {
  const changes = db
    .prepare("UPDATE app_state SET rebuild_on_open = ?, updated_at = ? WHERE id = 1")
    .run(toSqlBool(on), nowIso()).changes;
  if (changes === 0) {
    // Migration 0003 inserts the row, so this only runs on a database that
    // lost it.
    db.prepare("INSERT INTO app_state (id, rebuild_on_open, updated_at) VALUES (1, ?, ?)").run(
      toSqlBool(on),
      nowIso(),
    );
  }
  return { ok: true };
}

/** Long enough for the reply to reach the browser before the process goes. */
export const QUIT_DELAY_MS = 300;

/**
 * Stops this process, for the menu's Quit. It is the only way to stop an
 * Overheard AI the icon started, because that one has no console to press
 * Ctrl-C in. A call in flight is abandoned and boot recovery requeues it next
 * time, the same guarantee Ctrl-C gives.
 */
export function quit(): { ok: true } {
  setTimeout(() => {
    shutdown();
    process.exit(0);
  }, QUIT_DELAY_MS);
  return { ok: true };
}
