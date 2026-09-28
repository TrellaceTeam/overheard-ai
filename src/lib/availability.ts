/**
 * Three-state answers for "can the user have this?" and "is there anything here?".
 *
 * A query that has not landed yet, or that failed, is not a "no". Reading
 * `Boolean(settings?.scheduler_enabled)` while the row is in flight would tell
 * users a working feature is unavailable. Undefined data must never collapse
 * into a denial or an emptiness claim.
 */

export type Availability =
  | { state: "loading" }
  | { state: "unknown"; reason: string }
  | { state: "on" }
  | { state: "off"; reason: string };

export type ListState<T> =
  | { state: "loading" }
  | { state: "unknown"; reason: string }
  | { state: "empty" }
  | { state: "ready"; rows: T[] };

export const CHECK_FAILED = "We could not check this just now.";
export const LOAD_FAILED = "We could not load this just now.";

/**
 * Resolve a feature gate. `value` is only consulted once the query has both
 * settled and succeeded, so "loading" and "we could not check" can never be
 * reported as "off".
 */
export function resolveFeature(input: {
  isPending: boolean;
  isError: boolean;
  value: boolean | null | undefined;
  offReason: string;
  errorReason?: string;
}): Availability {
  if (input.isPending) return { state: "loading" };
  if (input.isError) return { state: "unknown", reason: input.errorReason ?? CHECK_FAILED };
  if (input.value === null || input.value === undefined) {
    return { state: "unknown", reason: input.errorReason ?? CHECK_FAILED };
  }
  return input.value ? { state: "on" } : { state: "off", reason: input.offReason };
}

/**
 * Resolve a collection so "loading", "we could not load this" and "genuinely
 * empty" stay three separate things on screen.
 */
export function resolveList<T>(input: {
  isPending: boolean;
  isError: boolean;
  rows: T[] | null | undefined;
  errorReason?: string;
}): ListState<T> {
  if (input.isPending) return { state: "loading" };
  if (input.isError) return { state: "unknown", reason: input.errorReason ?? LOAD_FAILED };
  if (!input.rows) return { state: "unknown", reason: input.errorReason ?? LOAD_FAILED };
  return input.rows.length === 0 ? { state: "empty" } : { state: "ready", rows: input.rows };
}

/** Rows to render, whatever the state. Never invents emptiness. */
export function listRows<T>(list: ListState<T>): T[] {
  return list.state === "ready" ? list.rows : [];
}
