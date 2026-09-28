import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/money";

export interface PromptSummaryRow {
  promptId: string;
  promptText: string;
  /** Answers to this prompt in this run. */
  answerCount: number;
  /** How many of them a summary asked now would read. */
  feedCount: number;
  /** Rough cost of asking now, at list prices. Zero under the mock seam. */
  costUsd: number;
  saved: { summary: string; answerCount: number; createdAt: string } | null;
}

/** What the button promises: the count it summarizes and what that costs. */
export function summarizeLabel(answerCount: number, costUsd: number, again: boolean): string {
  const verb = again ? "Re-ask" : "Summarize";
  const cost = costUsd > 0 ? `, about ${money(costUsd)}` : "";
  return `${verb} ${answerCount} ${answerCount === 1 ? "answer" : "answers"}${cost}`;
}

/**
 * What follows "N answers in this run" when a summary reads fewer than all of
 * them: how many a stored summary was written from, or how many one asked now
 * would read.
 */
export function countNote(row: Pick<PromptSummaryRow, "answerCount" | "feedCount" | "saved">) {
  if (row.saved) {
    return row.saved.answerCount !== row.answerCount
      ? ` · summarized from ${row.saved.answerCount}`
      : "";
  }
  return row.feedCount < row.answerCount ? ` · a summary reads the first ${row.feedCount}` : "";
}

/**
 * One prompt's summary card on the run page: the question, what asking will
 * roughly cost and, once asked, the stored paragraph with a way to ask again.
 * The rough cost is on the button before any spend, because the call goes to
 * the user's own key. The route owns the server call, the busy state and the
 * toasts.
 */
export function PromptSummaryCard({
  row,
  busy = false,
  locked = null,
  onSummarize,
}: {
  row: PromptSummaryRow;
  /** This card's call is in flight. */
  busy?: boolean | undefined;
  /** When set, asking is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
  onSummarize: () => void;
}) {
  const saved = row.saved;
  // Outline while there is no summary, ghost beside a stored one, with the
  // same disabled, title and spinner rules either way.
  const summarizeButton = (variant: "outline" | "ghost", again: boolean) => (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={busy || locked !== null}
      title={locked ?? undefined}
      onClick={onSummarize}
    >
      {busy ? (
        <Loader2 className="mr-2 size-3.5 animate-spin" />
      ) : (
        <Sparkles className="mr-2 size-3.5" />
      )}
      {busy ? "Summarizing…" : summarizeLabel(row.feedCount, row.costUsd, again)}
    </Button>
  );
  return (
    <article className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm">{row.promptText}</p>
          <p className="num type-meta">
            {row.answerCount} {row.answerCount === 1 ? "answer" : "answers"} in this run
            {countNote(row)}
          </p>
        </div>
        {!saved && summarizeButton("outline", false)}
      </div>

      {saved && (
        <div className="space-y-2">
          <p className="max-w-prose whitespace-pre-wrap text-sm text-muted-foreground">
            {saved.summary}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {summarizeButton("ghost", true)}
            <p className="num type-meta">Written {new Date(saved.createdAt).toLocaleString()}</p>
          </div>
        </div>
      )}
    </article>
  );
}
