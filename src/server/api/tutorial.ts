/**
 * The tutorial's server functions: the state the launch routing reads, and how
 * the screens move it.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { TUTORIAL_STATES } from "@/lib/launch";

const stateInput = z.object({ state: z.enum(TUTORIAL_STATES) });

/** The tutorial state this install is in. Drives first-launch routing. */
export const tutorialState = createServerFn({ method: "GET" }).handler(async () => {
  const { getDb } = await import("../db/client");
  const { getTutorialState } = await import("./ops/tutorial");
  return getTutorialState(getDb());
});

/** Move the tutorial state: "in_setup" when it opens, "done" when the demo exists. */
export const setTutorial = createServerFn({ method: "POST" })
  .validator((data: unknown) => stateInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setTutorialState } = await import("./ops/tutorial");
    return setTutorialState(getDb(), data.state);
  });
