/**
 * The migration runner. Owns `_schema_migrations` and the rule that a migration
 * runs exactly once, in filename order, inside one transaction with the row that
 * records it. If the SQL throws, the version is not recorded and nothing is left
 * half applied.
 *
 * Migrations are read at build time through `import.meta.glob`, not from disk at
 * run time, so a built server carries its own schema and no SQL files ship
 * alongside the bundle.
 */
import type { Driver } from "./driver";

export interface Migration {
  /** The filename without its extension, for example `0001_initial`. */
  version: string;
  sql: string;
}

const SQL_FILES = import.meta.glob("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every migration shipped with this build, ordered by filename. */
export function builtInMigrations(): Migration[] {
  return Object.entries(SQL_FILES)
    .map(([path, sql]) => ({ version: versionFromPath(path), sql }))
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

function versionFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.sql$/, "");
}

function ensureLedger(db: Driver): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );
}

/** Versions already recorded, oldest first. */
export function appliedVersions(db: Driver): string[] {
  ensureLedger(db);
  return db
    .prepare("SELECT version FROM _schema_migrations ORDER BY version")
    .all<{ version: string }>()
    .map((row) => row.version);
}

/**
 * Apply every migration this database has not seen. Returns the versions applied
 * by this call. Safe to call on every boot and safe to call twice.
 *
 * `migrations` is a parameter so a test can hand in an extra follow-up migration
 * and prove the incremental path without adding a file to the shipped set.
 */
export function migrate(db: Driver, migrations: Migration[] = builtInMigrations()): string[] {
  ensureLedger(db);

  const done = new Set(appliedVersions(db));
  const pending = migrations.filter((migration) => !done.has(migration.version));
  if (pending.length === 0) return [];

  const record = db.prepare("INSERT INTO _schema_migrations (version, applied_at) VALUES (?, ?)");
  const applied: string[] = [];

  // SQLite ignores PRAGMA foreign_keys inside a transaction, so a migration
  // cannot turn enforcement off for itself. It is switched off here, outside
  // any transaction, as the SQLite manual tells a migration runner to do. The
  // documented table-rebuild procedure (create the new table, copy, drop the
  // old one, rename) needs it: with enforcement on, the drop fires every
  // child's ON DELETE action.
  //
  // foreign_key_check runs afterwards and a violation throws, so a migration
  // that leaves a dangling row fails loudly.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const migration of pending) {
      db.transaction(() => {
        db.exec(migration.sql);
        record.run(migration.version, new Date().toISOString());
      });
      applied.push(migration.version);
    }
    assertForeignKeysIntact(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  return applied;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
}

/** Throws when a migration left a row pointing at a parent that is not there. */
function assertForeignKeysIntact(db: Driver): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all<ForeignKeyViolation>();
  if (violations.length === 0) return;
  const first = violations[0];
  throw new Error(
    `MIGRATION_BROKE_A_FOREIGN_KEY: ${violations.length} row(s), first in ${first?.table} ` +
      `pointing at ${first?.parent}`,
  );
}
