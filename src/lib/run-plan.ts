import { CALLS_PER_ANSWER } from "./run-progress";

/** A run's size before anything is spent. */
export interface RunPlanCounts {
  prompts: number;
  assistants: number;
  /** Total iterations times assistants. */
  answers: number;
  /** answers × CALLS_PER_ANSWER. What runs.planned_calls will hold. */
  calls: number;
}

/**
 * Every prompt at its own iterations, on every assistant, with one more call to
 * read each answer back. The server's planner and the setup wizard both size a
 * run with this, so the preview and the run cannot disagree.
 */
export function planCounts(prompts: number, iterations: number, assistants: number): RunPlanCounts {
  const answers = iterations * assistants;
  return { prompts, assistants, answers, calls: answers * CALLS_PER_ANSWER };
}

/** The calls a first run adds by asking each assistant once what it knows about the brand. */
export function perceptionCallsFor(assistants: number): number {
  return assistants * CALLS_PER_ANSWER;
}

/**
 * The plan for a project that does not exist yet. Its run is always a first
 * run, and the wizard refuses a blank perception prompt, so it always asks the
 * perception question too.
 */
export function newProjectPlan(
  prompts: readonly { iterations: number }[],
  assistants: number,
): RunPlanCounts & { perceptionCalls: number } {
  const iterations = prompts.reduce((sum, prompt) => sum + prompt.iterations, 0);
  return {
    ...planCounts(prompts.length, iterations, assistants),
    perceptionCalls: perceptionCallsFor(assistants),
  };
}
