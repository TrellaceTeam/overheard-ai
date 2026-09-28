/**
 * The metric server functions: the stored level 0 rows, with and without what
 * the read had to leave out.
 *
 * These filters only narrow what is fetched. ops/metrics decides which rows
 * count at all. The dashboard's own filters are applied once, by applyFilter
 * in @/lib/dashboard-filters, so every figure on a screen describes the same
 * rows.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const filters = z.object({
  projectId: z.string().min(1),
  runIds: z.array(z.string().min(1)).max(200).optional(),
  modelIds: z.array(z.string().min(1)).max(50).optional(),
  promptIds: z.array(z.string().min(1)).max(200).optional(),
  brandIds: z.array(z.string().min(1)).max(200).optional(),
  since: z.string().max(40).optional(),
});

/** Level 0 rows only: keyed by a model and a prompt, never the run-wide row. */
export const listProjectMetrics = createServerFn({ method: "GET" })
  .validator((data: unknown) => filters.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listProjectMetrics: op } = await import("./ops/metrics");
    const { projectId, ...rest } = data;
    return op(getDb(), projectId, rest);
  });

/**
 * The same level 0 rows, with what the read had to leave out. The dashboard
 * uses `mockExcluded` to say mock rows were dropped. `capped` and the run
 * counts say whether older runs fell outside the row budget.
 */
export const projectMetricWindow = createServerFn({ method: "GET" })
  .validator((data: unknown) => filters.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { projectMetricWindow: op } = await import("./ops/metrics");
    const { projectId, ...rest } = data;
    return op(getDb(), projectId, rest);
  });
