/**
 * The stored run_metrics rows the screens aggregate with @/lib/metrics.
 *
 * Only level 0 rows are served, the ones keyed by a model and a prompt. The
 * run-wide row has both null. A screen that summed it with the level 0 rows
 * would count every answer twice.
 *
 * Self-referenced prompts, the ones whose text names the project's own brand,
 * never count. Every read here leaves their rows out, for every brand, judged
 * by the own brand's current name and variants. See docs/decisions/0005.
 */
import type { Driver } from "../../db/driver";
import type { RunMetricRow } from "../../db/types";
import { selfReferencedPromptIds } from "@/lib/selfReference";
import { getTargetBrand } from "./brands";

/**
 * How many level 0 rows one read may carry. projectMetricWindow fills it with
 * whole runs, newest first. A plain row cap on the ascending query would keep
 * the oldest rows, and a cap landing mid-run would skew that run's share of
 * voice.
 */
const METRIC_ROW_BUDGET = 5000;

/** A ceiling on the window itself, so the IN list stays a sane size. */
const METRIC_RUN_CEILING = 500;

export interface MetricFilters {
  /**
   * Include runs whose answers came from the mock provider mode.
   *
   * Left unset, mock runs count only while the project has no measured run,
   * which is the demo case. Once a measured run exists, mock numbers stop
   * averaging into the figures, because nothing on screen tells them apart.
   */
  includeMock?: boolean | undefined;
  runIds?: readonly string[] | undefined;
  modelIds?: readonly string[] | undefined;
  promptIds?: readonly string[] | undefined;
  brandIds?: readonly string[] | undefined;
  /** ISO-8601. Rows from runs created before this are left out. */
  since?: string | undefined;
}

export interface MetricWindow {
  rows: RunMetricRow[];
  /** True when older runs were left out because the row budget was full. */
  capped: boolean;
  /** Runs this read carries, and runs it could have carried. */
  runsIncluded: number;
  runsAvailable: number;
  /** True when runs produced by the mock provider mode were left out. */
  mockExcluded: boolean;
}

/**
 * Every level 0 metric row for a project, oldest first, for whole runs.
 *
 * Filtering is offered here as well as in the browser because a long-lived
 * project can hold more rows than a page wants to carry. Which rows count at
 * all is decided here: self-referenced prompts never do, and mock runs stop
 * counting once a measured run exists. The browser's applyFilter only narrows
 * what is left to the dashboard's own filters.
 */
export function listProjectMetrics(
  db: Driver,
  projectId: string,
  filters: MetricFilters = {},
): RunMetricRow[] {
  return projectMetricWindow(db, projectId, filters).rows;
}

/**
 * The same read, with what it had to leave out.
 *
 * The window is chosen by run, not by row: the newest runs are taken whole until
 * the row budget is spent, so a run is either all there or not there at all, and
 * the newest data is the data that survives.
 */
export function projectMetricWindow(
  db: Driver,
  projectId: string,
  filters: MetricFilters = {},
): MetricWindow {
  const where: string[] = ["m.project_id = ?", "m.model_id IS NOT NULL"];
  const params: (string | number)[] = [projectId];

  appendIn(where, params, "m.run_id", filters.runIds);
  appendIn(where, params, "m.model_id", filters.modelIds);
  appendIn(where, params, "m.prompt_id", filters.promptIds);
  appendIn(where, params, "m.brand_id", filters.brandIds);
  appendNotSelfReferenced(where, params, selfReferencedPromptIdsFor(db, projectId));

  if (filters.since) {
    where.push("m.created_at >= ?");
    params.push(filters.since);
  }

  const clause = where.join(" AND ");

  const candidates = db
    .prepare(
      `SELECT m.run_id AS runId, COUNT(*) AS rows, MAX(m.created_at) AS at, r.mock AS mock
         FROM run_metrics m
         JOIN runs r ON r.id = m.run_id
        WHERE ${clause}
        GROUP BY m.run_id
        ORDER BY at DESC, m.run_id DESC`,
    )
    .all<{ runId: string; rows: number; at: string; mock: number }>(...params);

  const measured = candidates.filter((run) => run.mock === 0);
  const keepMock = filters.includeMock === true || measured.length === 0;
  const eligible = keepMock ? candidates : measured;
  const mockExcluded = eligible.length !== candidates.length;

  const chosen: string[] = [];
  let budget = METRIC_ROW_BUDGET;
  for (const run of eligible) {
    // The newest run always comes in whole, however wide it is. A half loaded
    // run is worse than a missing one.
    if (chosen.length > 0 && (budget - run.rows < 0 || chosen.length >= METRIC_RUN_CEILING)) break;
    chosen.push(run.runId);
    budget -= run.rows;
  }

  const window: Omit<MetricWindow, "rows"> = {
    capped: chosen.length < eligible.length,
    runsIncluded: chosen.length,
    runsAvailable: eligible.length,
    mockExcluded,
  };

  if (chosen.length === 0) return { rows: [], ...window };

  const rows = db
    .prepare(
      `SELECT m.* FROM run_metrics m
        WHERE ${clause} AND m.run_id IN (${chosen.map(() => "?").join(", ")})
        ORDER BY m.created_at, m.id`,
    )
    .all<RunMetricRow>(...params, ...chosen);

  return { rows, ...window };
}

/**
 * The project's prompts that name its own brand, decided now from the brand's
 * current name and variants, so editing a variant reclassifies past runs too.
 */
export function selfReferencedPromptIdsFor(db: Driver, projectId: string): string[] {
  const brand = getTargetBrand(db, projectId);
  if (!brand) return [];
  const prompts = db
    .prepare("SELECT id, text FROM prompts WHERE project_id = ?")
    .all<{ id: string; text: string }>(projectId);
  return [...selfReferencedPromptIds(prompts, brand)];
}

/**
 * Leaves out rows for the given prompts. The IS NULL arm keeps the level 1
 * aggregate rows, which have no prompt. Migration 0004 deletes per-prompt rows
 * with a null prompt_id, so no other row takes that arm.
 */
export function appendNotSelfReferenced(
  where: string[],
  params: (string | number)[],
  promptIds: readonly string[],
  column = "m.prompt_id",
): void {
  if (promptIds.length === 0) return;
  where.push(`(${column} IS NULL OR ${column} NOT IN (${promptIds.map(() => "?").join(", ")}))`);
  params.push(...promptIds);
}

function appendIn(
  where: string[],
  params: (string | number)[],
  column: string,
  values: readonly string[] | undefined,
): void {
  if (!values) return;
  if (values.length === 0) {
    // An empty selection means "none", not "all".
    where.push("1 = 0");
    return;
  }
  where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}
