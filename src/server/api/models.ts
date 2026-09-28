/**
 * The model server functions: the seeded catalogue, and which assistants a
 * project asks.
 *
 * The catalogue is read-only to a user. setProjectModel toggles one assistant
 * per call.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const projectId = z.object({ projectId: z.string().min(1) });

const setProjectModelInput = z.object({
  projectId: z.string().min(1),
  modelId: z.string().min(1),
  on: z.boolean(),
});

/** The assistants a project can monitor. */
export const listModels = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { listModels: op } = await import("./ops/models");
  return op(getDb());
});

/** The models that can read an answer, cheapest first. */
export const listExtractionModels = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { listExtractionModels: op } = await import("./ops/models");
  return op(getDb());
});

export const listProjectModels = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listProjectModels: op } = await import("./ops/models");
    return op(getDb(), data.projectId);
  });

export const setProjectModel = createServerFn({ method: "POST" })
  .validator((data: unknown) => setProjectModelInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setProjectModel: op } = await import("./ops/models");
    return op(getDb(), data);
  });
