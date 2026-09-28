import { afterEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "./db/driver";
import { freshDb, HAIKU, seedProject } from "./logic/test-support";
import { boot, bootSummary, shutdown } from "./boot";
import { workerStatus } from "./worker/loop";
import { schedulerStatus } from "./worker/scheduler-loop";

let db: Driver;

afterEach(() => {
  shutdown();
  db.close();
});

function open(): Driver {
  db = freshDb();
  return db;
}

describe("boot", () => {
  it("recovers the queue and reports what it found", () => {
    const db = open();
    seedProject(db);
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot)
       VALUES ('r1', 'p1', 'running', 4, '{}')`,
    ).run();
    // A process that died holding both phases: one call never made, one answer
    // already bought. Recovery must not send the second back to queued.
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status,
                              next_attempt_at, locked_at, locked_by)
       VALUES ('t1', 'r1', 'p1', 'q1', ?, 1, 'in_flight', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z', 'pid1-dead')`,
    ).run(HAIKU);
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status,
                              next_attempt_at, locked_at, locked_by, answer_text)
       VALUES ('t2', 'r1', 'p1', 'q1', ?, 2, 'extracting', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z', 'pid1-dead', 'an answer')`,
    ).run(HAIKU);

    const summary = boot({ db, startLoops: false, log: false });

    expect(summary.recovered).toMatchObject({ requeued: 1, returnedToAnswered: 1 });
    const statuses = db
      .prepare("SELECT id, status, locked_by FROM run_tasks ORDER BY id")
      .all<{ id: string; status: string; locked_by: string | null }>();
    expect(statuses).toEqual([
      { id: "t1", status: "queued", locked_by: null },
      { id: "t2", status: "answered", locked_by: null },
    ]);
  });

  it("is idempotent: a second call is the same summary and does nothing", () => {
    const db = open();
    const first = boot({ db, startLoops: false, log: false });
    const second = boot({ db, startLoops: false, log: false });

    expect(second).toBe(first);
    expect(bootSummary()).toBe(first);
  });

  it("starts both loops and stops them again", () => {
    const db = open();
    boot({ db, log: false });

    expect(workerStatus().running).toBe(true);
    expect(schedulerStatus().running).toBe(true);
    expect(bootSummary()?.loops).toEqual({ worker: true, scheduler: true });

    shutdown();
    expect(workerStatus().running).toBe(false);
    expect(schedulerStatus().running).toBe(false);
    expect(bootSummary()).toBeNull();
  });

  it("logs one line, naming the providers and never a key", () => {
    const db = open();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = boot({ db, startLoops: false });

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("[boot] Overheard AI ready");
    expect(line).toContain(`worker=${summary.workerId}`);
    expect(line).not.toMatch(/sk-|api[_-]?key=/i);
    // startLoops false, so the line says so rather than claiming a timer that
    // is not there. A live boot prints loops=worker+scheduler.
    expect(summary.loops).toEqual({ worker: false, scheduler: false });
    expect(line).toContain("loops=off");
    logged.mockRestore();
  });

  it("names both timers in the line a real boot prints", () => {
    const db = open();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    boot({ db });

    expect(String(logged.mock.calls[0]?.[0] ?? "")).toContain("loops=worker+scheduler");
    logged.mockRestore();
  });
});
