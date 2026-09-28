/**
 * The dashboard's filter state, and the function that applies it.
 *
 * Every number on the dashboard derives from a single filtered row set, so two
 * figures on one screen always describe the same population. Rates recompute
 * their own denominators, because `aggregate` takes the filtered rows as its
 * denominator scope.
 *
 * Kept out of the route so the perception band can filter by the same state,
 * and so the date arithmetic and working out which filter emptied the page are
 * testable without rendering anything.
 */
import type { MetricRow } from "./metrics";

export type Period = "all" | "7d" | "30d" | "90d";

export const PERIODS: ReadonlyArray<{ value: Period; label: string; days: number | null }> = [
  { value: "all", label: "All time", days: null },
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
];

export function periodLabel(period: Period): string {
  return PERIODS.find((p) => p.value === period)?.label ?? "All time";
}

/**
 * The earliest instant a row may carry, or null for no lower bound.
 *
 * A rolling window from now, not a calendar month, so "last 7 days" means the
 * last seven days on any day of the month.
 */
export function periodStart(period: Period, now: number): number | null {
  const days = PERIODS.find((p) => p.value === period)?.days ?? null;
  return days === null ? null : now - days * 24 * 60 * 60 * 1000;
}

/**
 * The name on the assistant, which is not the name of the company that makes
 * it. `providerLabel` in failure-reasons.ts gives "Anthropic", which is right
 * for attributing a fault to whoever has to fix it; a filter over assistants
 * has to say "Claude", because that is what the answer came from.
 */
const ASSISTANT_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Gemini",
};

export function assistantLabel(provider: string): string {
  return ASSISTANT_LABELS[provider.toLowerCase()] ?? provider;
}

/** Fixed display order, so the strip cannot reorder itself between renders. */
const ASSISTANT_ORDER = ["anthropic", "openai", "google"];

export function orderAssistants(providers: Iterable<string>): string[] {
  const rank = (p: string) => {
    const i = ASSISTANT_ORDER.indexOf(p);
    return i === -1 ? ASSISTANT_ORDER.length : i;
  };
  return [...new Set(providers)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export type DashboardFilter = {
  /**
   * Selected assistants, by provider slug. `null` means every assistant, which
   * is both the default and what has to be shown before the project's model
   * list has loaded: an array cannot express that, since an empty one already
   * means "none selected".
   */
  assistants: string[] | null;
  /** A prompt id, or "all". */
  promptId: string;
  period: Period;
};

export type FilterContext = {
  providerOf: (modelId: string | null) => string | null;
  now: number;
};

export const NO_FILTER: DashboardFilter = {
  assistants: null,
  promptId: "all",
  period: "all",
};

export function applyFilter(
  rows: MetricRow[],
  filter: DashboardFilter,
  ctx: FilterContext,
): MetricRow[] {
  const start = periodStart(filter.period, ctx.now);
  return rows.filter((row) => {
    if (filter.assistants !== null) {
      const provider = ctx.providerOf(row.model_id);
      if (provider === null || !filter.assistants.includes(provider)) return false;
    }
    if (filter.promptId !== "all" && row.prompt_id !== filter.promptId) return false;
    if (start !== null && new Date(row.created_at).getTime() < start) return false;
    return true;
  });
}

/**
 * Which filter emptied the page, as a sentence, or null if it is not empty.
 *
 * "No data for this filter yet" beside three controls is a shrug. Any filter
 * that produces nothing *on its own* is a culprit, so each is re-applied alone
 * against the unfiltered rows; if none of them empties the page by itself, then
 * the combination did and that is what gets said.
 *
 * Returns null when there are no rows at all, because that is not a filter
 * problem. The caller has better words for a project with no scored runs.
 */
export function emptyReason(
  rows: MetricRow[],
  filter: DashboardFilter,
  ctx: FilterContext,
): string | null {
  if (rows.length === 0) return null;
  if (applyFilter(rows, filter, ctx).length > 0) return null;

  if (filter.assistants !== null && filter.assistants.length === 0) {
    return "No assistants selected. Turn at least one back on to see your numbers.";
  }

  const alone = (patch: Partial<DashboardFilter>) =>
    applyFilter(rows, { ...NO_FILTER, ...patch }, ctx).length;

  if (filter.period !== "all" && alone({ period: filter.period }) === 0) {
    return `No runs in the ${periodLabel(filter.period).toLowerCase()}.`;
  }
  if (filter.assistants !== null && alone({ assistants: filter.assistants }) === 0) {
    const names = orderAssistants(filter.assistants).map(assistantLabel);
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
    return `No answers from ${list} yet.`;
  }
  if (filter.promptId !== "all" && alone({ promptId: filter.promptId }) === 0) {
    return "No data for the selected prompt yet.";
  }
  return "No data for this combination of filters yet.";
}

/** Anything carrying the assistant that produced it. */
export type ModelScopedRow = { model_id: string | null };

/**
 * The filter as it applies to a perception summary. Only the assistant
 * selection applies:
 *
 *   assistants: applies. The band narrows to the selected assistants, and
 *   comparing what each one says is why summaries are stored per assistant.
 *
 *   period: does not apply. A summary is the current state of what an
 *   assistant says, not a measurement taken on a date. There is one row per
 *   assistant, replaced when the question is asked again. Filtering it by
 *   period would empty the band whenever the last ask fell outside the window,
 *   and report "no perception data" about a project that has plenty.
 *
 *   promptId: does not apply. A perception answer has no prompt_id, because it
 *   is not one of the prompts in that list. Filtering to a prompt must not
 *   empty the band.
 */
export function applyPerceptionFilter<T extends ModelScopedRow>(
  rows: T[],
  filter: DashboardFilter,
  ctx: FilterContext,
): T[] {
  if (filter.assistants === null) return rows;
  const chosen = filter.assistants;
  return rows.filter((row) => {
    const provider = ctx.providerOf(row.model_id);
    return provider !== null && chosen.includes(provider);
  });
}
