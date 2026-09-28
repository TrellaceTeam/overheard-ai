import { describe, expect, it } from "vitest";
import { openDatabase } from "./driver";

const expectedModule =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun:sqlite" : "node:sqlite";

describe("sqlite driver adapter", () => {
  it("binds to the built-in driver of the current runtime", () => {
    const db = openDatabase(":memory:");
    try {
      console.log(`driver module in use: ${db.driverModule}`);
      expect(db.driverModule).toBe(expectedModule);
    } finally {
      db.close();
    }
  });

  it("opens an in-memory database and round-trips a row", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");

      const insert = db.prepare("INSERT INTO smoke (label) VALUES (?)");
      const result = insert.run("hello");
      expect(result.changes).toBe(1);

      insert.run("world");

      const count = db.prepare("SELECT COUNT(*) AS n FROM smoke").get<{ n: number }>();
      expect(count?.n).toBe(2);

      const rows = db.prepare("SELECT label FROM smoke ORDER BY id").all<{ label: string }>();
      expect(rows.map((row) => row.label)).toEqual(["hello", "world"]);

      const missing = db.prepare("SELECT label FROM smoke WHERE id = ?").get<{ label: string }>(99);
      expect(missing).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rolls back a failed transaction", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      expect(() =>
        db.transaction(() => {
          db.prepare("INSERT INTO t (id) VALUES (?)").run(1);
          throw new Error("boom");
        }),
      ).toThrow("boom");

      const count = db.prepare("SELECT COUNT(*) AS n FROM t").get<{ n: number }>();
      expect(count?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not accept a boolean parameter, which is why SqlParam excludes one", () => {
    // The runtimes bind booleans differently, so the wrapper refuses them
    // itself: a flag that skipped toSqlBool() fails on every runtime, and Bun
    // never stores a 1 where Node would have thrown.
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER)");
      const insert = db.prepare("INSERT INTO t (id, flag) VALUES (?, ?)");
      expect(() => insert.run(1, true as unknown as number)).toThrow();

      insert.run(2, 1);
      const row = db.prepare("SELECT flag FROM t WHERE id = 2").get<{ flag: number }>();
      expect(row?.flag).toBe(1);
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
      db.exec(
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
      );
      expect(() => db.prepare("INSERT INTO child (parent_id) VALUES (?)").run(42)).toThrow();
    } finally {
      db.close();
    }
  });
});
