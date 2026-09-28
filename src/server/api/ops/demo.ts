/**
 * The demo project's operations: whether it exists, restoring it, and the
 * values the tutorial's setup screen shows.
 *
 * Restoring is idempotent and is the same call the tutorial makes, so the demo
 * is never duplicated. The partial unique index on projects.is_demo backs that
 * up.
 */
import type { Driver } from "../../db/driver";
import {
  DEMO_BRAND,
  DEMO_COMPETITORS,
  DEMO_ITERATIONS,
  DEMO_PROMPTS,
  ensureDemoProject,
} from "../../logic/demo-project";
import { demoShowcaseRunId } from "@/lib/demo-ids";
import { defaultPerceptionPrompt, type StarterPrompt } from "@/lib/onboarding";

export interface DemoState {
  exists: boolean;
  /** The demo's project id when it exists, so a caller can navigate to it. */
  projectId: string | null;
}

/** Whether the demo project is in this database, for the Settings button. */
export function demoState(db: Driver): DemoState {
  const row = db.prepare("SELECT id FROM projects WHERE is_demo = 1").get<{ id: string }>();
  return row ? { exists: true, projectId: row.id } : { exists: false, projectId: null };
}

/**
 * Create the demo, dated relative to today, if it is missing. Returns its id
 * and the showcase run's id, which the tutorial opens the tour on.
 *
 * A demo created by this call has deterministic run ids, so the showcase run
 * is known without a lookup. For a demo that already existed, the newest
 * scheduled run is read back, so the tour always opens on a run that is in the
 * database.
 */
export function restoreDemoProject(db: Driver): {
  projectId: string;
  showcaseRunId: string;
} {
  const { projectId, created } = ensureDemoProject(db);
  if (created) return { projectId, showcaseRunId: demoShowcaseRunId() };
  const newest = db
    .prepare(
      `SELECT id FROM runs WHERE project_id = ? AND trigger = 'scheduled'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get<{ id: string }>(projectId);
  return { projectId, showcaseRunId: newest?.id ?? demoShowcaseRunId() };
}

/** The category the tutorial's setup screen shows under the demo brand. */
export const DEMO_CATEGORY = "corporate spend management";

export interface DemoPrefill {
  brandName: string;
  category: string;
  variants: string[];
  domains: string[];
  competitors: string[];
  prompts: StarterPrompt[];
  perceptionPrompt: string;
}

/**
 * What the tutorial mode of the setup screen shows: the demo's brand,
 * competitors and prompts, read from the generator's exports so the screen
 * matches the project it goes on to create. It is served from the server, not
 * kept as a browser constant, so the demo's real brand names stay inside the
 * modules ADR 0006 allows them in.
 */
export function demoPrefill(): DemoPrefill {
  return {
    brandName: DEMO_BRAND.name,
    category: DEMO_CATEGORY,
    variants: [],
    domains: [DEMO_BRAND.domain],
    competitors: DEMO_COMPETITORS.map((competitor) => competitor.name),
    prompts: DEMO_PROMPTS.map((prompt) => ({
      text: prompt.text,
      tag: prompt.category,
      iterations: DEMO_ITERATIONS,
    })),
    perceptionPrompt: defaultPerceptionPrompt(DEMO_BRAND.name),
  };
}
