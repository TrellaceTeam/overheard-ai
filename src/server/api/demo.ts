/**
 * The demo project's server functions: whether it exists, restoring it, and
 * the values the tutorial's setup screen shows.
 */
import { createServerFn } from "@tanstack/react-start";

/** Whether the demo project exists, for the Settings screen's demo card. */
export const demoState = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { demoState: op } = await import("./ops/demo");
  return op(getDb());
});

/** Create the demo project if it is missing, dated relative to today. Returns its id and its showcase run's id. */
export const restoreDemoProject = createServerFn({ method: "POST" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { restoreDemoProject: op } = await import("./ops/demo");
  return op(getDb());
});

/** The values the tutorial mode of the setup screen shows, locked. */
export const demoPrefill = createServerFn({ method: "GET" }).handler(async () => {
  const { demoPrefill: op } = await import("./ops/demo");
  return op();
});
