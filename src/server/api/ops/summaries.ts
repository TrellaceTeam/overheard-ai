/**
 * Answer summaries: what the assistants said to one prompt in one run, in a
 * paragraph, bought on demand from the project's extraction model.
 *
 * The rules this module owns: a summary is asked for by a person, its rough
 * cost is shown before it is bought, the result is stored per (run, prompt) so
 * later visits do not pay again, asking again replaces it, and it never counts
 * in any statistic. The demo project is refused here like every other write.
 *
 * The call goes through the worker's provider layer, so the mock provider mode
 * covers summaries too and no key passes through this module.
 */
import type { Driver } from "../../db/driver";
import type { ModelRow } from "../../db/types";
import {
  listAnswerSummaries,
  saveAnswerSummary,
  type AnswerSummaryRow,
} from "../../logic/answer-summary";
import { resolveExtractionModel } from "../../worker/extractor";
import { buyProse, estimateSummaryCost, type ProseCall } from "./buy-prose";
import { InvalidInputError, NotFoundError, refuseDemoForRun } from "./shared";

// The spend rules and their constants live in ./buy-prose. Re-exported for the
// tests that import them from here.
export { estimateSummaryCost, SUMMARY_MAX_TOKENS } from "./buy-prose";

export const SUMMARY_SYSTEM = `You summarize what several AI assistants answered to the same question, for a marketer monitoring how their brand is recommended. Write two to five sentences of plain prose: no headings, no lists, no markdown. Open with the count that matters, for example "8 of the 10 answers recommend Acme". Name the brands the answers actually mention, and say where the answers disagreed or warned about something. Use only what the answers say; never add your own recommendations or outside knowledge.`;

/** Characters of one answer sent to the summarizer. The median answer is about 1,600. */
const ANSWER_SLICE = 8_000;

/** The whole user prompt's budget, so a huge run cannot outgrow the cheap model. */
const TOTAL_SLICE = 120_000;

/** Answers past this are not sent to the summarizer. */
export const MAX_ANSWERS = 50;

/** A finished, non-perception answer to a prompt, the kind a summary reads. */
const SUMMARIZABLE = `t.status = 'done' AND t.is_perception = 0 AND t.prompt_id IS NOT NULL
  AND t.answer_text IS NOT NULL AND t.answer_text != ''`;

/**
 * How many answers a summary reads, in order, and how many characters of them:
 * at most MAX_ANSWERS, each cut to ANSWER_SLICE, stopping before the one that
 * would pass TOTAL_SLICE. The count and cost shown before buying and the
 * answers sent when buying both come from here.
 */
export function summaryFeedSize(lengths: readonly number[]): { count: number; chars: number } {
  let count = 0;
  let chars = 0;
  for (const length of lengths.slice(0, MAX_ANSWERS)) {
    const slice = Math.min(length, ANSWER_SLICE);
    if (chars + slice > TOTAL_SLICE) break;
    chars += slice;
    count += 1;
  }
  return { count, chars };
}

/** The answers a summary is sent, each already cut to its slice. */
export function summaryFeed(answers: readonly string[]): string[] {
  const { count } = summaryFeedSize(answers.map((answer) => answer.length));
  return answers.slice(0, count).map((answer) => answer.slice(0, ANSWER_SLICE));
}

export function summaryUserPrompt(question: string, answers: readonly string[]): string {
  const blocks = summaryFeed(answers).map((slice, index) => `[${index + 1}]\n${slice}`);
  return `Question:\n---\n${question}\n---\n\n${blocks.length} answers from different assistants:\n\n${blocks.join("\n\n")}`;
}

/**
 * Which model writes summaries: resolveExtractionModel, the resolution every
 * extraction call uses. That is the project's preferred extractor when its
 * provider has a key, else the cheapest keyed candidate, else null.
 */
export function pickSummaryModel(db: Driver, projectId: string): ModelRow | null {
  return resolveExtractionModel(db, projectId);
}

/** One prompt's row in the run page's summary section. */
export interface PromptSummaryView {
  promptId: string;
  promptText: string;
  /** Answers to this prompt in this run. */
  answerCount: number;
  /** How many of them a summary asked now would read (summaryFeedSize). */
  feedCount: number;
  /** Rough cost of asking now, at list prices. Not zeroed under the mock provider mode. */
  costUsd: number;
  /** The stored summary, when this prompt has one. */
  saved: { summary: string; answerCount: number; createdAt: string } | null;
}

/**
 * Every prompt with answers in the run, with its stored summary if any, for
 * the run page's summary section. One grouped read plus the summaries, cheap
 * enough to include in getRunDetail.
 */
export function listPromptSummaries(db: Driver, runId: string): PromptSummaryView[] {
  const run = db
    .prepare("SELECT project_id FROM runs WHERE id = ?")
    .get<{ project_id: string }>(runId);
  if (!run) throw new NotFoundError("RUN_NOT_FOUND", "that run does not exist");

  const stats = db
    .prepare(
      `SELECT t.prompt_id AS promptId,
              coalesce(p.text, max(t.question_text), 'Question not recorded') AS promptText,
              count(*) AS answerCount
         FROM run_tasks t
         LEFT JOIN prompts p ON p.id = t.prompt_id
        WHERE t.run_id = ? AND ${SUMMARIZABLE}
        GROUP BY t.prompt_id
        ORDER BY min(t.created_at), t.prompt_id`,
    )
    .all<{ promptId: string; promptText: string; answerCount: number }>(runId);

  // Each answer's length, in the order summarizePromptAnswers sends them.
  // SQLite counts characters where JavaScript counts UTF-16 units, so an
  // answer full of emoji on the budget's edge can land on the other side of
  // it; the count stored with a summary is always what was sent.
  const lengths = new Map<string, number[]>();
  for (const row of db
    .prepare(
      `SELECT t.prompt_id AS promptId, length(t.answer_text) AS chars FROM run_tasks t
        WHERE t.run_id = ? AND ${SUMMARIZABLE}
        ORDER BY t.created_at, t.id`,
    )
    .all<{ promptId: string; chars: number }>(runId)) {
    const list = lengths.get(row.promptId);
    if (list) list.push(row.chars);
    else lengths.set(row.promptId, [row.chars]);
  }

  const model = pickSummaryModel(db, run.project_id);
  const saved = new Map<string, AnswerSummaryRow>(
    listAnswerSummaries(db, runId).map((row) => [row.promptId, row]),
  );

  return stats.map((row) => {
    const hit = saved.get(row.promptId);
    const feed = summaryFeedSize(lengths.get(row.promptId) ?? []);
    return {
      promptId: row.promptId,
      promptText: row.promptText,
      answerCount: row.answerCount,
      feedCount: feed.count,
      costUsd: estimateSummaryCost(model, feed.chars),
      saved: hit
        ? { summary: hit.summary, answerCount: hit.answerCount, createdAt: hit.createdAt }
        : null,
    };
  });
}

/** Injected in tests, like the setup check's probe: no network, no keys. */
export type SummaryCall = ProseCall;

export interface SummarizeResult {
  summary: string;
  answerCount: number;
  costUsd: number;
}

/**
 * Buy one prompt's summary and store it, replacing any previous one.
 *
 * The spend is logged in usage_events as kind `summary`: a summary that came
 * back at list price, and a failed call that may have billed at the worst-case
 * estimate, so the run's spend line does not under-report.
 */
export async function summarizePromptAnswers(
  db: Driver,
  runId: string,
  promptId: string,
  call?: SummaryCall,
): Promise<SummarizeResult> {
  refuseDemoForRun(db, runId);

  const run = db
    .prepare("SELECT project_id FROM runs WHERE id = ?")
    .get<{ project_id: string }>(runId);
  if (!run) throw new NotFoundError("RUN_NOT_FOUND", "that run does not exist");

  const model = pickSummaryModel(db, run.project_id);
  if (!model) {
    throw new InvalidInputError(
      "NO_EXTRACTOR",
      "no extraction model is available to write summaries",
    );
  }

  const rows = db
    .prepare(
      `SELECT t.answer_text, t.question_text FROM run_tasks t
        WHERE t.run_id = ? AND t.prompt_id = ? AND ${SUMMARIZABLE}
        ORDER BY t.created_at, t.id`,
    )
    .all<{ answer_text: string; question_text: string | null }>(runId, promptId);
  if (rows.length === 0) {
    throw new InvalidInputError(
      "NO_ANSWERS",
      "this question has no answers in this run to summarize",
    );
  }

  const question =
    db.prepare("SELECT text FROM prompts WHERE id = ?").get<{ text: string }>(promptId)?.text ??
    rows.find((row) => row.question_text)?.question_text ??
    "Question not recorded";
  const answers = rows.map((row) => row.answer_text);
  const user = summaryUserPrompt(question, answers);
  // The summary is labelled with what the model read, not with every answer.
  const answerCount = summaryFeed(answers).length;

  const { summary, costUsd } = await buyProse(
    {
      db,
      model,
      system: SUMMARY_SYSTEM,
      user,
      sentChars: SUMMARY_SYSTEM.length + user.length,
      kind: "summary",
      runId,
    },
    call,
  );

  saveAnswerSummary(db, {
    runId,
    projectId: run.project_id,
    promptId,
    summary,
    answerCount,
    modelId: model.id,
    costUsd,
  });

  return { summary, answerCount, costUsd };
}
