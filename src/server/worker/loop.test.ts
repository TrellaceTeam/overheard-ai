import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Driver } from "../db/driver";

vi.mock("../logic/recovery", () => ({ bootRecovery: vi.fn(), reapStuckTasks: vi.fn() }));
vi.mock("./pass", () => ({ runWorkerPass: vi.fn() }));

import { bootRecovery } from "../logic/recovery";
import { runWorkerPass } from "./pass";
import {
  ACTIVE_TICK_MS,
  IDLE_TICK_MS,
  kickWorker,
  startWorker,
  stopWorker,
  workerStatus,
} from "./loop";

const db = {} as Driver;

/** Let the in-flight pass promise settle without advancing the fake clock. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (runWorkerPass as Mock).mockResolvedValue({ processed: 0, finalised: 0 });
});

afterEach(() => {
  stopWorker();
  vi.useRealTimers();
});

describe("startWorker", () => {
  it("recovers the queue once, then runs a pass", async () => {
    startWorker(db);
    await settle();
    expect(bootRecovery).toHaveBeenCalledWith(db);
    expect(runWorkerPass).toHaveBeenCalledTimes(1);
    expect(workerStatus().running).toBe(true);
  });

  it("is idempotent, so a hot reload does not leave two loops claiming", async () => {
    startWorker(db);
    startWorker(db);
    await settle();
    expect(bootRecovery).toHaveBeenCalledTimes(1);
    expect(runWorkerPass).toHaveBeenCalledTimes(1);
  });
});

describe("the tick", () => {
  it("backs off to the idle interval when a pass finds nothing", async () => {
    startWorker(db);
    await settle();
    expect(runWorkerPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(runWorkerPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_TICK_MS - ACTIVE_TICK_MS);
    expect(runWorkerPass).toHaveBeenCalledTimes(2);
  });

  it("stays on the short interval while work is arriving", async () => {
    (runWorkerPass as Mock).mockResolvedValue({ processed: 4, finalised: 0 });
    startWorker(db);
    await settle();

    await vi.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(runWorkerPass).toHaveBeenCalledTimes(2);
  });

  it("survives a pass that throws, because that is a bug and not a stop signal", async () => {
    (runWorkerPass as Mock).mockRejectedValueOnce(new Error("boom"));
    startWorker(db);
    await settle();

    await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
    expect(runWorkerPass).toHaveBeenCalledTimes(2);
  });
});

describe("kickWorker", () => {
  it("runs a pass now rather than at the next tick", async () => {
    startWorker(db);
    await settle();
    expect(runWorkerPass).toHaveBeenCalledTimes(1);

    kickWorker();
    await settle();
    expect(runWorkerPass).toHaveBeenCalledTimes(2);
  });

  it("is not lost when it arrives while a pass is in flight", async () => {
    const releases: Array<() => void> = [];
    (runWorkerPass as Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ processed: 0, finalised: 0 }));
        }),
    );
    startWorker(db);
    await settle();

    kickWorker();
    releases[0]?.();
    await settle();

    // The pass found nothing, so without the remembered kick this would be the
    // 15 s interval.
    await vi.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(runWorkerPass).toHaveBeenCalledTimes(2);
  });

  it("does nothing once the loop is stopped", async () => {
    startWorker(db);
    await settle();
    stopWorker();
    kickWorker();
    await settle();
    expect(runWorkerPass).toHaveBeenCalledTimes(1);
    expect(workerStatus().running).toBe(false);
  });
});
