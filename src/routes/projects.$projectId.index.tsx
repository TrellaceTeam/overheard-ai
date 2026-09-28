/**
 * Owns the dashboard: what the assistants say about the brand, how often they
 * say it, how that moved, who else was named, and every run so far.
 *
 * One filter state feeds every number on the page. Per-card filters would let
 * two figures on one screen describe different populations, which is why
 * applyFilter is called once and everything below reads its result.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppLink } from "@/components/AppLink";
import { CompareMetricGrid } from "@/components/CompareMetricGrid";
import { CompareTrend, seriesColor } from "@/components/CompareTrend";
import { CompetitorTable } from "@/components/CompetitorTable";
import { CountingInfo } from "@/components/CountingInfo";
import { DemoReadOnlyNote, DEMO_READONLY_REASON } from "@/components/DemoReadOnlyNote";
import { useIsDemo } from "@/components/useIsDemo";
import { DashboardFilters } from "@/components/DashboardFilters";
import { DeleteRunButton } from "@/components/DeleteRunButton";
import { MetricGrid } from "@/components/MetricGrid";
import { PerceptionBand } from "@/components/PerceptionBand";
import { RunPlanSummary, planWithEstimate } from "@/components/RunPlanSummary";
import { useRunEstimate } from "@/components/useRunEstimate";
import { StatusPill } from "@/components/StatusPill";
import type { ComparePoint, NamedSummary, PerceptionSummary } from "@/components/types";
import {
  applyFilter,
  applyPerceptionFilter,
  emptyReason,
  NO_FILTER,
  orderAssistants,
  periodLabel,
  type DashboardFilter,
} from "@/lib/dashboard-filters";
import { errorText } from "@/lib/error-text";
import { hiddenDiscoveredSentence, selectVisibleCompetitors } from "@/lib/competitor-list";
import { useTrackBrand } from "@/components/useTrackBrand";
import { dominantFailure } from "@/lib/failure-reasons";
import type { StoredFailure } from "@/lib/failure-codes";
import { aggregateBrand, groupBy, type MetricRow } from "@/lib/metrics";
import { runOutcome } from "@/lib/run-outcome";
import { toAnswers } from "@/lib/run-progress";
import { trendLabels } from "@/lib/trend-labels";
import { topCandidate } from "@/lib/top-competitor";
import { listBrands } from "@/server/api/brands";
import { callLimit as fetchCallLimit } from "@/server/api/settings";
import { projectMetricWindow } from "@/server/api/metrics";
import { listProjectModels } from "@/server/api/models";
import { getPerceptionState } from "@/server/api/perception";
import { listPrompts } from "@/server/api/prompts";
import {
  createPerceptionRun,
  createRun,
  deleteRun,
  listFailedTaskErrors,
  listRuns,
  planRun,
  retryFailed,
} from "@/server/api/runs";

/**
 * localStorage flag for the dismissed attribution line, which shows after the
 * first completed run. Install-wide, so one dismissal covers every project.
 */
export const ATTRIBUTION_KEY = "overheard:attribution-dismissed";

/**
 * The assistant selection after one checkbox move.
 *
 * Collapses back to null once everything is on again, so an assistant added to
 * the project later is included rather than quietly excluded. Null is not the
 * same as "every assistant currently known", and an array cannot say so.
 */
export function nextAssistants(
  all: string[],
  current: string[] | null,
  provider: string,
  on: boolean,
): string[] | null {
  const from = current ?? all;
  const next = on ? [...new Set([...from, provider])] : from.filter((p) => p !== provider);
  const everythingOn = all.length > 0 && all.every((p) => next.includes(p));
  return everythingOn ? null : next;
}

/**
 * What a row in the Runs list says about itself beyond its counts.
 *
 * "Perception check", because otherwise that row is a bare "3/3 answers, Run
 * complete" at the same timestamp as the measured run. "Mock", because a canned
 * run and a measured one look the same once OVERHEARD_MOCK_PROVIDERS is unset,
 * and their numbers are not comparable. The run's mock flag is the only record
 * of the difference.
 */
export function runRowBadges(run: {
  perceptionOnly: boolean;
  mock: boolean;
}): Array<{ label: string; tone: "muted" | "warn" }> {
  const badges: Array<{ label: string; tone: "muted" | "warn" }> = [];
  if (run.perceptionOnly) badges.push({ label: "Perception check", tone: "muted" });
  if (run.mock) badges.push({ label: "Mock", tone: "warn" });
  return badges;
}

/**
 * The line that explains why a mock run is in the Runs list but not in the cards.
 *
 * projectMetricWindow drops canned rows once the project holds one measured
 * run, because nothing on screen tells the two apart once
 * OVERHEARD_MOCK_PROVIDERS is unset. The mock run is still listed below, so the
 * dashboard says why its numbers are missing. Null when nothing was dropped.
 */
export function mockExcludedNotice(
  window: { mockExcluded: boolean } | null | undefined,
): string | null {
  if (!window?.mockExcluded) return null;
  return "Runs made with mock providers are listed below but left out of these numbers, because their answers were canned rather than measured.";
}

/**
 * What the trend says instead of a line. A trend needs two scored runs, so this
 * shows below that and says what is missing.
 *
 * A filter is named only through emptyReason's `filterNotice`, which is null
 * unless a filter emptied rows that were there.
 */
export function trendEmptyText(state: {
  runsPending: boolean;
  runsError: boolean;
  completedRuns: number;
  /** Scored runs left once the filter is applied, one point each. */
  runsInScope: number;
  filterNotice: string | null;
}): string {
  if (state.runsPending) return "Loading your runs…";
  if (state.runsError) return "We could not load your runs just now. Reload to try again.";
  if (state.completedRuns === 0) {
    return 'No completed runs yet. Press "Run now" to collect your first data points.';
  }
  if (state.filterNotice !== null) return state.filterNotice;
  if (state.runsInScope === 1) {
    return "One run scored so far. A trend line appears after the second completed run.";
  }
  return "No statistics to show yet.";
}

/**
 * The screen that fixes a planner refusal, linked from the Run now dialog so a
 * refusal is not a dead end. The Runner on the Prompts tab holds both the
 * prompts and the assistant selection, so NO_PROMPTS and NO_MODELS go there.
 * The run size limit is install-wide, so RUN_TOO_LARGE goes to Account
 * settings rather than to the project.
 */
export type PlanFix = "prompts" | "limit" | null;

export function planFix(error: unknown): PlanFix {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("NO_MODELS") || message.startsWith("NO_PROMPTS")) return "prompts";
  if (message.startsWith("RUN_TOO_LARGE")) return "limit";
  return null;
}

export const Route = createFileRoute("/projects/$projectId/")({
  head: () => ({
    meta: [
      { title: "Visibility dashboard - Overheard AI" },
      {
        name: "description",
        content: "Mention rate, top 3 rate and citation rate for your brand across AI assistants.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { projectId } = Route.useParams();
  const isDemo = useIsDemo(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [planOpen, setPlanOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [askingPerception, setAskingPerception] = useState(false);
  const [retryingPerceptionRun, setRetryingPerceptionRun] = useState(false);
  const [perceptionNote, setPerceptionNote] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [deletingRun, setDeletingRun] = useState<string | null>(null);
  const [deletedRun, setDeletedRun] = useState<string | null>(null);
  const [attributionHidden, setAttributionHidden] = useState(true);
  // Starts unfiltered and is not persisted between sessions. Self-referenced
  // prompts are not a filter: the server never counts them.
  const [filter, setFilter] = useState<DashboardFilter>(NO_FILTER);

  // Read in an effect, not during render: this route is server rendered and
  // localStorage does not exist there.
  useEffect(() => {
    setAttributionHidden(localStorage.getItem(ATTRIBUTION_KEY) === "1");
  }, []);

  // Polled, because this list changes while you watch it: every answer can
  // discover a brand, and the first run promotes one to tracked when it
  // finalises, a moment after the run flips to completed.
  const { data: brands } = useQuery({
    queryKey: ["brands", projectId],
    queryFn: () => listBrands({ data: { projectId } }),
    refetchInterval: 15000,
  });

  const { data: prompts } = useQuery({
    queryKey: ["prompt-list", projectId],
    queryFn: () => listPrompts({ data: { projectId } }),
  });

  const { data: models } = useQuery({
    queryKey: ["project-model-list", projectId],
    queryFn: () => listProjectModels({ data: { projectId } }),
  });

  const {
    data: runs,
    isPending: runsPending,
    isError: runsError,
  } = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => listRuns({ data: { projectId, limit: 20 } }),
    refetchInterval: 5000,
  });

  // The live run-size ceiling, so the plan panel warns against the number the
  // planner will actually refuse at, not the shipped default.
  const limits = useQuery({ queryKey: ["call-limit"], queryFn: () => fetchCallLimit() });

  /**
   * A project's first Run now creates two rows: the measured run, and a
   * perception run that asks each assistant what it knows about the brand. The
   * second has no prompts, no metrics and no results page, so everything that
   * counts runs skips perception runs.
   */
  const scoredRuns = useMemo(() => (runs ?? []).filter((run) => !run.perceptionOnly), [runs]);

  const latestRun = scoredRuns[0];

  // A run row stores a failed count and nothing else, so the reason has to come
  // from the tasks. One query for the whole list, not one per run.
  const { data: failedTasks } = useQuery({
    queryKey: ["run-failures", projectId],
    queryFn: () => listFailedTaskErrors({ data: { projectId } }),
    refetchInterval: 15000,
  });

  const failuresByRun = useMemo(() => {
    const map = new Map<string, StoredFailure[]>();
    for (const task of failedTasks ?? []) {
      const list = map.get(task.runId) ?? [];
      list.push({ code: task.code, error: task.error });
      map.set(task.runId, list);
    }
    return map;
  }, [failedTasks]);

  // The prompt, the resolved question, the stored summaries and the staleness
  // verdict arrive together, so the band cannot render half a decision.
  const { data: perception } = useQuery({
    queryKey: ["perception", projectId],
    queryFn: () => getPerceptionState({ data: { projectId } }),
    refetchInterval: 15000,
  });

  /**
   * The metric rows and what the read had to leave out, in one fetch.
   * projectMetricWindow also reports whether canned rows were dropped and
   * whether older runs fell outside the row budget. The page shows the first
   * through mockExcludedNotice and does not show the second.
   */
  const { data: metricWindow } = useQuery({
    // "window" on the end because the Competitors tab holds the plain row array
    // under ["project-metrics", projectId], and two shapes cannot share one cache
    // entry. Invalidations pass the shorter key, a prefix of this one, so they
    // clear both.
    queryKey: ["project-metrics", projectId, "window"],
    queryFn: () => projectMetricWindow({ data: { projectId } }),
    refetchInterval: 8000,
  });

  const rawMetrics = metricWindow?.rows;

  /**
   * What the run would cost, fetched only while the confirmation is open.
   * `retry: false` because every planner refusal holds until the user changes
   * something, so a retry only delays the message that says what.
   */
  const {
    data: plan,
    isError: planFailed,
    error: planError,
  } = useQuery({
    queryKey: ["run-plan", projectId],
    queryFn: () => planRun({ data: { projectId } }),
    enabled: planOpen,
    retry: false,
  });

  // The same estimate the Runner line on the Prompts tab shows, so the
  // confirmation cannot disagree with it. It prices once the lazily fetched
  // plan has landed.
  const estimate = useRunEstimate({ projectId, prompts, plan });

  const target = brands?.find((b) => b.role === "target");
  const tracked = useMemo(() => (brands ?? []).filter((b) => b.role === "competitor"), [brands]);

  /**
   * Opens the comparison on the top competitor instead of on "Select
   * competitors".
   *
   * Seeded once per visit. `touched` flips both on the seed and on any picker
   * change, so a selection the user emptied stays empty on the next render.
   *
   * Reads rawMetrics, not the filtered rows: a default that moved as somebody
   * narrowed to one assistant would fight the filters.
   */
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current || compare.length > 0) return;
    // Wait for both, or the seed would rank on names alone and pick alphabetically.
    if (!brands || !rawMetrics) return;
    const top = topCandidate(
      brands.filter((b) => b.role === "competitor"),
      rawMetrics,
    );
    if (!top) return;
    touched.current = true;
    setCompare([top.id]);
  }, [brands, rawMetrics, compare.length]);

  const promptOptions = useMemo(
    () => (prompts ?? []).map((p) => ({ id: p.id, text: p.text })),
    [prompts],
  );

  // A metric row carries a model id and the filter is by assistant, so the
  // provider has to be resolved per row.
  const providerByModel = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of models ?? []) map.set(row.modelId, row.provider);
    return map;
  }, [models]);

  const nameByModel = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of models ?? []) map.set(row.modelId, row.displayName);
    return map;
  }, [models]);

  const allAssistants = useMemo(() => orderAssistants(providerByModel.values()), [providerByModel]);

  const filterContext = useMemo(
    () => ({
      providerOf: (modelId: string | null) =>
        modelId === null ? null : (providerByModel.get(modelId) ?? null),
      now: Date.now(),
    }),
    [providerByModel],
  );

  const metricRows: MetricRow[] = useMemo(() => rawMetrics ?? [], [rawMetrics]);

  const filtered = useMemo(
    () => applyFilter(metricRows, filter, filterContext),
    [metricRows, filter, filterContext],
  );

  // Which control emptied the page, so the empty state can name it.
  const filterNotice = useMemo(
    () => emptyReason(metricRows, filter, filterContext),
    [metricRows, filter, filterContext],
  );

  function toggleAssistant(provider: string, on: boolean) {
    setFilter((prev) => ({
      ...prev,
      assistants: nextAssistants(allAssistants, prev.assistants, provider, on),
    }));
  }

  const targetAgg = aggregateBrand(filtered, target?.id);

  const perceptionRows = useMemo<PerceptionSummary[]>(
    () =>
      (perception?.summaries ?? []).map((row) => ({
        model_id: row.modelId,
        question_text: row.questionText,
        knows_brand: row.knowsBrand,
        what_it_does: row.whatItDoes,
        typical_customers: row.typicalCustomers,
        well_regarded_for: row.wellRegardedFor,
        downsides: row.downsides,
        source_answers: row.sourceAnswers,
        updated_at: row.updatedAt,
      })),
    [perception],
  );

  const perceptionAggregate = perceptionRows.find((row) => row.model_id === null) ?? null;

  const perceptionByModel = useMemo(
    () => perceptionRows.filter((row) => row.model_id !== null),
    [perceptionRows],
  );

  const perceptionVisible = useMemo<NamedSummary[]>(
    () =>
      applyPerceptionFilter(perceptionByModel, filter, filterContext).map((row) => ({
        ...row,
        name: (row.model_id !== null ? nameByModel.get(row.model_id) : null) ?? "Assistant",
      })),
    [perceptionByModel, filter, filterContext, nameByModel],
  );

  const scopeHint =
    filter.period === "all"
      ? "Answers that named you (all runs)"
      : `Answers that named you (${periodLabel(filter.period).toLowerCase()})`;

  const runOrder = useMemo(() => {
    const order = new Map<string, string>();
    for (const row of filtered) if (!order.has(row.run_id)) order.set(row.run_id, row.created_at);
    return [...order.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [filtered]);

  const byRun = useMemo(() => groupBy(filtered, (row) => row.run_id), [filtered]);

  // Day one usually holds several runs, and a date-only axis would repeat the
  // same tick once per run. See lib/trend-labels.ts.
  const runLabels = useMemo(
    () => trendLabels(runOrder.map(([, createdAt]) => createdAt)),
    [runOrder],
  );

  const trend: ComparePoint[] = runOrder.map(([runId], index) => {
    const rows = byRun.get(runId) ?? [];
    const agg = aggregateBrand(rows, target?.id);
    return {
      date: runLabels[index] ?? "",
      mention: Math.round((agg.mention_rate ?? 0) * 100),
      top3: Math.round((agg.top3_rate ?? 0) * 100),
      citation: Math.round((agg.citation_rate ?? 0) * 100),
    };
  });

  const compareBrands = useMemo(
    () => tracked.filter((b) => compare.includes(b.id)),
    [compare, tracked],
  );

  const compareData: ComparePoint[] = runOrder.map(([runId], index) => {
    const rows = byRun.get(runId) ?? [];
    const point: ComparePoint = {
      date: runLabels[index] ?? "",
      you: Math.round((aggregateBrand(rows, target?.id).mention_rate ?? 0) * 100),
    };
    for (const brand of compareBrands) {
      point[brand.id] = Math.round((aggregateBrand(rows, brand.id).mention_rate ?? 0) * 100);
    }
    return point;
  });

  const compareSeries = [
    { key: "you", label: target?.name ?? "Your brand", color: seriesColor(0) },
    ...compareBrands.map((brand, i) => ({
      key: brand.id,
      label: brand.name,
      color: seriesColor(i + 1),
    })),
  ];

  /**
   * Every brand measured in the current scope, your own included.
   *
   * Built from the filtered rows, so the table answers the same question as
   * the cards above it. A brand with no row is left out, not shown as a zero:
   * nobody measured it, which is not the same as nobody mentioning it.
   */
  const competitorRows = useMemo(() => {
    const measured = new Set(filtered.map((row) => row.brand_id));
    return (brands ?? [])
      .filter((brand) => measured.has(brand.id))
      .map((brand) => ({
        brand: { id: brand.id, name: brand.name, role: brand.role },
        agg: aggregateBrand(filtered, brand.id),
      }));
  }, [brands, filtered]);

  /**
   * The dashboard rule: your brand and every tracked competitor always in,
   * discovered rivals filling the remaining top-ten places, and one sentence
   * naming what the rule hid. The Competitors tab lists all of them.
   */
  const selection = useMemo(() => selectVisibleCompetitors(competitorRows), [competitorRows]);
  const hiddenNote = hiddenDiscoveredSentence(
    selection.shownDiscovered,
    selection.hiddenDiscovered,
  );

  const completedRuns = scoredRuns.filter((r) =>
    ["completed", "partial"].includes(r.status),
  ).length;

  const trendEmpty = trendEmptyText({
    runsPending,
    runsError,
    completedRuns,
    runsInScope: runOrder.length,
    filterNotice,
  });

  /**
   * The comparison chart's own empty text. On day one both trends are empty
   * for the same reason, and one sentence printed twice in two identical boxes
   * reads as a rendering fault.
   */
  const compareTrendEmpty =
    compareBrands.length === 0
      ? "Pick a competitor above to draw them against you."
      : completedRuns === 0
        ? "Nothing to compare yet. Your first finished run draws the first line."
        : runOrder.length === 1
          ? `One run scored so far. The second gives ${compareBrands.length === 1 ? "this line" : "these lines"} somewhere to go.`
          : trendEmpty;

  const showAttribution = !attributionHidden && completedRuns > 0;

  function dismissAttribution() {
    localStorage.setItem(ATTRIBUTION_KEY, "1");
    setAttributionHidden(true);
  }

  // Promotes a discovered rival from the dashboard. The Competitors tab uses
  // the same hook, so the toast, the busy row and the two cache refreshes
  // match on both screens.
  const { trackingId, track } = useTrackBrand(projectId);

  // Asks only the perception question. No measured prompt is re-run.
  async function askPerception() {
    setAskingPerception(true);
    try {
      const result = await createPerceptionRun({ data: { projectId } });
      toast.success(
        `Asking ${result.answers} assistant${result.answers === 1 ? "" : "s"} what they know about ${target?.name ?? "your brand"}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["perception", projectId] });
    } catch (error) {
      toast.error(errorText(error, "Could not ask the perception prompt"));
    } finally {
      setAskingPerception(false);
    }
  }

  /**
   * Re-queue the failed answers of the newest perception run, from the band's
   * own notice: the run is a page nobody is taken to, so without this its
   * failures would be a dead end. The server function kicks the worker, and
   * the two invalidations are what move the notice from "failed" to "asking".
   */
  async function retryPerceptionRun() {
    const runId = perception?.lastRun?.runId;
    if (!runId) return;
    setRetryingPerceptionRun(true);
    try {
      const result = await retryFailed({ data: { runId } });
      toast.success(
        result.requeued === 0
          ? "Nothing left to retry"
          : `${result.requeued} perception ${result.requeued === 1 ? "answer" : "answers"} back in the queue`,
      );
      void queryClient.invalidateQueries({ queryKey: ["perception", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
    } catch (error) {
      toast.error(errorText(error, "Could not retry the perception answers"));
    } finally {
      setRetryingPerceptionRun(false);
    }
  }

  async function launch() {
    setLaunching(true);
    try {
      const result = await createRun({ data: { projectId } });
      const answers = toAnswers(result.plannedCalls);
      const calls = result.plannedCalls + result.perceptionCalls;
      toast.success(`Run started: ${answers} answers (${calls} provider calls)`);
      // The perception half can be refused while the measured run still
      // starts, and this is where the user learns it.
      setPerceptionNote(result.perceptionSkipped);
      if (result.perceptionSkipped) toast.warning(result.perceptionSkipped);
      void queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
      setPlanOpen(false);
      void navigate({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId, runId: result.runId },
      });
    } catch (error) {
      toast.error(errorText(error, "Could not start the run"));
    } finally {
      setLaunching(false);
    }
  }

  async function removeRun(runId: string) {
    setDeletingRun(runId);
    try {
      await deleteRun({ data: { runId } });
      setDeletedRun(runId);
      toast.success("Run deleted");
    } catch (error) {
      toast.error(errorText(error, "Could not delete that run"));
    } finally {
      setDeletingRun(null);
    }
  }

  return (
    <div className="stack-section">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-section">
            {target ? target.name : "Your brand"} across AI assistants
          </h2>
          <p className="type-meta">
            {/* Counted from the runs the cards add up, not the Runs list, which
                holds only the newest 20. */}
            {latestRun
              ? `Aggregate of ${runOrder.length} scored run${runOrder.length === 1 ? "" : "s"}, latest ${new Date(latestRun.createdAt).toLocaleString()}`
              : runsPending
                ? "Loading your runs…"
                : runsError
                  ? "We could not load your runs just now. Reload to try again."
                  : (runs ?? []).length > 0
                    ? "No scored runs yet. The perception check below does not score anything."
                    : "No runs yet."}
          </p>
        </div>
        <Button
          onClick={() => setPlanOpen(true)}
          disabled={launching || isDemo}
          title={isDemo ? DEMO_READONLY_REASON : undefined}
        >
          {launching ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          Run now
        </Button>
      </div>

      {isDemo && <DemoReadOnlyNote />}

      {perceptionNote && (
        <p className="panel p-3 text-sm text-muted-foreground">{perceptionNote}</p>
      )}

      {mockExcludedNotice(metricWindow) && (
        <p className="panel p-3 text-sm text-muted-foreground">
          {mockExcludedNotice(metricWindow)}
        </p>
      )}

      <DashboardFilters
        filter={filter}
        allAssistants={allAssistants}
        prompts={promptOptions}
        notice={filterNotice}
        onAssistantToggle={toggleAssistant}
        onPeriodChange={(period) => setFilter((prev) => ({ ...prev, period }))}
        onPromptChange={(promptId) => setFilter((prev) => ({ ...prev, promptId }))}
      />

      <PerceptionBand
        projectId={projectId}
        aggregate={perceptionAggregate}
        perModel={perceptionVisible}
        // The merged row speaks for every assistant, so it shows only while
        // nothing is filtered out. Under a partial assistant filter the band
        // shows the assistants in scope side by side.
        scopeIsEverything={perceptionVisible.length === perceptionByModel.length}
        anySummaries={perceptionByModel.length > 0}
        currentQuestion={perception?.resolvedQuestion ?? null}
        perceptionOff={perception ? !perception.enabled : false}
        onAskAgain={() => void askPerception()}
        asking={askingPerception}
        locked={isDemo ? DEMO_READONLY_REASON : null}
        lastRun={perception?.lastRun ?? null}
        onRetryRun={() => void retryPerceptionRun()}
        retryingRun={retryingPerceptionRun}
      />

      <div className="space-y-2">
        <div className="flex justify-end">
          <CountingInfo />
        </div>
        <MetricGrid agg={targetAgg} scopeHint={scopeHint} />
      </div>

      <section className="space-y-3" data-tour="trend">
        <div className="space-y-1">
          <h3 className="type-section">Visibility over time</h3>
          <p className="type-meta">Your three rates, one point per scored run.</p>
        </div>
        <CompareTrend
          data={trend}
          series={[
            // All three from the chart ramp, in slot order. A line in the muted
            // text grey reads as disabled.
            { key: "mention", label: "Mention rate", color: seriesColor(0) },
            { key: "top3", label: "Top 3 rate", color: seriesColor(1) },
            { key: "citation", label: "Citation rate", color: seriesColor(2) },
          ]}
          empty={trendEmpty}
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h3 className="type-section">Competitors</h3>
            <p className="type-meta">
              Head to head on the same answers, in the same scope as the cards above.
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {compareBrands.length === 0
                  ? "Select competitors"
                  : `${compareBrands.length} selected`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {tracked.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  Track a competitor first.
                </div>
              )}
              {tracked.map((brand) => (
                <DropdownMenuCheckboxItem
                  key={brand.id}
                  checked={compare.includes(brand.id)}
                  onCheckedChange={(checked) => {
                    touched.current = true;
                    setCompare((prev) =>
                      checked ? [...prev, brand.id] : prev.filter((id) => id !== brand.id),
                    );
                  }}
                >
                  {brand.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <CompareMetricGrid
          target={{ id: target?.id ?? "", name: target?.name ?? "Your brand", agg: targetAgg }}
          competitors={compareBrands.map((b) => ({
            id: b.id,
            name: b.name,
            agg: aggregateBrand(filtered, b.id),
          }))}
        />

        <CompareTrend data={compareData} series={compareSeries} empty={compareTrendEmpty} />

        <CompetitorTable
          rows={selection.visible}
          empty={filterNotice ?? "No brand has been measured yet."}
          track={{
            onTrack: (brand) => void track(brand),
            busyId: trackingId,
            locked: isDemo ? DEMO_READONLY_REASON : null,
          }}
        />
        {hiddenNote && <p className="type-meta">{hiddenNote}</p>}
      </section>

      <section>
        <h3 className="type-section">Runs</h3>
        {/* A four column grid, because rows hold different numbers of children
            and a flex row would put the answer count in a different place on
            every line. */}
        <div className="panel mt-3 divide-y divide-border">
          {(runs ?? []).length === 0 && (
            <p className="type-meta p-5">Nothing yet. Press "Run now" to ask your prompts.</p>
          )}
          {(runs ?? []).map((run) => {
            const outcome = runOutcome(
              run.status,
              run.completedCalls,
              run.failedCalls,
              run.plannedCalls,
            );
            const reason = dominantFailure(failuresByRun.get(run.id) ?? []);
            return (
              <div
                key={run.id}
                className="flex items-center gap-2 pr-2 transition-colors hover:bg-accent/60"
              >
                <AppLink
                  to="/projects/$projectId/runs/$runId"
                  params={{ projectId, runId: run.id }}
                  className="grid flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 text-sm sm:grid-cols-[minmax(0,13rem)_minmax(0,7rem)_minmax(0,1fr)_auto]"
                >
                  <span className="num type-meta">{new Date(run.createdAt).toLocaleString()}</span>
                  <span className="num text-sm sm:text-right">
                    {toAnswers(run.completedCalls)}/{toAnswers(run.plannedCalls)} answers
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    {/* Otherwise this row is a bare "3/3 answers, Run complete"
                        at the same timestamp as the measured run, with nothing
                        to say what it was. */}
                    {runRowBadges(run).map((badge) => (
                      <span
                        key={badge.label}
                        className={
                          badge.tone === "warn"
                            ? "whitespace-nowrap rounded-full border border-warn/40 px-2 py-0.5 text-xs text-warn"
                            : "whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                        }
                      >
                        {badge.label}
                      </span>
                    ))}
                    {reason && (
                      <span className="type-meta max-w-[16rem] truncate">{reason.title}</span>
                    )}
                  </span>
                  <StatusPill
                    tone={outcome.tone}
                    label={outcome.headline}
                    className="justify-self-end"
                  />
                </AppLink>
                <DeleteRunButton
                  label={new Date(run.createdAt).toLocaleString()}
                  onDelete={() => void removeRun(run.id)}
                  deleting={deletingRun === run.id}
                  deleted={deletedRun === run.id}
                  locked={isDemo ? DEMO_READONLY_REASON : null}
                  onDeleted={() => {
                    setDeletedRun(null);
                    void queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
                    void queryClient.invalidateQueries({
                      queryKey: ["project-metrics", projectId],
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      </section>

      {showAttribution && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Built by Trellace. Overheard AI is open source and runs on your machine.</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="grid size-6 shrink-0 place-items-center rounded hover:text-foreground"
            onClick={dismissAttribution}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <Dialog open={planOpen} onOpenChange={(open) => !launching && setPlanOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run now</DialogTitle>
            <DialogDescription>
              This is what the run will ask for before anything is spent.
            </DialogDescription>
          </DialogHeader>
          {planFailed ? (
            // Checked before `plan`: a refused refetch keeps the last good plan
            // in `data`, which would show a stale count and hide the refusal.
            <div className="space-y-2">
              <p className="text-sm text-warn">
                {errorText(planError, "We could not work out what this run needs.")}
              </p>
              {planFix(planError) === "prompts" && (
                <AppLink
                  to="/projects/$projectId/prompts"
                  params={{ projectId }}
                  className="inline-block text-sm text-primary underline"
                >
                  Open the Prompts tab
                </AppLink>
              )}
              {planFix(planError) === "limit" && (
                <AppLink to="/settings" className="inline-block text-sm text-primary underline">
                  Open Account settings
                </AppLink>
              )}
            </div>
          ) : plan ? (
            <RunPlanSummary plan={planWithEstimate(plan, estimate)} maxCalls={limits.data?.limit} />
          ) : (
            <p className="text-sm text-muted-foreground">Working out what the next run needs…</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanOpen(false)} disabled={launching}>
              Cancel
            </Button>
            <Button onClick={() => void launch()} disabled={launching || !plan || planFailed}>
              {launching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Start run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
