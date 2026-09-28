/**
 * How application code gets a database handle.
 *
 * `driver.getDb()` already holds the open connection on globalThis so a dev
 * hot reload does not open a second one. This module adds the rest of what
 * "ready to use" means, once per process: migrations applied, model catalogue
 * seeded. A second call returns the same handle and touches nothing.
 */
import { getDb as getRawDb, type Driver } from "./driver";
import { migrate } from "./migrate";
import { seedModels } from "./seed-models";

const READY_KEY = Symbol.for("overheard.db.ready");

type ReadyGlobal = typeof globalThis & { [READY_KEY]?: Driver };

/** A migrated, seeded handle. Safe to call on every request. */
export function getDb(): Driver {
  const holder = globalThis as ReadyGlobal;
  const db = getRawDb();

  // Compared by identity, not by a boolean, so closing and reopening the handle
  // re-prepares the new one instead of silently skipping it.
  if (holder[READY_KEY] !== db) {
    prepare(db);
    holder[READY_KEY] = db;
  }

  return db;
}

/** Migrate and seed an arbitrary handle. Used by getDb and by tests. */
export function prepare(db: Driver): void {
  migrate(db);
  seedModels(db);
}
