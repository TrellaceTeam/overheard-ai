/**
 * bootRecovery and reapStuckTasks. They differ only in the lock age test, and
 * route tasks by the same rule.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../db/driver";
import type { TaskStatus } from "../db/types";
import { bootRecovery, reapStuckTasks } from "./recovery";
import { freshDb, HAIKU, seedProject } from "./test-support";
import { MAX_CALL_TIMEOUT_MS, STUCK_LOCK_MS } from "./types";

let db: Driver;
let seq = 0;

beforeEach(() => {
  db = freshDb();
  seq = 0;
  seedProject(db);
  db.prepare(
    "INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot) VALUES ('r1','p1','running',20,'{}')",
  ).run();
});

afterEach(() => {
  db.close();
});

function makeTask(
  status: TaskStatus,
  lockedAt: string | null,
  extra: { attempts?: number; answerText?: string } = {},
): string {
  seq += 1;
  const id = `t${seq}`;
  db.prepare(
    `INSERT INTO run_tasks
       (id, run_id, project_id, prompt_id, model_id, iteration, status, locked_at, locked_by, attempts, answer_text)
     VALUES (?, 'r1', 'p1', 'q1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    HAIKU,
    seq,
    status,
    lockedAt,
    lockedAt === null ? null : "worker-1",
    extra.attempts ?? 0,
    extra.answerText ?? null,
  );
  return id;
}

function statusOf(id: string): TaskStatus {
  return (
    db.prepare("SELECT status FROM run_tasks WHERE id = ?").get<{ status: TaskStatus }>(id)
      ?.status ?? "queued"
  );
}

const fresh = (): string => new Date().toISOString();
const stale = (): string => new Date(Date.now() - STUCK_LOCK_MS - 1000).toISOString();

describe("bootRecovery", () => {
  it("releases every locked task however recently it was locked", () => {
    const inFlight = makeTask("in_flight", fresh());
    const extracting = makeTask("extracting", fresh(), { answerText: "already paid for" });

    const summary = bootRecovery(db);

    expect(summary.requeued).toBe(1);
    expect(summary.returnedToAnswered).toBe(1);
    expect(statusOf(inFlight)).toBe("queued");
    expect(statusOf(extracting)).toBe("answered");
  });

  it("clears the lock columns it releases", () => {
    const id = makeTask("in_flight", fresh());

    bootRecovery(db);

    const row = db
      .prepare("SELECT locked_at, locked_by FROM run_tasks WHERE id = ?")
      .get<{ locked_at: string | null; locked_by: string | null }>(id);
    expect(row?.locked_at).toBeNull();
    expect(row?.locked_by).toBeNull();
  });

  it("leaves claimable and terminal tasks alone", () => {
    const queued = makeTask("queued", null);
    const done = makeTask("done", null);
    const failed = makeTask("failed", null);

    bootRecovery(db);

    expect(statusOf(queued)).toBe("queued");
    expect(statusOf(done)).toBe("done");
    expect(statusOf(failed)).toBe("failed");
  });

  it("does not reset attempts, which is what stops an endless loop", () => {
    const id = makeTask("in_flight", fresh(), { attempts: 2 });

    bootRecovery(db);

    expect(
      db.prepare("SELECT attempts FROM run_tasks WHERE id = ?").get<{ attempts: number }>(id)
        ?.attempts,
    ).toBe(2);
  });

  it("closes out a spent task in the same sweep", () => {
    const spent = makeTask("queued", null, { attempts: 3 });

    expect(bootRecovery(db).exhausted).toBe(1);
    expect(statusOf(spent)).toBe("failed");
  });
});

describe("reapStuckTasks", () => {
  it("releases a stale lock and leaves a live one alone", () => {
    const old = makeTask("in_flight", stale());
    const live = makeTask("in_flight", fresh());

    const summary = reapStuckTasks(db);

    expect(summary.requeued).toBe(1);
    expect(statusOf(old)).toBe("queued");
    expect(statusOf(live)).toBe("in_flight");
  });

  it("releases a null lock immediately", () => {
    const orphan = makeTask("extracting", null, { answerText: "already paid for" });

    reapStuckTasks(db);

    expect(statusOf(orphan)).toBe("answered");
  });

  it("returns a stale extraction to answered, never to queued", () => {
    const id = makeTask("extracting", stale(), { answerText: "already paid for" });

    reapStuckTasks(db);

    expect(statusOf(id)).toBe("answered");
  });

  it("judges staleness against the clock it is given", () => {
    const id = makeTask("in_flight", new Date("2026-09-22T12:00:00.000Z").toISOString());

    reapStuckTasks(db, new Date("2026-09-22T12:06:00.000Z"));
    expect(statusOf(id)).toBe("in_flight");

    reapStuckTasks(db, new Date("2026-09-22T12:08:00.000Z"));
    expect(statusOf(id)).toBe("queued");
  });

  it("holds the window above a raised-budget call: six minutes in flight is not stale", () => {
    // A call under the 360 s raised budget can still be running at six
    // minutes. Reclaiming its lock would pay for the same answer twice.
    const locked = Date.now() - 6 * 60 * 1000;
    const id = makeTask("in_flight", new Date(locked).toISOString());

    reapStuckTasks(db);

    expect(statusOf(id)).toBe("in_flight");
  });

  it("keeps the invariant: the running window exceeds the longest call budget", () => {
    expect(STUCK_LOCK_MS).toBeGreaterThan(MAX_CALL_TIMEOUT_MS);
  });

  it("recounts the run of every task it fails, so the stored status matches the tasks", () => {
    makeTask("queued", null, { attempts: 2 });

    reapStuckTasks(db);

    expect(
      db
        .prepare("SELECT status, failed_calls, finished_at FROM runs WHERE id = 'r1'")
        .get<{ status: string; failed_calls: number; finished_at: string | null }>(),
    ).toMatchObject({ status: "failed", failed_calls: 2, finished_at: expect.any(String) });
  });

  it("recounts a cancelled run when it closes an answer that landed after the cancel", () => {
    db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = 'r1'").run();
    makeTask("answered", null, { answerText: "landed late" });

    reapStuckTasks(db);

    expect(
      db
        .prepare("SELECT status, failed_calls FROM runs WHERE id = 'r1'")
        .get<{ status: string; failed_calls: number }>(),
    ).toEqual({ status: "cancelled", failed_calls: 2 });
  });

  it("counts only the rows it released, not the ones the exhaustion sweep failed", () => {
    makeTask("in_flight", stale());
    makeTask("queued", null, { attempts: 3 });

    const summary = reapStuckTasks(db);

    expect(summary.requeued).toBe(1);
    expect(summary.returnedToAnswered).toBe(0);
    expect(summary.exhausted).toBe(1);
  });
});
