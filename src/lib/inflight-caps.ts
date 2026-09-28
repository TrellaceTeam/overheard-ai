/**
 * The bounds of a provider's calls in flight, in one place every side can
 * import: the worker's resolution, the Account settings field and its
 * sentence, and the API validator. Outside this file, only the SQL CHECK in
 * migration 0010 repeats them, because SQL cannot import TypeScript. If a
 * value changes here, change it there in a new migration.
 */

/** Zero would leave the provider's tasks queued forever. */
export const INFLIGHT_CAP_MIN = 1;

/**
 * The worker's BATCH_SIZE: a pass claims at most that many tasks, so a higher
 * cap could never be reached.
 */
export const INFLIGHT_CAP_MAX = 15;

/** A whole number inside the bounds: the only value the column admits. */
export function isInflightCap(value: number): boolean {
  return Number.isInteger(value) && value >= INFLIGHT_CAP_MIN && value <= INFLIGHT_CAP_MAX;
}

/**
 * The field's parser: a cap inside the bounds, or null so the field can say
 * what is wrong instead of sending a save that will be refused.
 */
export function parseInflightCap(text: string): number | null {
  const cleaned = text.trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return isInflightCap(value) ? value : null;
}
