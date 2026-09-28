/**
 * The run server functions: plan one, start one, watch one, hear that a
 * scheduled one finished, and the three things that can be done to one
 * afterwards.
 *
 * createRun, createPerceptionRun and retryFailed kick the worker before
 * returning, so work starts at once instead of at the next idle tick, up to
 * fifteen seconds later. The kick only wakes the loop. The tasks are already
 * queued, so a kick that does nothing costs at most that wait.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const projectId = z.object({ projectId: z.string().min(1) });
const runId = z.object({ runId: z.string().min(1) });

/** What a run would cost, before anything is spent. */
export const planRun = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { planRunPreview } = await import("./ops/runs");
    return planRunPreview(getDb(), data.projectId);
  });

/** Start a measured run. A project's first run asks the perception question too. */
export const createRun = createServerFn({ method: "POST" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { createRun: op } = await import("./ops/runs");
    const { configuredProviders } = await import("../worker/keys");
    const { kickWorker } = await import("../worker/loop");
    const result = op(getDb(), data.projectId, {
      providersWithKeys: new Set(configuredProviders()),
    });
    kickWorker();
    return result;
  });

/** Ask the perception question again, without re-running the prompt library. */
export const createPerceptionRun = createServerFn({ method: "POST" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { createPerceptionRunOnly } = await import("./ops/runs");
    const { configuredProviders } = await import("../worker/keys");
    const { kickWorker } = await import("../worker/loop");
    const result = createPerceptionRunOnly(getDb(), data.projectId, {
      providersWithKeys: new Set(configuredProviders()),
    });
    kickWorker();
    return result;
  });

export const listRuns = createServerFn({ method: "GET" })
  .validator((data: unknown) =>
    z
      .object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listRuns: op } = await import("./ops/runs");
    return op(getDb(), data.projectId, data.limit ?? 20);
  });

/** Everything the run screen renders: tasks, failures, answers and metrics. */
export const getRunDetail = createServerFn({ method: "GET" })
  .validator((data: unknown) => runId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { getRunDetail: op } = await import("./ops/runs");
    return op(getDb(), data.runId);
  });

/**
 * Scheduled runs, in every project, that finished after `since`. Every open
 * tab polls this for the notice that a run finished with nobody watching.
 */
export const listFinishedScheduledRuns = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ since: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listFinishedScheduledRuns: op } = await import("./ops/runs");
    return op(getDb(), data.since);
  });

/** Every failure in the project, for the dashboard's failure strip. */
export const listFailedTaskErrors = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listFailedTaskErrors: op } = await import("./ops/runs");
    return op(getDb(), data.projectId);
  });

export const retryFailed = createServerFn({ method: "POST" })
  .validator((data: unknown) => runId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { retryFailed: op } = await import("./ops/runs");
    const { kickWorker } = await import("../worker/loop");
    const result = op(getDb(), data.runId);
    kickWorker();
    return result;
  });

export const cancelRun = createServerFn({ method: "POST" })
  .validator((data: unknown) => runId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { cancelRun: op } = await import("./ops/runs");
    return op(getDb(), data.runId);
  });

export const deleteRun = createServerFn({ method: "POST" })
  .validator((data: unknown) => runId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { deleteRun: op } = await import("./ops/runs");
    return op(getDb(), data.runId);
  });

/**
 * Wake the worker loop and report its status. The run screen calls this while
 * a run is active, at once and then every fifteen seconds, so progress does not
 * depend only on the loop's own timer.
 */
export const kickWorker = createServerFn({ method: "POST" }).handler(async () => {
  const { kickWorker: kick, workerStatus } = await import("../worker/loop");
  kick();
  return workerStatus();
});
