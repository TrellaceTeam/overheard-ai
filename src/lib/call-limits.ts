/**
 * The run call ceiling's numbers, in one place every side can import: the
 * server logic layer, the Settings screen's field parser and sentence, the API
 * validator, and the plan panel's fallback. Outside this file, only the SQL
 * CHECK and column default in migration 0005 repeat them, because SQL cannot
 * import TypeScript. If a value changes here, change it there in a new
 * migration.
 */

/**
 * The plan ceiling when the install has not chosen one. It is tight so a large
 * run is refused with a sentence pointing at Settings and a person raises the
 * limit, instead of an accidental run spending real money. The live value is
 * app_state.max_planned_calls, read per plan.
 */
export const DEFAULT_MAX_PLANNED_CALLS = 1_000;

/** Bounds for the setting itself. */
export const CALL_LIMIT_MIN = 1;
export const CALL_LIMIT_MAX = 10_000_000;
