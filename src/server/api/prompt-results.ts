/**
 * The prompt results summary server functions: the Prompts tab's folds, and
 * buying one prompt's summary across every run.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Every prompt with answers, its stored summary, and what asking now would cost. */
export const listPromptResultsSummaries = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ projectId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listPromptResultsSummaries: op } = await import("./ops/prompt-results");
    return op(getDb(), data.projectId);
  });

/** Spends on the user's key, at roughly the cost the fold showed. Asking again replaces the summary. */
export const summarizePromptResults = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ promptId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { summarizePromptResults: op } = await import("./ops/prompt-results");
    return op(getDb(), data.promptId);
  });
