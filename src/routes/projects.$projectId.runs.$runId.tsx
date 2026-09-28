/**
 * Owns the run screen: live progress while a run is in flight, then its results
 * and every raw answer with the observations pulled out of it.
 *
 * Every task is listed from the moment the run starts, not only the ones with
 * an answer, so the questions still outstanding are visible while a run is in
 * flight.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, FlaskConical, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppLink } from "@/components/AppLink";
import { CompetitorTable } from "@/components/CompetitorTable";
import { CountingInfo } from "@/components/CountingInfo";
import { DeleteRunButton } from "@/components/DeleteRunButton";
import { DemoReadOnlyNote, DEMO_READONLY_REASON } from "@/components/DemoReadOnlyNote";
import { useIsDemo } from "@/components/useIsDemo";
import { MetricGrid } from "@/components/MetricGrid";
import { PromptSummaryCard } from "@/components/PromptSummaryCard";
import { TOUR_SELECTORS } from "@/components/TutorialTour";
import { pct } from "@/components/MetricCard";
import { RunFailures } from "@/components/RunFailures";
import { RunProgressBar } from "@/components/RunProgressBar";
import { statusToneClass } from "@/components/StatusPill";
import type { FailedTask } from "@/components/types";
import { errorText } from "@/lib/error-text";
import { money } from "@/lib/money";
import { aggregateBrand, type MetricRow } from "@/lib/metrics";
import { taskState } from "@/lib/run-outcome";
import { listBrands } from "@/server/api/brands";
import { cancelRun, deleteRun, getRunDetail, kickWorker, retryFailed } from "@/server/api/runs";
import { summarizePrompt } from "@/server/api/summaries";

/**
 * Says so when the list of answers below is a page rather than the whole run.
 *
 * getRunDetail caps the answers it returns so one wide run cannot stall the
 * page, and without this line the missing rows look like lost data. Null when
 * the whole run is on the page.
 */
export function truncationNotice(
  total: number | null | undefined,
  limit: number | null | undefined,
): string | null {
  if (typeof total !== "number" || typeof limit !== "number") return null;
  if (limit <= 0 || total <= limit) return null;
  return `Showing the first ${limit} of ${total} answers.`;
}

/** The two statuses that mean work is still outstanding. */
export const ACTIVE_STATUSES = ["queued", "running"];

/**
 * How often to ask the server again, or false to stop.
 *
 * Two seconds while the run is in flight: a provider call can take fifty
 * seconds, so the only thing moving on screen is the count of answers already
 * in, and a slower poll makes a working run look stalled. A finished run whose
 * statistics are still being written is polled more gently until they land.
 */
export function runPollInterval(
  status: string | null | undefined,
  awaitingScore = false,
): number | false {
  if (ACTIVE_STATUSES.includes(status ?? "")) return 2000;
  return awaitingScore ? 3000 : false;
}

/**
 * Whether the run's statistics are still on their way.
 *
 * The last answer can land before the worker finalises the run, so "finished"
 * is not "scored". The worker finalises a run once no task is pending, so a
 * finished run with answers and no finalised_at is still being scored. One with
 * no answers has nothing to score and nothing to wait for.
 */
export function awaitingStatistics(
  status: string | null | undefined,
  finalisedAt: string | null | undefined,
  answered: number,
): boolean {
  if (ACTIVE_STATUSES.includes(status ?? "")) return true;
  return !finalisedAt && answered > 0;
}

/**
 * What the results say when nothing in the run counts towards statistics.
 *
 * "Scoring" only while statistics are on their way, because a finalised run can
 * have no row that counts at all. Why nothing counts is for CountingInfo,
 * beside the heading, to explain.
 */
export function emptyResultsNotice(awaiting: boolean): string {
  return awaiting
    ? "Scoring this run. Statistics appear here in a moment."
    : "Nothing in this run counts toward statistics.";
}

export { money };

/**
 * Whether the run id in the URL is simply not in the database.
 *
 * Worth telling apart from any other load failure: one means the link is stale
 * and there is nothing to wait for, the other means try again.
 */
export function isMissingRun(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("RUN_NOT_FOUND");
}

export const Route = createFileRoute("/projects/$projectId/runs/$runId")({
  head: () => ({
    meta: [
      { title: "Run detail - Overheard AI" },
      {
        name: "description",
        content:
          "Every answer, its extracted ranking and the citations behind your visibility score.",
      },
    ],
  }),
  component: RunDetail,
});

function RunDetail() {
  const { projectId, runId } = Route.useParams();
  const isDemo = useIsDemo(projectId);
  const demoReason = isDemo ? DEMO_READONLY_REASON : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [tab, setTab] = useState<"results" | "raw">("results");
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  /**
   * One call, polled every two seconds while the run is in flight. The server
   * recomputes the counters instead of reading the stored ones, so a page
   * opened between worker passes is current.
   */
  const {
    data: detail,
    isError,
    error,
  } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRunDetail({ data: { runId } }),
    refetchInterval: (query) => {
      const data = query.state.data;
      const answered = (data?.tasks ?? []).filter((task) => task.answerText !== null).length;
      return runPollInterval(
        data?.progress.status,
        awaitingStatistics(data?.progress.status, data?.run.finalised_at, answered),
      );
    },
    // A run that is not in the database will not appear on the third attempt
    // either, so say so at once instead of spending the default backoff on it.
    retry: (failures, error) => !isMissingRun(error) && failures < 2,
  });

  const active = ACTIVE_STATUSES.includes(detail?.progress.status ?? "");

  /**
   * Safety net: while this run is in flight, keep asking the server to drain
   * the queue, so progress never depends solely on a timer nobody can see.
   */
  const kicking = useRef(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const kick = async () => {
      if (kicking.current || cancelled) return;
      kicking.current = true;
      try {
        await kickWorker();
      } catch {
        // Transient. The scheduled drain will pick the run up anyway.
      } finally {
        kicking.current = false;
      }
    };
    void kick();
    const timer = setInterval(() => void kick(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  const { data: brands } = useQuery({
    queryKey: ["brands", projectId],
    queryFn: () => listBrands({ data: { projectId } }),
  });
  const target = (brands ?? []).find((b) => b.role === "target");

  const allTasks = useMemo(() => detail?.tasks ?? [], [detail]);
  const observations = useMemo(() => detail?.observations ?? [], [detail]);

  // Answers that arrived, which decides whether a finished run is still
  // waiting on its statistics.
  const answeredCount = allTasks.filter((task) => task.answerText !== null).length;

  // A failed task with an answer got its answer and then died while being
  // scored, so it shows in Raw results while contributing nothing to metrics.
  const failedTasks: FailedTask[] = useMemo(
    () =>
      (detail?.failures ?? []).map((task) => ({
        id: task.id,
        status: task.status,
        iteration: task.iteration,
        error: task.error,
        failure_code: task.failureCode,
        question_text: task.questionText,
        prompt_text: task.promptText,
        model_name: task.modelDisplayName,
      })),
    [detail],
  );

  const perceptionOnly = detail?.perceptionOnly ?? false;
  const finished = !active;

  const runMetrics: MetricRow[] = useMemo(() => detail?.metrics ?? [], [detail]);

  const runAgg = aggregateBrand(runMetrics, target?.id);

  const competitorRows = (brands ?? [])
    .filter((b) => b.id !== target?.id)
    .map((brand) => ({
      brand: { id: brand.id, name: brand.name, role: brand.role },
      agg: aggregateBrand(runMetrics, brand.id),
    }))
    .filter((row) => row.agg.mentions > 0)
    .sort((a, b) => (b.agg.mention_rate ?? 0) - (a.agg.mention_rate ?? 0));

  /**
   * A perception only run has no Results tab, so when it finishes there is
   * nothing left to look at. Redirect only when it finished while being
   * watched: opening an old perception run from the runs list should show its
   * answers rather than bounce whoever asked for it.
   */
  const watchedFromRunning = useRef(false);
  useEffect(() => {
    if (active) watchedFromRunning.current = true;
  }, [active]);
  useEffect(() => {
    if (!perceptionOnly || !finished || !watchedFromRunning.current) return;
    void navigate({ to: "/projects/$projectId", params: { projectId } });
  }, [perceptionOnly, finished, navigate, projectId]);

  const showResults = !perceptionOnly && finished && tab === "results";
  const showRaw = perceptionOnly || !finished || tab === "raw";

  function invalidateRun() {
    void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
  }

  async function retry() {
    setRetrying(true);
    try {
      const result = await retryFailed({ data: { runId } });
      // `requeued` counts run_tasks rows, one per answer. Only the stored call
      // counters are doubled, so it is not halved.
      toast.success(
        result.requeued === 0
          ? "Nothing left to retry"
          : `${result.requeued} ${result.requeued === 1 ? "answer" : "answers"} back in the queue`,
      );
      // Both run queries stop polling once a run is finished, so without this
      // the screen keeps showing the failed state it just moved on from.
      invalidateRun();
    } catch (error) {
      toast.error(errorText(error, "Could not retry those answers"));
    } finally {
      setRetrying(false);
    }
  }

  /**
   * Buy one prompt's summary. The card shows the rough cost before this is
   * reachable, the server stores the result, and the refetch renders it in
   * the button's place.
   */
  const [summarizing, setSummarizing] = useState<string | null>(null);
  async function summarize(promptId: string) {
    setSummarizing(promptId);
    try {
      await summarizePrompt({ data: { runId, promptId } });
      toast.success("Summary saved");
      invalidateRun();
    } catch (error) {
      toast.error(errorText(error, "Could not summarize those answers"));
    } finally {
      setSummarizing(null);
    }
  }

  async function stop() {
    setCancelling(true);
    try {
      const result = await cancelRun({ data: { runId } });
      toast.success(
        result.cancelled === 0
          ? "This run had already stopped"
          : `Run canceled. ${result.cancelled} outstanding ${result.cancelled === 1 ? "answer" : "answers"} will not be collected`,
      );
      invalidateRun();
    } catch (error) {
      toast.error(errorText(error, "Could not cancel this run"));
    } finally {
      setCancelling(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await deleteRun({ data: { runId } });
      setDeleted(true);
      toast.success("Run deleted");
    } catch (error) {
      toast.error(errorText(error, "Could not delete this run"));
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Until the first fetch lands the defaults below are not neutral: a null
   * status reads as "still running", and zeroed counters render "0 of 0 answers
   * collected" above a results section saying no competitor was named. So this
   * renders one loading line instead.
   */
  if (!detail) {
    /**
     * A run id that is not in the database is a bad URL, not a state of a run.
     * The Back button after a delete and a stale link both land here.
     */
    if (isError) {
      const missing = isMissingRun(error);
      return (
        <div className="panel max-w-prose space-y-3 p-5">
          <p className="text-sm">
            {missing
              ? "That run is not in your database. It may have been deleted."
              : errorText(error, "We could not load this run just now.")}
          </p>
          <AppLink
            to="/projects/$projectId"
            params={{ projectId }}
            className="inline-block text-sm text-primary underline"
          >
            Back to this project
          </AppLink>
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <div className="panel p-5">
          <p className="type-meta">Collecting this run from your database…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isDemo && <DemoReadOnlyNote />}
      <RunProgressBar
        tourId={TOUR_SELECTORS.runStatus}
        progress={{
          status: detail?.progress.status ?? null,
          plannedCalls: detail?.progress.plannedCalls ?? 0,
          completedCalls: detail?.progress.completedCalls ?? 0,
          failedCalls: detail?.progress.failedCalls ?? 0,
          fresh: detail?.progress.fresh ?? 0,
          retrying: detail?.progress.retrying ?? 0,
          working: detail?.progress.working ?? 0,
        }}
      />

      {/* The spend line and the two things you can do to a run share one row,
          which is what stops the delete icon from floating alone against the
          right edge of the page with nothing to belong to. */}
      <div
        className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
        data-tour={TOUR_SELECTORS.runSpend}
      >
        <p className="num type-meta">
          Estimated spend on your own keys: {money(detail?.estimatedCostUsd ?? 0)}. List rates, not
          an invoice.
        </p>
        <div className="flex items-center gap-2">
          {active && (
            <Button variant="outline" size="sm" onClick={() => void stop()} disabled={cancelling}>
              {cancelling ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="size-4" />
              )}
              Cancel run
            </Button>
          )}
          <DeleteRunButton
            label={detail ? new Date(detail.run.created_at).toLocaleString() : "this run"}
            onDelete={() => void remove()}
            deleting={deleting}
            deleted={deleted}
            locked={demoReason}
            onDeleted={() => {
              void queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
              void queryClient.invalidateQueries({ queryKey: ["project-metrics", projectId] });
              void navigate({ to: "/projects/$projectId", params: { projectId } });
            }}
          />
        </div>
      </div>

      {/* Read off the run, not the server's current mode: canned answers
          that pass for real data are the seam's risk, and the mode can change
          between the run and the visit. */}
      {detail?.run.mock === 1 && (
        <p className="panel flex items-start gap-3 p-4 text-sm text-warn">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <span className="max-w-prose">
            This run used mock providers (OVERHEARD_MOCK_PROVIDERS). Every answer below was
            generated locally, not by an assistant, and no key was used.
          </span>
        </p>
      )}

      {detail?.run.error && <p className="text-sm text-destructive">{detail.run.error}</p>}

      <RunFailures
        tasks={failedTasks}
        onRetry={() => void retry()}
        retrying={retrying}
        locked={demoReason}
      />

      {finished && !perceptionOnly && (
        // A segmented control, not two buttons. Two buttons of equal weight
        // side by side read as two things to press, and the filled one read as
        // the action rather than as the view you are already looking at.
        <div
          className="inline-flex rounded-md border border-border bg-surface p-1"
          role="tablist"
          data-tour={TOUR_SELECTORS.runAnswers}
        >
          {(
            [
              ["results", "Results"],
              ["raw", "Raw results"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`rounded px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                tab === value
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {showResults && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="type-section">{target?.name ?? "Your brand"} in this run</h3>
              <CountingInfo />
            </div>
            {runMetrics.length === 0 ? (
              <p className="type-meta max-w-prose">
                {emptyResultsNotice(
                  awaitingStatistics(
                    detail.progress.status,
                    detail.run.finalised_at,
                    answeredCount,
                  ),
                )}
              </p>
            ) : (
              <>
                <MetricGrid
                  tourId={null}
                  agg={runAgg}
                  scopeHint="Answers in this run that named you"
                />
                {runAgg.answers > 0 && (
                  <p className="type-meta max-w-prose">
                    Across {runAgg.answers} answers in this run you were named in{" "}
                    {pct(runAgg.mention_rate)} and in the first three of {pct(runAgg.top3_rate)}.
                  </p>
                )}
                {failedTasks.length > 0 && (
                  <p className="type-meta max-w-prose">
                    These figures cover only the answers that were scored. {failedTasks.length}{" "}
                    {failedTasks.length === 1 ? "answer" : "answers"} in this run failed and count
                    toward nothing above, so treat it as a smaller sample than a clean run.
                  </p>
                )}
              </>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="type-section">Competitors in this run</h3>
            <CompetitorTable rows={competitorRows} empty="No competitors were named in this run." />
          </section>

          {(detail?.promptSummaries ?? []).length > 0 && (
            <section className="space-y-3">
              <h3 className="type-section">What the answers say</h3>
              <p className="type-meta max-w-prose">
                One summary per prompt, written on demand by your extraction model on your own keys,
                at the rough cost on the button. Summaries are prose for a reader and never count in
                the statistics above.
              </p>
              {(detail?.promptSummaries ?? []).map((row) => (
                <PromptSummaryCard
                  key={row.promptId}
                  row={row}
                  busy={summarizing === row.promptId}
                  locked={demoReason}
                  onSummarize={() => void summarize(row.promptId)}
                />
              ))}
            </section>
          )}
        </>
      )}

      {showRaw && (
        <div className="space-y-3">
          {/* A heading and the standard section gap, so the failure cards above
              do not run straight into seventy-five answer rows with nothing
              saying what the next thing on the page is. */}
          <h3 className="type-section">Every answer in this run</h3>
          {truncationNotice(detail?.taskTotal, detail?.taskLimit) && (
            <p className="type-meta">{truncationNotice(detail?.taskTotal, detail?.taskLimit)}</p>
          )}
          {allTasks.length === 0 && (
            <p className="panel type-meta p-5">
              Building the list of prompts. Every prompt in this run appears here as it is asked, so
              you can watch a slow assistant rather than guess at it.
            </p>
          )}
          {allTasks.map((task) => {
            const taskRows = observations.filter((o) => o.runTaskId === task.id);
            const isOpen = openTask === task.id;
            const state = taskState(task.status);
            const hasAnswer = task.answerText !== null && task.answerText !== "";
            return (
              <article
                key={task.id}
                className="panel p-4 transition-colors hover:border-border-strong"
              >
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-4 text-left disabled:cursor-default"
                  disabled={!hasAnswer}
                  aria-expanded={hasAnswer ? isOpen : undefined}
                  onClick={() => setOpenTask(isOpen ? null : task.id)}
                >
                  <span className="space-y-1">
                    <span className="block text-sm">
                      {task.questionText ?? task.promptText ?? "Prompt not recorded"}
                    </span>
                    <span className="num type-meta block">
                      {task.modelDisplayName ?? "Assistant"}
                      {/* The version the provider reported, which can be a dated
                          snapshot behind the name. */}
                      {task.answerModel ? ` (${task.answerModel})` : ""}, answer #{task.iteration}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className={`text-xs ${statusToneClass(state.tone)}`}>{state.label}</span>
                    {/* A chevron, not the words "open" and "hide", which would
                        be two more things to read on every row of a long list. */}
                    {hasAnswer && (
                      <ChevronDown
                        aria-hidden="true"
                        className={`size-4 text-muted-foreground transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    )}
                  </span>
                </button>

                {task.status === "failed" && hasAnswer && (
                  <p className="mt-2 text-xs text-destructive">
                    This answer arrived but was never scored, so it counts toward no metric. The
                    reason is under "Calls that failed" above.
                  </p>
                )}

                {taskRows.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[...taskRows]
                      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
                      .map((row) => (
                        <span
                          key={row.id}
                          className="num inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs"
                        >
                          {row.position !== null && (
                            <span className="text-muted-foreground">#{row.position}</span>
                          )}
                          {row.brandName ?? row.rawName}
                          {row.isCited && <span className="text-primary">cited</span>}
                        </span>
                      ))}
                  </div>
                )}

                {isOpen && (
                  <div className="mt-3 space-y-3">
                    <p className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm text-muted-foreground">
                      {task.answerText}
                    </p>
                    {taskRows
                      .filter((row) => row.linkedUrl !== null)
                      .map((row) => (
                        <a
                          key={`${row.id}-link`}
                          href={row.linkedUrl ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-xs text-primary underline"
                        >
                          {row.linkedUrl}
                        </a>
                      ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
