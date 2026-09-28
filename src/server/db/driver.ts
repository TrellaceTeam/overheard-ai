/**
 * A minimal synchronous SQLite surface shared by `node:sqlite` and
 * `bun:sqlite`. Both runtime drivers model their API on better-sqlite3, so the
 * adapter is thin and query code never learns which runtime it is on. See
 * docs/decisions/0001.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * No boolean. The runtimes bind one differently: bun:sqlite converts it to 0
 * or 1 and node:sqlite throws. Flags go through toSqlBool() instead.
 */
export type SqlParam = string | number | bigint | null | Uint8Array;

/**
 * Enforces SqlParam at runtime as well as in the type. Any other value, such
 * as a boolean that skipped toSqlBool(), throws this TypeError before the
 * driver sees it, so the behaviour does not depend on the runtime or its
 * version.
 */
function assertBindable(params: readonly SqlParam[]): void {
  for (const param of params) {
    const bindable =
      param === null ||
      typeof param === "string" ||
      typeof param === "number" ||
      typeof param === "bigint" ||
      param instanceof Uint8Array;
    if (!bindable) {
      throw new TypeError(
        `SQL parameters must be null, string, number, bigint or Uint8Array; got ${typeof param}. Convert flags with toSqlBool().`,
      );
    }
  }
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: SqlParam[]): RunResult;
  get<T = unknown>(...params: SqlParam[]): T | undefined;
  all<T = unknown>(...params: SqlParam[]): T[];
}

export interface Driver {
  /** Which runtime module backs this handle: "node:sqlite" or "bun:sqlite". */
  readonly driverModule: SqliteModuleName;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
  /**
   * Same nesting behaviour as transaction(), but the outermost level opens with
   * BEGIN IMMEDIATE so the write lock is taken before the first read. Claiming
   * work reads a set of rows and then writes those same rows. With a deferred
   * BEGIN a second writer can slip in between and the upgrade fails as SQLITE_BUSY.
   */
  immediateTransaction<T>(fn: () => T): T;
  close(): void;
}

export type SqliteModuleName = "node:sqlite" | "bun:sqlite";

export const DEFAULT_DATABASE_PATH = "./data/overheard.db";

/** Bun exposes a `Bun` global; Node does not. */
function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * The specifier is held in a variable so Vite, Rollup and Nitro cannot statically
 * resolve it. A single production build therefore boots under either runtime.
 */
function loadSqliteModule(): { name: SqliteModuleName; open: (path: string) => RawDatabase } {
  const require_ = createRequire(import.meta.url);

  if (isBun()) {
    const specifier = "bun:sqlite";
    const { Database } = require_(specifier) as {
      Database: new (path: string, options?: { create?: boolean }) => RawDatabase;
    };
    return { name: "bun:sqlite", open: (path: string) => new Database(path, { create: true }) };
  }

  const specifier = "node:sqlite";
  const { DatabaseSync } = require_(specifier) as {
    DatabaseSync: new (path: string) => RawDatabase;
  };
  return { name: "node:sqlite", open: (path: string) => new DatabaseSync(path) };
}

interface RawStatement {
  run(...params: SqlParam[]): RunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = NORMAL",
];

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

export function openDatabase(path: string = databasePathFromEnv()): Driver {
  const target = isMemoryPath(path) ? path : resolve(path);

  if (!isMemoryPath(target)) {
    mkdirSync(dirname(target), { recursive: true });
  }

  const sqlite = loadSqliteModule();
  const raw = sqlite.open(target);

  for (const pragma of PRAGMAS) {
    // An in-memory database cannot use WAL; SQLite ignores the request and keeps
    // `memory` journal mode, so the statement is still safe to issue.
    raw.exec(pragma);
  }

  let depth = 0;

  return {
    driverModule: sqlite.name,
    exec(sql: string): void {
      raw.exec(sql);
    },
    prepare(sql: string): Statement {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => {
          assertBindable(params);
          return stmt.run(...params);
        },
        get: <T>(...params: SqlParam[]) => {
          assertBindable(params);
          return (stmt.get(...params) ?? undefined) as T | undefined;
        },
        all: <T>(...params: SqlParam[]) => {
          assertBindable(params);
          return stmt.all(...params) as T[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      return withTransaction("BEGIN", fn);
    },
    immediateTransaction<T>(fn: () => T): T {
      return withTransaction("BEGIN IMMEDIATE", fn);
    },
    close(): void {
      raw.close();
    },
  };

  // node:sqlite has no transaction() helper, so savepoints are managed here and
  // both runtimes get identical nesting behaviour. Only the outermost level
  // chooses a locking mode; a nested call is always a savepoint.
  function withTransaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T {
    const name = `st_${depth}`;
    raw.exec(depth === 0 ? begin : `SAVEPOINT ${name}`);
    depth += 1;
    try {
      const result = fn();
      depth -= 1;
      raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
      return result;
    } catch (error) {
      depth -= 1;
      raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}`);
      throw error;
    }
  }
}

export function databasePathFromEnv(): string {
  return process.env["DATABASE_PATH"] ?? DEFAULT_DATABASE_PATH;
}

/**
 * Held on globalThis so a dev-server hot reload reuses the open handle instead of
 * opening a second connection to the same file.
 */
const DB_SINGLETON_KEY = Symbol.for("overheard.db");

type DbGlobal = typeof globalThis & { [DB_SINGLETON_KEY]?: Driver };

export function getDb(): Driver {
  const holder = globalThis as DbGlobal;
  let db = holder[DB_SINGLETON_KEY];
  if (!db) {
    db = openDatabase(databasePathFromEnv());
    holder[DB_SINGLETON_KEY] = db;
  }
  return db;
}

export function closeDb(): void {
  const holder = globalThis as DbGlobal;
  const db = holder[DB_SINGLETON_KEY];
  if (db) {
    db.close();
    delete holder[DB_SINGLETON_KEY];
  }
}
