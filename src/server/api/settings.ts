/**
 * The application settings server functions: key status, the setup check,
 * where the database file is, whether the background loops are running, how
 * the icon opens the app, and Quit.
 *
 * The setup check takes a provider name or model ids and nothing else. A key is
 * never an input or an output. Its value is read from the environment inside
 * the worker layer and stays there.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CALL_LIMIT_MAX, CALL_LIMIT_MIN } from "@/lib/call-limits";
import { INFLIGHT_CAP_MAX, INFLIGHT_CAP_MIN } from "@/lib/inflight-caps";

/** Re-exported so browser code can name the report shape without reaching into ops/. */
export type { SetupCheckReport, SetupCheckRow } from "./ops/setup-check";
export type { InflightCapView } from "./ops/settings";

const providerInput = z.object({ provider: z.enum(["openai", "anthropic", "google"]) });
const selectionInput = z.object({
  assistantModelIds: z.array(z.string().min(1)).min(1),
});

/** Which providers have a key. Booleans only, never a value or a length. */
export const keyStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { providerKeyStatus } = await import("./ops/settings");
  return providerKeyStatus();
});

const availabilityInput = z.object({ force: z.boolean().optional() });

/**
 * Which catalogue models each key can use, from the providers' own model
 * lists. The lists are free to read. `force` skips the few minutes they are
 * cached, which is what the Check button asks for.
 */
export const modelAvailability = createServerFn({ method: "POST" })
  .validator((data: unknown) => availabilityInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { modelAvailability: op } = await import("./ops/model-availability");
    return op(getDb(), { force: data.force });
  });

/** Probe one provider's representative model with web search forced. */
export const setupCheck = createServerFn({ method: "POST" })
  .validator((data: unknown) => providerInput.parse(data))
  .handler(async ({ data }) => {
    const { checkProviders } = await import("./ops/setup-check");
    return checkProviders([data.provider]);
  });

/**
 * Probe a selection that is not a project yet: the wizard's ticked assistants
 * plus the extractor a create would auto-pick. createProject gates on the same
 * op, so what the wizard shows is what create will run.
 */
export const modelsSetupCheck = createServerFn({ method: "POST" })
  .validator((data: unknown) => selectionInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { checkSelection } = await import("./ops/setup-check");
    const { configuredProviders } = await import("../worker/keys");
    return checkSelection(getDb(), {
      assistantModelIds: data.assistantModelIds,
      providersWithKeys: configuredProviders(),
    });
  });

/** The database file: where it is, how big it is, which driver opened it. */
export const databaseInfo = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { databaseInfo: op } = await import("./ops/settings");
  return op(getDb());
});

/** The worker and scheduler lines on the settings screen. */
export const workerStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { workerStatusView } = await import("./ops/settings");
  return workerStatusView();
});

/** The run call ceiling the planner uses, plus the default Reset restores. */
export const callLimit = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { callLimit: op } = await import("./ops/settings");
  return op(getDb());
});

// The op checks the same bounds again before writing.
export const setCallLimit = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ limit: z.number().int().min(CALL_LIMIT_MIN).max(CALL_LIMIT_MAX) }).parse(data),
  )
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setCallLimit: op } = await import("./ops/settings");
    return op(getDb(), data.limit);
  });

/**
 * Each provider's calls in flight: what the next pass applies, the default,
 * the saved value, and the variable that wins over it.
 */
export const inflightCaps = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { inflightCaps: op } = await import("./ops/settings");
  return op(getDb());
});

/** Whether the icon rebuilds a stale build before it starts the app. */
export const rebuildOnOpen = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { rebuildOnOpen: op } = await import("./ops/settings");
  return op(getDb());
});

export const setRebuildOnOpen = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ on: z.boolean() }).parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setRebuildOnOpen: op } = await import("./ops/settings");
    return op(getDb(), data.on);
  });

/** Stops the app, for the menu's Quit. */
export const quitApp = createServerFn({ method: "POST" }).handler(async () => {
  const { quit } = await import("./ops/settings");
  return quit();
});

// Null clears the saved cap, so the default applies. The op checks the same
// bounds again before writing.
export const setInflightCap = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    providerInput
      .extend({ cap: z.number().int().min(INFLIGHT_CAP_MIN).max(INFLIGHT_CAP_MAX).nullable() })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setInflightCap: op } = await import("./ops/settings");
    return op(getDb(), data.provider, data.cap);
  });
