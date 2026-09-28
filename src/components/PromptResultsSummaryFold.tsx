import { useState } from "react";
import { Info, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { money } from "@/lib/money";
import { FEED_BUDGET_CHARS, lastRuns, type FeedCounts } from "@/lib/prompt-results";

export interface PromptResultsFoldRow {
  promptId: string;
  /** Every answer the prompt has, across runs. */
  totalAnswers: number;
  /** What asking now would read: the newest runs that fit the budget. */
  feed: { runCount: number; answerCount: number };
  /** Rough cost of asking now, at list prices, from that feed. */
  costUsd: number;
  /** The stored summary, with what it read when it was written. */
  saved: (FeedCounts & { summary: string; createdAt: string }) | null;
  /** Set when a run finished with answers for this prompt after the summary was written. */
  outdated: { newAnswers: number } | null;
}

const BUDGET_RULE = `A summary reads this prompt's answers newest run first, until it has about ${FEED_BUDGET_CHARS.toLocaleString("en-US")} characters (roughly ${(FEED_BUDGET_CHARS / 4).toLocaleString("en-US")} tokens). Short answers let more runs in and long ones fewer, and the oldest runs are left out first.`;

/** The sentence that says what a summary reads: runs, and answers of the prompt's total. */
export function feedDisclosure({ runCount, answerCount, totalAnswers }: FeedCounts): string {
  const total = `${totalAnswers} ${totalAnswers === 1 ? "answer" : "answers"}`;
  return `Summarizes ${lastRuns(runCount)} of this prompt (${answerCount} of ${total})`;
}

/** What the button promises: the answers it reads and what that costs. */
export function askLabel(answerCount: number, costUsd: number, again: boolean): string {
  const verb = again ? "Re-ask" : "Summarize";
  const cost = costUsd > 0 ? `, about ${money(costUsd)}` : "";
  return `${verb} ${answerCount} ${answerCount === 1 ? "answer" : "answers"}${cost}`;
}

/** Why the summary is outdated, counted from the answers the prompt had when it was written. */
function newAnswersLine(newAnswers: number): string {
  // A retry that re-finishes an older run moves the clock without adding an
  // answer to this prompt, so the flag can stand on a run alone.
  if (newAnswers === 0) return "A run finished with answers for this prompt since it was written.";
  return `${newAnswers} new ${newAnswers === 1 ? "answer" : "answers"} since it was written.`;
}

/**
 * One prompt's results summary on the Prompts tab: a fold under the prompt row
 * that says what a summary of its answers across runs would read and cost and,
 * once asked, shows the stored paragraph, flagged when a run has finished
 * since.
 *
 * Folded by default, so a library of prompts is not a wall of buttons. The
 * Outdated flag sits on the fold's own line so it is seen without opening. The
 * route owns the server call, the busy state and the toasts.
 */
export function PromptResultsSummaryFold({
  row,
  busy = false,
  locked = null,
  onAsk,
}: {
  row: PromptResultsFoldRow;
  /** This prompt's call is in flight. */
  busy?: boolean | undefined;
  /** When set, asking is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
  onAsk: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { saved, outdated } = row;
  // What the disclosure describes: the stored paragraph's own reading once
  // there is one, otherwise what asking now would read.
  const disclosed: FeedCounts = saved ?? { ...row.feed, totalAnswers: row.totalAnswers };

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles className="size-3.5" />
        Prompt results summary
        {outdated ? (
          <span className="text-warn">Outdated summary</span>
        ) : saved ? (
          <span className="num">Written {new Date(saved.createdAt).toLocaleDateString()}</span>
        ) : null}
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-2 pl-5">
          {/* Inline, not flex: on a narrow screen the icon wraps with the
              sentence's last word instead of dropping to a line of its own. */}
          <p className="type-meta">
            <span className="num">{feedDisclosure(disclosed)}</span>{" "}
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="How the answers are chosen"
                    className="inline-flex size-6 cursor-help items-center justify-center align-middle text-muted-foreground hover:text-foreground"
                  >
                    <Info className="size-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{BUDGET_RULE}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </p>

          {saved && (
            <p className="max-w-prose whitespace-pre-wrap text-sm text-muted-foreground">
              {saved.summary}
            </p>
          )}

          {outdated && <p className="text-xs text-warn">{newAnswersLine(outdated.newAnswers)}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant={saved && !outdated ? "ghost" : "outline"}
              size="sm"
              disabled={busy || locked !== null}
              title={locked ?? undefined}
              onClick={onAsk}
            >
              {busy ? (
                <Loader2 className="mr-2 size-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 size-3.5" />
              )}
              {busy ? "Summarizing…" : askLabel(row.feed.answerCount, row.costUsd, saved !== null)}
            </Button>
            <p className="num type-meta">
              {saved
                ? `Written ${new Date(saved.createdAt).toLocaleString()} · never counted in statistics`
                : "Written on demand by your extraction model, on your own keys · never counted in statistics"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
