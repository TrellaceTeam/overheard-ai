import { toAnswers } from "@/lib/run-progress";
import { runOutcome } from "@/lib/run-outcome";
import { StatusDot, statusToneClass } from "@/components/StatusPill";
import type { RunProgress } from "@/components/types";

/**
 * The run progress panel: a headline, a detail line and a bar.
 *
 * Every count arrives in provider calls and is shown in answers, through
 * toAnswers. See lib/run-progress.ts for why the two units differ. The words
 * come from runOutcome, so an internal status name never reaches a screen.
 *
 * The bar uses the meter the metric cards use, not the progress primitive, so
 * the app's one horizontal rail means one thing. It takes the status colour,
 * not the brand green, so a failed run's bar is not the green of a finished one.
 */
export function RunProgressBar({
  progress,
  tourId = null,
}: {
  progress: RunProgress;
  /** Set by the run route when the tour spotlights this panel. */
  tourId?: string | null;
}) {
  const outcome = runOutcome(
    progress.status,
    progress.completedCalls,
    progress.failedCalls,
    progress.plannedCalls,
    progress.fresh !== undefined &&
      progress.retrying !== undefined &&
      progress.working !== undefined
      ? { fresh: progress.fresh, retrying: progress.retrying, working: progress.working }
      : null,
  );
  const planned = toAnswers(progress.plannedCalls);
  const done = toAnswers(progress.completedCalls);
  // A run with nothing planned would divide by zero and render a full bar.
  const percent = planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0;

  const tone = statusToneClass(outcome.tone);

  return (
    <div className="panel p-5" data-tour={tourId ?? undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className={`type-section flex items-center gap-2 ${tone}`}>
          <StatusDot tone={outcome.tone} />
          {outcome.headline}
        </p>
        <p className={`num text-sm ${tone}`}>{percent}%</p>
      </div>
      <div
        className={`meter mt-3 ${tone}`}
        role="progressbar"
        aria-label="Run progress"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className="meter-fill transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="num type-meta mt-3">{outcome.detail}</p>
    </div>
  );
}
