/**
 * The perception server function: the four-section summary the dashboard band
 * shows, the question that produced it, and whether it is out of date.
 *
 * Refreshing perception is createPerceptionRun in ./runs, because it creates a
 * run.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const projectId = z.object({ projectId: z.string().min(1) });

/** The prompt, the resolved question, the summaries and the staleness verdict. */
export const getPerceptionState = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { getPerceptionState: op } = await import("./ops/perception");
    return op(getDb(), data.projectId);
  });
