/**
 * What a run's state should say to a person.
 *
 * `runs.status` is an internal enum: queued, running, completed, partial,
 * failed, cancelled. Rendered directly, a run that collected seven of ten
 * answers would announce itself as PARTIAL, a word about our state machine
 * that also reads as though work is still happening when it has stopped.
 *
 * So this turns the status plus the counters into a headline, a detail line
 * carrying the consequence, and a tone for styling. It lives here, not in the
 * route, so the wording is testable without a DOM.
 *
 * Counts arrive in provider calls and are shown in answers, via toAnswers. See
 * run-progress.ts for why the two units differ.
 */
import { toAnswers } from "./run-progress";

/** Drives styling only. The words carry the meaning. */
export type RunTone = "waiting" | "running" | "success" | "partial" | "failed" | "cancelled";

/**
 * The outstanding tasks of a run, split three ways by the server's recount:
 * `fresh` have not been asked yet, `retrying` failed an attempt and wait on the
 * automatic retry, `working` have a call in flight or an answer being read.
 * With the collected and failed counts, the five buckets sum to the plan, so
 * one sentence can carry every number on the screen without two disagreeing.
 */
export interface PendingBreakdown {
  fresh: number;
  retrying: number;
  working: number;
}

export interface RunOutcome {
  /** Short prose. Never an internal status name. */
  headline: string;
  /** The consequence, in answers. Always says how many arrived. */
  detail: string;
  /** True once the run has stopped, whatever the reason. */
  finished: boolean;
  tone: RunTone;
}

const TERMINAL = ["completed", "partial", "failed", "cancelled"];

function answers(n: number): string {
  return `${n} ${n === 1 ? "answer" : "answers"}`;
}

/**
 * `status` and the counters are typed loose because a SQLite row hands them
 * back as whatever the column allows, nullable included, and a status added to
 * the vocabulary later must not render as a bare token. An unrecognised status
 * reads as still running: nothing says it has stopped, and it keeps the
 * route's polling alive instead of stranding a run that is progressing.
 */
export function runOutcome(
  status: string | null | undefined,
  completedCalls: number | null | undefined,
  failedCalls: number | null | undefined,
  plannedCalls: number | null | undefined,
  pending?: PendingBreakdown | null,
): RunOutcome {
  const done = toAnswers(completedCalls);
  const failed = toAnswers(failedCalls);
  const planned = toAnswers(plannedCalls);
  const finished = TERMINAL.includes(status ?? "");

  switch (status) {
    case "completed":
      // Trust the counters over the status word. A completed run missing
      // answers is a bug elsewhere, and "all 10 collected" would hide it.
      return {
        headline: "Run complete",
        detail:
          done === planned
            ? `All ${answers(planned)} collected.`
            : `${done} of ${answers(planned)} collected.`,
        finished: true,
        tone: "success",
      };

    case "partial":
      return {
        headline: "Run finished with failures",
        // "Failed", not "did not arrive": a task can fail while being scored
        // and still hold its answer, and its row then says "arrived but was
        // never scored". Every surface says "failed", in flight and finished.
        detail: `${done} of ${answers(planned)} collected. ${failed} failed.`,
        finished: true,
        tone: "partial",
      };

    case "failed":
      return {
        headline: "Run failed",
        detail: `No answers collected. All ${answers(planned)} failed.`,
        finished: true,
        tone: "failed",
      };

    case "cancelled":
      // Say what was kept: that is what tells "you stopped this" apart from
      // "this lost your work".
      return {
        headline: "Run canceled",
        detail:
          done > 0
            ? `Stopped after ${answers(done)}, which are kept.`
            : `Stopped before any answers arrived.`,
        finished: true,
        tone: "cancelled",
      };

    case "queued":
      return {
        headline: "Queued",
        detail: `Waiting to start. ${answers(planned)} planned.`,
        finished: false,
        tone: "waiting",
      };

    default: {
      // One sentence that adds up. With the server's split of the outstanding
      // tasks, every bucket is named in one line, and collected + outstanding +
      // retrying + failed is the plan. Without the breakdown (the dashboard's
      // run list), fall back to the counters-only sentence.
      if (!pending) {
        return {
          headline: "Running",
          detail:
            failed > 0
              ? `${done} of ${answers(planned)} collected so far. ${failed} have failed.`
              : `${done} of ${answers(planned)} collected so far.`,
          finished,
          tone: "running",
        };
      }

      const collected = Math.max(
        0,
        planned - failed - pending.fresh - pending.retrying - pending.working,
      );
      const outstanding = pending.fresh + pending.working;
      const clauses = [
        outstanding > 0 ? `${outstanding} still to come back` : null,
        pending.retrying > 0 ? `${pending.retrying} being retried` : null,
        failed > 0 ? `${failed} failed` : null,
      ].filter((clause): clause is string => clause !== null);

      // When retries are the only work left, the headline says so instead of a
      // bare "Running".
      const onlyRetries = outstanding === 0 && pending.retrying > 0;

      return {
        headline: onlyRetries ? "Running retry" : "Running",
        detail:
          `${collected} of ${answers(planned)} collected so far` +
          (clauses.length > 0 ? `: ${clauses.join(", ")}.` : "."),
        finished,
        tone: "running",
      };
    }
  }
}

/** What one task's state should say to a person, and how to colour it. */
export interface TaskState {
  label: string;
  tone: RunTone;
}

/**
 * A single task's state, in words.
 *
 * The run screen lists every task from the start, so the questions still out
 * are visible and a slow assistant can be told from a broken one. Claude
 * routinely takes fifty seconds and sometimes three minutes, so that is most
 * of a run. The labels map one-to-one onto `run_tasks.status` values:
 * `in_flight` is an outstanding provider call, `answered` is an answer in hand
 * that has not been read yet.
 *
 * An unrecognised status reads as "Working", never as the token itself, for
 * the same reason runOutcome does it.
 */
export function taskState(status: string | null | undefined): TaskState {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "waiting" };
    case "in_flight":
      return { label: "Waiting for a response", tone: "running" };
    case "answered":
      return { label: "Response received", tone: "running" };
    case "extracting":
      return { label: "Reading the answer", tone: "running" };
    case "done":
      return { label: "Done", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "blocked":
      // The schema has no `blocked` task status (ADR 0004), so the database
      // never returns this. If one ever appears, it reads as a failed task.
      return { label: "Not run", tone: "failed" };
    default:
      return { label: "Working", tone: "running" };
  }
}
