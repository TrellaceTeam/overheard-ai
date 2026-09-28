/**
 * The project server functions.
 *
 * Every file in this folder has the same shape. It validates its input with
 * zod, then imports the operation and the database handle inside the handler,
 * so the client bundle keeps the call signature and none of the server code.
 * The operations live in ./ops, which is what the tests exercise.
 *
 * Mutating calls are POSTs. src/server.ts puts the loopback gate from
 * src/server/security.ts in front of every request, so a POST from another
 * origin never reaches a handler.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { DESCRIPTION_MAX_CHARS } from "@/lib/onboarding";

const projectId = z.object({ projectId: z.string().min(1) });

const createProjectInput = z.object({
  brandName: z.string().min(1).max(200),
  category: z.string().max(200).optional(),
  description: z.string().max(DESCRIPTION_MAX_CHARS).optional(),
  projectName: z.string().max(200).optional(),
  variants: z.array(z.string().max(200)).max(50).optional(),
  domains: z.array(z.string().max(300)).min(1).max(50),
  competitors: z
    .array(
      z.union([
        z.string().max(200),
        z.object({
          name: z.string().max(200),
          domains: z.array(z.string().max(300)).max(50).optional(),
        }),
      ]),
    )
    .max(50)
    .optional(),
  prompts: z
    .array(
      z.object({
        text: z.string().max(2000),
        tag: z.string().max(100).nullable(),
        iterations: z.number().int().min(1).max(20).optional(),
      }),
    )
    .max(50)
    .optional(),
  perceptionPrompt: z.string().max(4000).optional(),
  extractionModelId: z.string().min(1).nullable().optional(),
  monitoredModelIds: z.array(z.string().min(1)).min(1).max(20),
});

const updateProjectInput = z.object({
  projectId: z.string().min(1),
  name: z.string().max(200).optional(),
  extractionModelId: z.string().min(1).nullable().optional(),
  perceptionPrompt: z.string().max(4000).optional(),
  // min(1) catches the empty string. A whitespace-only prompt reaches the op,
  // which trims and refuses it. The default prompt is about 1,200 characters,
  // so the bound leaves room for a much longer one.
  extractionPrompt: z.string().min(1).max(20000).optional(),
});

export const listProjects = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { listProjects: op } = await import("./ops/projects");
  return op(getDb());
});

/** Where `/` sends a returning user, or null when there is no project yet. */
export const mostRecentProject = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { mostRecentProjectId } = await import("./ops/projects");
  return { projectId: mostRecentProjectId(getDb()) };
});

export const getProject = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { getProject: op } = await import("./ops/projects");
    return op(getDb(), data.projectId);
  });

export const getProjectSettings = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { getProjectSettings: op } = await import("./ops/projects");
    return op(getDb(), data.projectId);
  });

/**
 * Runs the setup check, then writes the project, brands, prompts and
 * assistants in one transaction. The check runs on the server, so a project
 * that would fail cannot be created whatever the browser sends.
 * SETUP_CHECK_FAILED carries the per-model reasons for the wizard to show.
 */
export const createProject = createServerFn({ method: "POST" })
  .validator((data: unknown) => createProjectInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { createProjectGated: op } = await import("./ops/projects");
    const { configuredProviders } = await import("../worker/keys");
    return op(getDb(), data, { providersWithKeys: configuredProviders() });
  });

export const updateProject = createServerFn({ method: "POST" })
  .validator((data: unknown) => updateProjectInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { updateProject: op } = await import("./ops/projects");
    return op(getDb(), data);
  });

export const deleteProject = createServerFn({ method: "POST" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { deleteProject: op } = await import("./ops/projects");
    return op(getDb(), data.projectId);
  });
