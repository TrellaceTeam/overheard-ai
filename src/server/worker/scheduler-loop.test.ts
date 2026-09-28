import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Driver } from "../db/driver";

vi.mock("../logic/scheduler", () => ({ enqueueScheduledRuns: vi.fn() }));
vi.mock("./loop", () => ({ kickWorker: vi.fn() }));

import { enqueueScheduledRuns } from "../logic/scheduler";
import { kickWorker } from "./loop";
import {
  SCHEDULER_TICK_MS,
  schedulerStatus,
  schedulerTick,
  startScheduler,
  stopScheduler,
} from "./scheduler-loop";

const db = {} as Driver;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (enqueueScheduledRuns as Mock).mockReturnValue({ created: 0, skipped: 0 });
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe("startScheduler", () => {
  it("sweeps once at startup, then every 60 s", () => {
    startScheduler(db);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(1);
    expect(enqueueScheduledRuns).toHaveBeenCalledWith(db);

    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 3);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(5);
  });

  it("is a singleton: a second start does not add a second timer", () => {
    startScheduler(db);
    startScheduler(db);
    startScheduler(db);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(2);
  });

  it("kicks the worker only when a run was created", () => {
    startScheduler(db);
    expect(kickWorker).not.toHaveBeenCalled();

    (enqueueScheduledRuns as Mock).mockReturnValue({ created: 2, skipped: 0 });
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(kickWorker).toHaveBeenCalledTimes(1);
  });

  it("never overlaps a sweep with itself", () => {
    let reentered = 0;
    (enqueueScheduledRuns as Mock).mockImplementation(() => {
      // A sweep that somehow fires from inside a sweep must be refused.
      if (schedulerTick() !== null) reentered += 1;
      return { created: 0, skipped: 0 };
    });

    startScheduler(db);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(1);
    expect(reentered).toBe(0);
  });

  it("survives a sweep that throws and keeps ticking", () => {
    (enqueueScheduledRuns as Mock).mockImplementation(() => {
      throw new Error("BOOM");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    startScheduler(db);
    expect(schedulerStatus().lastError).toBe("BOOM");

    (enqueueScheduledRuns as Mock).mockReturnValue({ created: 0, skipped: 1 });
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(schedulerStatus().lastError).toBeNull();
    expect(schedulerStatus().lastSummary).toEqual({ created: 0, skipped: 1 });
    logged.mockRestore();
  });

  it("stops cleanly", () => {
    startScheduler(db);
    stopScheduler();
    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 5);
    expect(enqueueScheduledRuns).toHaveBeenCalledTimes(1);
    expect(schedulerStatus().running).toBe(false);
    expect(schedulerTick()).toBeNull();
  });
});
