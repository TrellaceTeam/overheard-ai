import { Loader2, Play, Quote, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppLink } from "@/components/AppLink";
import { dominantFailure } from "@/lib/failure-reasons";
import {
  PERCEPTION_SECTIONS,
  type NamedSummary,
  type PerceptionRunNotice,
  type PerceptionSectionKey,
  type PerceptionSummary,
} from "@/components/types";

/**
 * The band across the top of the dashboard: what the assistants say about the
 * brand.
 *
 * It comes first because it is the part a brand owner forwards to their
 * leadership. The cards below say how often. This says what.
 *
 * It shows four sections, not the answers themselves, which would be four
 * walls of text saying overlapping things in different orders. The sections
 * come from an extraction pass over each answer, stored per assistant and
 * merged into one across-assistants row, so nothing is summarised while the
 * page renders.
 *
 * Scope picks the view, not a toggle. With every summarised assistant in scope
 * it shows the merged row. With a subset it shows those assistants side by
 * side, because the merged row would include assistants the reader has just
 * filtered out.
 *
 * No sentiment, no score, no trend. "Downsides" is not our judgement, it is the
 * criticism the assistant itself volunteered.
 */
export function PerceptionBand({
  projectId,
  aggregate,
  perModel,
  scopeIsEverything,
  anySummaries,
  currentQuestion,
  perceptionOff,
  onAskAgain,
  asking,
  locked = null,
  lastRun = null,
  onRetryRun = () => {},
  retryingRun = false,
}: {
  projectId: string;
  /** The across-assistants row, or null if there is not one yet. */
  aggregate: PerceptionSummary | null;
  /** Per-assistant rows the filter leaves in scope. */
  perModel: NamedSummary[];
  /** Every assistant that has a summary is in scope, so the merged row matches the filter. */
  scopeIsEverything: boolean;
  /** Whether any summary exists at all, before the filter narrowed anything. */
  anySummaries: boolean;
  /** The perception prompt as it would be asked now, {brand} resolved. */
  currentQuestion: string | null;
  perceptionOff: boolean;
  /** Asks the perception prompt only. Never the whole prompt set. */
  onAskAgain: () => void;
  asking: boolean;
  /** When set, asking is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
  /** The newest perception-only run, or null when there has never been one. */
  lastRun?: PerceptionRunNotice | null | undefined;
  /** Re-queues the failed answers of that run. The route owns the server call. */
  onRetryRun?: (() => void) | undefined;
  retryingRun?: boolean | undefined;
}) {
  const showAggregate = scopeIsEverything && aggregate !== null;
  const unrecognised = perModel.filter((row) => !row.knows_brand).length;
  const notice = perceptionRunNotice(lastRun);

  return (
    <section className="space-y-3" data-tour="perception">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="type-section flex items-center gap-2">
          <Quote className="size-3.5 text-muted-foreground" />
          What assistants say about you
        </h3>
        <div className="flex items-center gap-3">
          {!perceptionOff && anySummaries && (
            <Button
              size="sm"
              variant="outline"
              onClick={onAskAgain}
              disabled={asking || locked !== null}
              title={locked ?? undefined}
            >
              {asking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Ask again
            </Button>
          )}
          <AppLink
            to="/projects/$projectId/settings"
            params={{ projectId }}
            className="inline-block py-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Edit the prompt
          </AppLink>
        </div>
      </div>

      {/* The run's own status, because the run is a page nobody is ever taken
          to: the first run's page shows the measured run while the perception
          half runs beside it, and a stumble there would otherwise go unseen. */}
      {notice?.kind === "asking" && (
        <div className="panel type-meta flex items-center gap-2 p-4">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          Asking each assistant what it knows about you…
        </div>
      )}
      {notice?.kind === "failed" && (
        <div className="panel space-y-3 border-warn/40 p-4">
          <p className="max-w-prose text-sm text-warn">
            {notice.allFailed
              ? `The perception check failed. None of the ${notice.total} ${
                  notice.total === 1 ? "answer" : "answers"
                } came back.`
              : // Plural, unconditionally: a partial failure means at least one
                // answer came back and at least one did not, so the total is
                // always two or more.
                `The perception check did not finish, and ${notice.failed} of ${notice.total} answers failed.`}
            {notice.reasonTitle ? ` Most common reason: ${notice.reasonTitle}.` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={onRetryRun}
              disabled={retryingRun || locked !== null}
              title={locked ?? undefined}
            >
              {retryingRun ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Retry the failed answers
            </Button>
            <AppLink
              to="/projects/$projectId/runs/$runId"
              params={{ projectId, runId: notice.runId }}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              See this run
            </AppLink>
          </div>
        </div>
      )}

      {/* Never absent and never an empty box: a missing band would read as
          "this product does not do that". While a run is being asked or a
          stumble is being reported, the notice above is the whole story and
          "Nothing asked yet" would contradict it. */}
      {perceptionOff ? (
        <div className="panel type-meta max-w-prose p-5">
          No perception prompt is set, so nothing is being asked.{" "}
          <AppLink
            to="/projects/$projectId/settings"
            params={{ projectId }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Add one in project settings
          </AppLink>{" "}
          and it will be asked the next time you ask.
        </div>
      ) : !anySummaries ? (
        notice === null ? (
          <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
            <p className="type-meta max-w-prose">
              Nothing asked yet. This asks each assistant what it knows about your brand. It costs
              one answer each and runs none of your prompts.
            </p>
            <Button
              size="sm"
              onClick={onAskAgain}
              disabled={asking || locked !== null}
              title={locked ?? undefined}
            >
              {asking ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Ask now
            </Button>
          </div>
        ) : null
      ) : perModel.length === 0 ? (
        <div className="panel type-meta max-w-prose p-5">
          No perception summary for the selected assistants. Widen the assistant filter above to see
          them.
        </div>
      ) : showAggregate ? (
        <div className="panel space-y-4 p-5">
          <Sections row={aggregate} columns />
          <p className="type-meta border-t border-border pt-3">
            Merged from {aggregate.source_answers} assistant
            {aggregate.source_answers === 1 ? "" : "s"}
            {unrecognised > 0 && (
              <>
                {" · "}
                <span className="text-warn">{unrecognised} did not recognize your brand</span>
              </>
            )}
            {isStale(aggregate.question_text, currentQuestion) && (
              <>
                {" · "}
                <span className="text-warn">answered an earlier version of your prompt</span>
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {perModel.map((row) => (
            <div key={row.model_id ?? "all"} className="panel space-y-4 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="type-section">{row.name}</p>
                {isStale(row.question_text, currentQuestion) && (
                  <p className="text-xs text-warn">earlier version of your prompt</p>
                )}
              </div>
              {row.knows_brand ? (
                <Sections row={row} />
              ) : (
                <p className="type-meta">This assistant said it does not recognize your brand.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The four headings, with the empty ones omitted.
 *
 * An empty section is a finding, but a heading with nothing under it is not the
 * way to report it. The extractor is told to leave a field blank rather than
 * write "not mentioned", so a blank means the assistant did not cover it. The
 * absence shows as a missing heading, and the "nothing at all" case is caught
 * one level up.
 */
function Sections({ row, columns = false }: { row: PerceptionSummary; columns?: boolean }) {
  const text = (key: PerceptionSectionKey) => row[key] ?? "";
  const filled = PERCEPTION_SECTIONS.filter((section) => text(section.key).trim());
  if (filled.length === 0) {
    return (
      <p className="type-meta">The answer did not describe the brand in any of these terms.</p>
    );
  }
  return (
    // On the full-width merged panel the sections sit in two columns, so the
    // right half of the card is not left empty and lines stay a comfortable
    // reading length.
    <dl className={columns ? "grid gap-x-10 gap-y-5 lg:grid-cols-2" : "space-y-4"}>
      {filled.map((section) => (
        <div key={section.key} className="space-y-1">
          <dt className="type-label">{section.label}</dt>
          <dd className="max-w-prose text-sm leading-relaxed text-card-foreground">
            {text(section.key)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Whether this summary answered a different question from the one asked now.
 *
 * The exact text sent is on the task and copied onto the summary, so comparing
 * the two texts needs no version column kept in step with the prompt.
 *
 * False when either side is missing: with nothing to compare, the band does
 * not flag the summary.
 */
export function isStale(asked: string | null, current: string | null): boolean {
  if (!asked || !current) return false;
  return asked.trim() !== current.trim();
}

/** What the band says about its newest run, or null when it says nothing. */
export type PerceptionRunNoticeView =
  | { kind: "asking" }
  | {
      kind: "failed";
      failed: number;
      total: number;
      /** True when nothing came back at all, which wants a blunter sentence. */
      allFailed: boolean;
      /** The dominant failure's title, or null when nothing was recorded. */
      reasonTitle: string | null;
      runId: string;
    }
  | null;

/**
 * The verdict over a perception run's own numbers:
 *
 * - cancelled: nothing. A check somebody stopped is not a stumble, its run
 *   page says "You stopped this run", and Ask again is the way back.
 * - queued, running, or any task not yet terminal: the check is being asked.
 *   The task counts decide, not the stored status alone, so a run a crash left
 *   terminal with work outstanding is not reported as a failure that
 *   overstates what was lost.
 * - any failed task: the stumble notice, with the dominant reason.
 * - finished clean: nothing, because the summaries below tell the story.
 */
export function perceptionRunNotice(
  lastRun: PerceptionRunNotice | null | undefined,
): PerceptionRunNoticeView {
  if (!lastRun) return null;
  if (lastRun.status === "cancelled") return null;
  if (lastRun.status === "queued" || lastRun.status === "running" || lastRun.pendingTasks > 0) {
    return { kind: "asking" };
  }
  if (lastRun.failedTasks === 0) return null;
  return {
    kind: "failed",
    failed: lastRun.failedTasks,
    total: lastRun.totalTasks,
    allFailed: lastRun.doneTasks === 0,
    reasonTitle: dominantFailure(lastRun.failedReasons)?.title ?? null,
    runId: lastRun.runId,
  };
}
