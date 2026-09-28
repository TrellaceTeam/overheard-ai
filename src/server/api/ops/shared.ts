/**
 * The small pieces every operation needs: ids, timestamps, the JSON-in-TEXT
 * columns decoded and encoded, the two error shapes this layer raises, and the
 * demo guard.
 *
 * Errors carry a prefixed code, the same convention src/server/logic uses, so a
 * route can branch on the code and still show the sentence to a person.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../../db/driver";
import type { SqlBool } from "../../db/types";

/** A new row id. The schema's TEXT id columns have no default, so every insert supplies one. */
export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite has no boolean and the driver's parameter type excludes one, so flags are written as 0 or 1. */
export function toSqlBool(value: boolean): SqlBool {
  return value ? 1 : 0;
}

/**
 * A JSON array column read back as strings. A malformed value returns empty
 * rather than throwing: one bad row must not take a whole screen down, and the
 * next write repairs it.
 */
export function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** The same column written. Trimmed, blank and repeated entries dropped, order preserved. */
export function encodeList(values: readonly string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return JSON.stringify(kept);
}

/** Raised when the row a caller named does not exist. */
export class NotFoundError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "NotFoundError";
  }
}

/** Raised when the input is wrong in a way zod cannot see, such as a bad domain. */
export class InvalidInputError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "InvalidInputError";
  }
}

/* ------------------------------------------------------------- demo guard */

/**
 * The demo project is browse-only (ADR 0006). Its history is generated, so a
 * run would spend real money mixing measurements into invented data, and an
 * edit would corrupt what the demo shows. Every operation that starts work or
 * changes data refuses it here on the server, because a stale browser tab
 * still shows every button. Deleting the demo is allowed, and "Restore demo
 * project" brings it back.
 *
 * The resolvers below take an entity id (run, prompt, brand) and do nothing
 * when the row does not exist, so the operation's own NotFoundError reports a
 * bad id.
 */
export function refuseDemoProject(db: Driver, projectId: string): void {
  const row = db
    .prepare("SELECT is_demo FROM projects WHERE id = ?")
    .get<{ is_demo: number }>(projectId);
  if (row?.is_demo === 1) {
    throw new InvalidInputError(
      "DEMO_PROJECT",
      "this is the demo project. It is browse-only, so nothing in it can run or change",
    );
  }
}

export function refuseDemoForRun(db: Driver, runId: string): void {
  const row = db
    .prepare("SELECT project_id FROM runs WHERE id = ?")
    .get<{ project_id: string }>(runId);
  if (row) refuseDemoProject(db, row.project_id);
}

export function refuseDemoForPrompt(db: Driver, promptId: string): void {
  const row = db
    .prepare("SELECT project_id FROM prompts WHERE id = ?")
    .get<{ project_id: string }>(promptId);
  if (row) refuseDemoProject(db, row.project_id);
}

export function refuseDemoForBrand(db: Driver, brandId: string): void {
  const row = db
    .prepare("SELECT project_id FROM brands WHERE id = ?")
    .get<{ project_id: string }>(brandId);
  if (row) refuseDemoProject(db, row.project_id);
}

/**
 * Raises NotFoundError when an UPDATE or DELETE changed no rows. A stale id
 * changes nothing without an error, and the caller must not report it as saved.
 */
export function expectChanged(changes: number, code: string, message: string): void {
  if (changes === 0) throw new NotFoundError(code, message);
}
