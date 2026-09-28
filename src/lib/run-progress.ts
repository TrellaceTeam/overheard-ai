/**
 * Runs are counted in provider calls in the database and shown in answers in
 * the UI. CALLS_PER_ANSWER is the factor: the planner and the recount multiply
 * by it and every display site divides by it.
 *
 * Collecting one answer takes two provider calls: one to ask the assistant the
 * prompt, and one to have the extraction model read its reply for who was
 * recommended, in what order, and which sources were cited. planned_calls and
 * failed_calls are whole tasks times the factor. completed_calls also counts
 * one call for each task whose answer has arrived but is not read yet, so it
 * can be odd while a run is in flight.
 *
 * Calls are the right unit for cost and for the queue, but the wrong one for a
 * person. Users choose prompts and iterations, so two prompts at five
 * iterations is ten to them, and showing twenty reads as a bug. There is one
 * `run_tasks` row per answer, so the halved numbers are task counts.
 */
export const CALLS_PER_ANSWER = 2;

/**
 * Provider calls as stored, converted to the answers a person asked for. An
 * answer that has arrived but is not read yet counts as half, and halves round
 * up.
 */
export function toAnswers(calls: number | null | undefined): number {
  return Math.round((calls ?? 0) / CALLS_PER_ANSWER);
}
