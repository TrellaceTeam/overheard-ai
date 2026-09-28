/**
 * Prompt results summaries: what the assistants have answered to one prompt
 * across every run, in a paragraph, bought on demand from the project's
 * extraction model. It reuses the run page's answer summary instructions,
 * model choice and cost estimate.
 *
 * The rules this module owns:
 * - a summary reads the prompt's newest runs first under one character
 *   budget, and the screen's disclosure and cost come from the same plan as
 *   the call;
 * - the rough cost is shown before anything is bought;
 * - the result is stored per prompt, and asking again replaces it;
 * - a run that finishes with answers for the prompt after the summary was
 *   written marks it outdated, and nothing is re-bought on its own;
 * - the spend is logged, with no run, on success and on a failure that may
 *   have billed;
 * - it never counts in any statistic.
 *
 * The demo project is refused here like every other write. The call goes
 * through the worker's provider layer, so the mock provider mode covers it and
 * no key passes through this module.
 */
import type { Driver } from "../../db/driver";
import { FEED_BUDGET_CHARS, lastRuns, type FeedCounts } from "@/lib/prompt-results";
import {
  readPromptResultsSummaries,
  savePromptResultsSummary,
  type PromptResultsSummaryRow,
} from "../../logic/prompt-results-summary";
import { buyProse, estimateSummaryCost } from "./buy-prose";
import { pickSummaryModel, SUMMARY_SYSTEM, type SummaryCall } from "./summaries";
import { InvalidInputError, NotFoundError, refuseDemoForPrompt } from "./shared";

/**
 * The run-level summary's instructions, so tuning them tunes both, plus a note
 * that the answers span runs.
 */
const PROMPT_RESULTS_SYSTEM = `${SUMMARY_SYSTEM} The answers come from several runs of the question over time, grouped under the date each run started, newest run first; when what they say changed between runs, say how.`;

/** A finished answer to the prompt, as the summary reads it. */
const ANSWERED = `t.status = 'done' AND t.is_perception = 0
   AND t.answer_text IS NOT NULL AND t.answer_text != ''`;

/** Newest run first, and inside a run the order its answers were asked in. */
const NEWEST_RUN_FIRST = "ORDER BY r.created_at DESC, r.id DESC, t.created_at, t.id";

/** The same per-answer slice as the run-level summary. */
const ANSWER_SLICE = 8_000;

interface FeedPlan {
  runCount: number;
  answerCount: number;
  /** The characters those answers put in the prompt, for the cost estimate. */
  chars: number;
}

/**
 * Which answers a summary reads: in the order given (newest run first), each
 * sliced like the run-level summary's, until the next one would pass the
 * budget. The oldest runs are the ones that fall off. The screen's disclosure
 * and cost come from this, and so does the call, so they cannot disagree.
 */
function planFeed(answers: readonly { runId: string; chars: number }[]): FeedPlan {
  const runs = new Set<string>();
  let chars = 0;
  let answerCount = 0;
  for (const answer of answers) {
    const slice = Math.min(answer.chars, ANSWER_SLICE);
    if (chars + slice > FEED_BUDGET_CHARS) break;
    chars += slice;
    answerCount += 1;
    runs.add(answer.runId);
  }
  return { runCount: runs.size, answerCount, chars };
}

/** The user prompt: the question, then the fed answers numbered under their run. */
function feedPrompt(
  question: string,
  answers: readonly { runId: string; runCreatedAt: string; text: string }[],
  runCount: number,
): string {
  const blocks: string[] = [];
  let run: string | null = null;
  for (const [index, answer] of answers.entries()) {
    if (answer.runId !== run) {
      run = answer.runId;
      blocks.push(`Run of ${answer.runCreatedAt.slice(0, 10)}:`);
    }
    blocks.push(`[${index + 1}]\n${answer.text.slice(0, ANSWER_SLICE)}`);
  }
  const answersFrom = `${answers.length} ${answers.length === 1 ? "answer" : "answers"} from ${lastRuns(runCount)}`;
  return `Question:\n---\n${question}\n---\n\n${answersFrom}, newest run first:\n\n${blocks.join("\n\n")}`;
}

/** One prompt's fold on the Prompts tab. */
export interface PromptResultsSummaryView {
  promptId: string;
  /** Every answer the prompt has, across runs. */
  totalAnswers: number;
  /** What asking now would read. */
  feed: { runCount: number; answerCount: number };
  /** Rough cost of asking now, priced from that feed at list prices. */
  costUsd: number;
  /** The stored summary, with what it read when it was written. */
  saved: (FeedCounts & { summary: string; createdAt: string }) | null;
  /** Set when a run finished with answers for this prompt after the summary was written. */
  outdated: { newAnswers: number } | null;
}

/**
 * Every prompt in the project that has answers, with its stored summary if
 * any, for the Prompts tab's folds. It reads lengths only, never answer text,
 * because it runs on every visit to the tab and the plan needs nothing more.
 */
export function listPromptResultsSummaries(
  db: Driver,
  projectId: string,
): PromptResultsSummaryView[] {
  // Through the project's prompts, so the answers are found by the
  // (prompt_id, status) index instead of a scan of every project's tasks, each
  // of whose text length() would read. CROSS JOIN is SQLite's join-order hint:
  // left alone, the planner scans run_tasks first.
  const rows = db
    .prepare(
      `SELECT t.prompt_id AS promptId, t.run_id AS runId, length(t.answer_text) AS chars
         FROM prompts p
         CROSS JOIN run_tasks t ON t.prompt_id = p.id
         JOIN runs r ON r.id = t.run_id
        WHERE p.project_id = ? AND ${ANSWERED}
        ${NEWEST_RUN_FIRST}`,
    )
    .all<{ promptId: string; runId: string; chars: number }>(projectId);

  const byPrompt = new Map<string, { runId: string; chars: number }[]>();
  for (const row of rows) {
    const list = byPrompt.get(row.promptId);
    if (list) list.push(row);
    else byPrompt.set(row.promptId, [row]);
  }

  const model = pickSummaryModel(db, projectId);
  const saved = new Map<string, PromptResultsSummaryRow>(
    readPromptResultsSummaries(db, projectId).map((row) => [row.promptId, row]),
  );
  const outdated = outdatedPromptIds(db, projectId);

  return [...byPrompt.entries()].map(([promptId, answers]) => {
    const plan = planFeed(answers);
    const stored = saved.get(promptId);
    return {
      promptId,
      totalAnswers: answers.length,
      feed: { runCount: plan.runCount, answerCount: plan.answerCount },
      costUsd: estimateSummaryCost(model, plan.chars),
      saved: stored
        ? {
            summary: stored.summary,
            runCount: stored.runCount,
            answerCount: stored.answerCount,
            totalAnswers: stored.totalAnswers,
            createdAt: stored.createdAt,
          }
        : null,
      outdated:
        stored && outdated.has(promptId)
          ? { newAnswers: Math.max(0, answers.length - stored.totalAnswers) }
          : null,
    };
  });
}

/**
 * The prompts whose stored summary is outdated: a run that finished after the
 * summary was written has done answers for the prompt. Answers carry no
 * timestamp of their own, so the run's finish is the clock. A run still going
 * flags nothing until it finishes, and nothing is ever re-bought: the screen
 * shows the flag and a re-ask.
 */
function outdatedPromptIds(db: Driver, projectId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.prompt_id AS promptId
         FROM prompt_summaries s
         JOIN run_tasks t ON t.prompt_id = s.prompt_id
         JOIN runs r ON r.id = t.run_id
        WHERE s.project_id = ? AND ${ANSWERED}
          AND r.finished_at > s.created_at`,
    )
    .all<{ promptId: string }>(projectId);
  return new Set(rows.map((row) => row.promptId));
}

export interface SummarizePromptResultsResult {
  summary: string;
  answerCount: number;
  runCount: number;
  totalAnswers: number;
  costUsd: number;
}

/** Buy one prompt's results summary and store it, replacing any previous one. */
export async function summarizePromptResults(
  db: Driver,
  promptId: string,
  call?: SummaryCall,
): Promise<SummarizePromptResultsResult> {
  refuseDemoForPrompt(db, promptId);

  const prompt = db
    .prepare("SELECT project_id, text FROM prompts WHERE id = ?")
    .get<{ project_id: string; text: string }>(promptId);
  if (!prompt) throw new NotFoundError("PROMPT_NOT_FOUND", "that question does not exist");

  const model = pickSummaryModel(db, prompt.project_id);
  if (!model) {
    throw new InvalidInputError(
      "NO_EXTRACTOR",
      "no extraction model is available to write summaries",
    );
  }

  // Stamped before the answers are read: the summary describes this moment,
  // and a run that finishes while the call is out must count as unread.
  const readAt = new Date().toISOString();

  // Planned from lengths, then only the planned answers are read, in the same
  // order: a prompt with a year of answers never loads the ones that fall off.
  const answers = db
    .prepare(
      `SELECT t.run_id AS runId, length(t.answer_text) AS chars
         FROM run_tasks t
         JOIN runs r ON r.id = t.run_id
        WHERE t.prompt_id = ? AND ${ANSWERED}
        ${NEWEST_RUN_FIRST}`,
    )
    .all<{ runId: string; chars: number }>(promptId);
  if (answers.length === 0) {
    throw new InvalidInputError("NO_ANSWERS", "this question has no answers to summarize yet");
  }
  const plan = planFeed(answers);
  const fed = db
    .prepare(
      `SELECT t.run_id AS runId, r.created_at AS runCreatedAt, t.answer_text AS text
         FROM run_tasks t
         JOIN runs r ON r.id = t.run_id
        WHERE t.prompt_id = ? AND ${ANSWERED}
        ${NEWEST_RUN_FIRST}
        LIMIT ?`,
    )
    .all<{ runId: string; runCreatedAt: string; text: string }>(promptId, plan.answerCount);
  const user = feedPrompt(prompt.text, fed, plan.runCount);

  const { summary, costUsd } = await buyProse(
    {
      db,
      model,
      system: PROMPT_RESULTS_SYSTEM,
      user,
      sentChars: PROMPT_RESULTS_SYSTEM.length + user.length,
      kind: "prompt_summary",
      runId: null,
    },
    call,
  );

  savePromptResultsSummary(db, {
    projectId: prompt.project_id,
    promptId,
    summary,
    answerCount: plan.answerCount,
    runCount: plan.runCount,
    totalAnswers: answers.length,
    modelId: model.id,
    costUsd,
    createdAt: readAt,
  });

  return {
    summary,
    answerCount: plan.answerCount,
    runCount: plan.runCount,
    totalAnswers: answers.length,
    costUsd,
  };
}
