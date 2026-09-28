// Pure launch-routing logic. No server imports, so the root route can use it
// in the browser and node can unit-test it; the state itself is stored in
// app_state and read/written by the server (api/tutorial.ts, ops/tutorial.ts).

export const TUTORIAL_STATES = ["not_started", "in_setup", "done"] as const;
export type TutorialState = (typeof TUTORIAL_STATES)[number];

export function isTutorialState(value: unknown): value is TutorialState {
  return typeof value === "string" && (TUTORIAL_STATES as readonly string[]).includes(value);
}

export type LaunchDestination =
  | { to: "tutorial" }
  | { to: "project"; projectId: string }
  | { to: "new-project" };

/**
 * Where a project deletion should land, given what is left: `null` when the
 * deleted project was confirmed the last one, a project id when one remains,
 * `undefined` when the read of what remains failed.
 *
 * A confirmed-empty database goes straight to /start: both of the front door's
 * outcomes for it, the tutorial and New project, live there, and routing
 * through "/" would only add an "opening your projects…" flash on the way.
 * Anything else goes to "/", because the front door also re-reads the tutorial
 * state, and a delete handler must not guess past an interrupted tutorial. The
 * front door has its own error state for a database that will not open.
 */
export function afterDeleteDestination(
  nextProjectId: string | null | undefined,
): { to: "home" } | { to: "start" } {
  return nextProjectId === null ? { to: "start" } : { to: "home" };
}

/**
 * Where a launch should land: the tutorial until it is done, then the project
 * the user touched last, then New project. A half-finished tutorial restarts
 * instead of dropping the user into an empty app.
 */
export function firstLaunchDestination(input: {
  tutorialState: TutorialState;
  mostRecentProjectId: string | null;
}): LaunchDestination {
  if (input.tutorialState !== "done") return { to: "tutorial" };
  if (input.mostRecentProjectId !== null) {
    return { to: "project", projectId: input.mostRecentProjectId };
  }
  return { to: "new-project" };
}

/**
 * Whether the setup screen should be in tutorial mode. An unreadable state
 * reads as done: trapping a returning user in the tutorial because one query
 * failed is worse than skipping it once.
 */
export function isTutorialMode(state: unknown): boolean {
  return isTutorialState(state) && state !== "done";
}
