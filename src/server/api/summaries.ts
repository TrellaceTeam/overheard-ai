/**
 * The answer-summary server function: buy one prompt's summary for one run.
 * Stored summaries are read through getRunDetail.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const summarizePrompt = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ runId: z.string().min(1), promptId: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { summarizePromptAnswers } = await import("./ops/summaries");
    return summarizePromptAnswers(getDb(), data.runId, data.promptId);
  });
