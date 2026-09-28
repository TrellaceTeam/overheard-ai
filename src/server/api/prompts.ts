/** The prompt server functions: the question library behind the prompts screen. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const projectId = z.object({ projectId: z.string().min(1) });
const promptId = z.object({ id: z.string().min(1) });

const createPromptInput = z.object({
  projectId: z.string().min(1),
  text: z.string().min(1).max(2000),
  iterations: z.number().int().min(1).max(20).optional(),
  /** Required. The op refuses a blank one with its own message. */
  category: z.string().max(100),
  isActive: z.boolean().optional(),
  context: z.string().max(8000).nullable().optional(),
});

const updatePromptInput = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(2000).optional(),
  isActive: z.boolean().optional(),
  iterations: z.number().int().min(1).max(20).optional(),
  category: z.string().max(100).nullable().optional(),
  context: z.string().max(8000).nullable().optional(),
});

export const listPrompts = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listPrompts: op } = await import("./ops/prompts");
    return op(getDb(), data.projectId);
  });

/** How many answers each question has. A question with any answers has its text locked. */
export const promptAnswerCounts = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { promptAnswerCounts: op } = await import("./ops/prompts");
    return op(getDb(), data.projectId);
  });

export const createPrompt = createServerFn({ method: "POST" })
  .validator((data: unknown) => createPromptInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { createPrompt: op } = await import("./ops/prompts");
    return op(getDb(), data);
  });

/** Refuses a text change on a question that already has answers. Every other field stays editable. */
export const updatePrompt = createServerFn({ method: "POST" })
  .validator((data: unknown) => updatePromptInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { updatePrompt: op } = await import("./ops/prompts");
    return op(getDb(), data);
  });

/** An inactive copy of a question, which is how a locked question gets edited. */
export const clonePrompt = createServerFn({ method: "POST" })
  .validator((data: unknown) => promptId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { clonePrompt: op } = await import("./ops/prompts");
    return op(getDb(), data.id);
  });

export const setPromptArchived = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ id: z.string().min(1), archived: z.boolean() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setPromptArchived: op } = await import("./ops/prompts");
    return op(getDb(), data);
  });

/**
 * Deleting takes the prompt's answers with it and re-scores their runs. The UI
 * warns first and offers archiving, which keeps everything.
 */
export const deletePrompt = createServerFn({ method: "POST" })
  .validator((data: unknown) => promptId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { deletePrompt: op } = await import("./ops/prompts");
    return op(getDb(), data.id);
  });
