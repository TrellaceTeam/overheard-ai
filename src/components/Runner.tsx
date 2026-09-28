import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RunPlanSummary, planWithEstimate } from "@/components/RunPlanSummary";
import { useRunEstimate, countsTowardRun } from "@/components/useRunEstimate";
import { assistantLabel, orderAssistants } from "@/lib/dashboard-filters";
import { providerLabel } from "@/lib/failure-reasons";
import { keyEnvNamesSafe } from "@/lib/provider-keys";
import { toAnswers } from "@/lib/run-progress";
import { errorText } from "@/lib/error-text";
import { money } from "@/lib/money";
import { listModels, listProjectModels, setProjectModel } from "@/server/api/models";
import { createRun, kickWorker, planRun } from "@/server/api/runs";
import { callLimit as fetchCallLimit, keyStatus as fetchKeyStatus } from "@/server/api/settings";

/** A catalogue row the Runner needs: what a chip shows and what an estimate costs. */
export interface RunnerModel {
  id: string;
  provider: string;
  display_name: string;
  tier: string;
  input_price_per_mtok?: number | string;
  output_price_per_mtok?: number | string;
  search_price_per_call?: number | string;
}

export interface RunnerModelGroup {
  provider: string;
  models: RunnerModel[];
}

/**
 * The catalogue as one row per provider, in the order the wizard and the
 * dashboard filters use, so three screens cannot disagree about which provider
 * comes first.
 */
export function groupModels(models: readonly RunnerModel[]): RunnerModelGroup[] {
  const byProvider = new Map<string, RunnerModel[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider);
    if (list) list.push(model);
    else byProvider.set(model.provider, [model]);
  }
  return orderAssistants(byProvider.keys()).map((provider) => ({
    provider,
    models: byProvider.get(provider) ?? [],
  }));
}

/** The line the Runner shows while the key check is in flight, or after it failed. */
export function heldLine(state: "checking" | "failed"): string {
  return state === "failed"
    ? "We could not check which provider keys are set. Reload to try again."
    : "Checking which provider keys are set…";
}

/**
 * The plan reconciled into one line: how many answers, from how many
 * assistants, over how many active prompts, at how many iterations.
 *
 * The iterations factor shows only when every active prompt repeats the same
 * number of times and that number multiplies out to the planner's total. The
 * library list and the plan are two queries, and a factor from one that does
 * not match the other would print a false equation. Otherwise the line shows
 * the planner's totals without a factor.
 */
export function planLine(input: {
  assistants: number;
  prompts: number;
  answers: number;
  /** Iterations of every active prompt, one entry each. */
  iterations: readonly number[];
}): string {
  const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const { assistants, prompts, answers, iterations } = input;
  const first = iterations[0];
  const uniform =
    first !== undefined &&
    iterations.every((n) => n === first) &&
    assistants * prompts * first === answers
      ? first
      : null;
  const factors = `${noun(assistants, "assistant", "assistants")} × ${noun(
    prompts,
    "prompt",
    "prompts",
  )}${uniform === null ? "" : ` × ${noun(uniform, "iteration", "iterations")}`}`;
  return `${factors} = ${noun(answers, "answer", "answers")}`;
}

/**
 * The selector rows: one thin line per provider with its models as toggle
 * chips, each chip naming its tier in visible text. A provider with no key is
 * a single greyed row saying why. A model the project still monitors keeps its
 * chip on that row, because switching off a model whose key has gone must stay
 * possible. While the key check is in flight nothing unselected is offered,
 * and a visible line says the check is running, since no input can reach a
 * tooltip on a disabled button.
 */
export function AssistantRows({
  groups,
  selectedIds,
  keyedProviders,
  keysUnresolved,
  keyCheckFailed,
  locked,
  onToggle,
}: {
  groups: readonly RunnerModelGroup[];
  selectedIds: ReadonlySet<string>;
  keyedProviders: ReadonlySet<string>;
  keysUnresolved: boolean;
  keyCheckFailed: boolean;
  /** The demo reason when nothing here may move, otherwise null. */
  locked: string | null;
  onToggle: (modelId: string, on: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const keyed = keyedProviders.has(group.provider);
        const noKey = !keysUnresolved && !keyed;
        const selectedModels = group.models.filter((model) => selectedIds.has(model.id));
        const chipModels = noKey ? selectedModels : group.models;
        return (
          <div
            key={group.provider}
            className={`flex items-start gap-3 ${noKey ? "opacity-60" : ""}`}
          >
            <span className="type-label w-20 shrink-0 pt-1.5">
              {assistantLabel(group.provider)}
            </span>
            {noKey ? (
              <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                {chipModels.map((model) => (
                  <Chip
                    key={model.id}
                    model={model}
                    selected
                    disabled={locked !== null}
                    onToggle={onToggle}
                  />
                ))}
                <span>
                  No {providerLabel(group.provider)} key. Set{" "}
                  {keyEnvNamesSafe(group.provider) ?? "its API key"} in your environment and restart
                  Overheard AI to ask it.
                </span>
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {chipModels.map((model) => {
                  const selected = selectedIds.has(model.id);
                  const held = keysUnresolved && !selected;
                  return (
                    <Chip
                      key={model.id}
                      model={model}
                      selected={selected}
                      disabled={locked !== null || held}
                      onToggle={onToggle}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {keysUnresolved && (
        <div className="flex items-start gap-3">
          {/* The same label column the rows above use, so the line sits under
              the chips rather than under the provider names. */}
          <span className="w-20 shrink-0" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {heldLine(keyCheckFailed ? "failed" : "checking")}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One model chip. The tier sits inside it as visible text, in the wizard's
 * vocabulary. A disclosure on hover or focus gives touch users nothing, and no
 * input can reach it on a disabled chip (demo lock, held keys).
 */
function Chip({
  model,
  selected,
  disabled,
  onToggle,
}: {
  model: RunnerModel;
  selected: boolean;
  disabled: boolean;
  onToggle: (modelId: string, on: boolean) => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "default" : "outline"}
      aria-pressed={selected}
      disabled={disabled}
      className="h-7 gap-1.5 font-normal"
      onClick={() => onToggle(model.id, !selected)}
    >
      {model.display_name}{" "}
      {/* The tier is text, so it carries the same 4.5:1 duty as the name:
          full-strength on the selected fill, muted only where muting still
          measures above the floor (paper on void at 70% is 9.7:1). */}
      <span className={selected ? "text-xs" : "text-xs opacity-70"}>· {model.tier}</span>
    </Button>
  );
}

/** The prompts the plan line counts, as the library already holds them. */
export interface RunnerPrompt {
  id: string;
  is_active: number;
  archived: number;
  iterations: number;
}

/**
 * The Runner: the block at the top of the Prompts tab that holds everything the
 * next run needs: which assistants are asked, what that collects and costs,
 * and the button that starts it. Project settings keeps the extractor, which
 * is about reading answers back, not about the next run.
 */
export function Runner({
  projectId,
  locked,
  prompts,
}: {
  projectId: string;
  /** The demo reason when the Runner must not move, otherwise null. */
  locked: string | null;
  prompts: readonly RunnerPrompt[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [launching, setLaunching] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  const models = useQuery({ queryKey: ["models"], queryFn: () => listModels() });
  const selected = useQuery({
    queryKey: ["project-models", projectId],
    queryFn: () => listProjectModels({ data: { projectId } }),
  });
  const keys = useQuery({ queryKey: ["key-status"], queryFn: () => fetchKeyStatus() });
  // Same query and key the library's refresh invalidates, so switching a prompt
  // on or off below re-prices the line above without a second call.
  const plan = useQuery({
    queryKey: ["run-plan", projectId],
    queryFn: () => planRun({ data: { projectId } }),
    retry: false,
  });
  const limits = useQuery({ queryKey: ["call-limit"], queryFn: () => fetchCallLimit() });

  const groups = useMemo(() => groupModels((models.data ?? []) as RunnerModel[]), [models.data]);
  const selectedIds = useMemo(
    () => new Set((selected.data ?? []).map((row) => row.modelId)),
    [selected.data],
  );
  const keyedProviders = useMemo(
    () =>
      new Set((keys.data ?? []).filter((row) => row.configured).map((row) => String(row.provider))),
    [keys.data],
  );
  const keysUnresolved = keys.isPending || keys.isError;

  // The active library's iterations, for the plan line's reconciliation. The
  // answers count itself comes from the planner, never from this arithmetic.
  const activePrompts = prompts.filter(countsTowardRun);

  // The estimate the confirmation dialog shows too, so the line and the
  // dialog cannot disagree.
  const estimate = useRunEstimate({ projectId, prompts, plan: plan.data });

  async function toggle(modelId: string, on: boolean) {
    try {
      await setProjectModel({ data: { projectId, modelId, on } });
      void queryClient.invalidateQueries({ queryKey: ["project-models", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["run-plan", projectId] });
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    }
  }

  /** The same launch the dashboard's Run button performs, confirmation included. */
  async function runNow() {
    setLaunching(true);
    try {
      const result = await createRun({ data: { projectId } });
      const calls = result.plannedCalls + result.perceptionCalls;
      const answers = toAnswers(result.plannedCalls);
      toast.success(`Run started: ${answers} answers (${calls} provider calls)`);
      if (result.perceptionSkipped) toast.warning(result.perceptionSkipped);
      void kickWorker().catch(() => undefined);
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

  return (
    <section className="panel space-y-4 p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="type-section">Next run</h2>
        {locked && <p className="text-xs text-muted-foreground">{locked}</p>}
      </div>

      <fieldset
        disabled={locked !== null}
        className="m-0 space-y-4 border-0 p-0 disabled:opacity-60"
      >
        <AssistantRows
          groups={groups}
          selectedIds={selectedIds}
          keyedProviders={keyedProviders}
          keysUnresolved={keysUnresolved}
          keyCheckFailed={keys.isError}
          locked={locked}
          onToggle={(modelId, on) => void toggle(modelId, on)}
        />

        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
          <div className="min-w-0 flex-1 space-y-1">
            {plan.isError ? (
              // Checked before plan.data: a refetch that refuses (a plan over
              // the call limit) leaves the last good plan in `data`, and
              // showing that would show a stale count and hide the refusal.
              <p className="text-sm text-warn">
                {errorText(plan.error, "We could not work out what a run would cost.")}
              </p>
            ) : plan.data ? (
              <p className="num text-sm">
                {planLine({
                  assistants: plan.data.assistants,
                  prompts: plan.data.prompts,
                  answers: plan.data.answers,
                  iterations: activePrompts.map((prompt) => prompt.iterations),
                })}
                {" · "}
                <span className="num">{plan.data.calls} provider calls</span>
                {estimate !== null && (
                  <>
                    {" · about "}
                    <span className="font-semibold">{money(estimate)}</span> at list prices
                  </>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Working out what this run needs…</p>
            )}
          </div>
          <Button
            onClick={() => setPlanOpen(true)}
            disabled={launching || plan.isError || !plan.data || locked !== null}
            title={locked ?? undefined}
          >
            {launching ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run now
          </Button>
        </div>
      </fieldset>

      <Dialog open={planOpen} onOpenChange={(open) => !launching && setPlanOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run now</DialogTitle>
            <DialogDescription>
              This is what the run will ask for before anything is spent.
            </DialogDescription>
          </DialogHeader>
          {plan.isError ? (
            <p className="text-sm text-warn">
              {errorText(plan.error, "We could not work out what this run needs.")}
            </p>
          ) : plan.data ? (
            <RunPlanSummary
              plan={planWithEstimate(plan.data, estimate)}
              maxCalls={limits.data?.limit}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Working out what this run needs…</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanOpen(false)} disabled={launching}>
              Cancel
            </Button>
            <Button
              onClick={() => void runNow()}
              disabled={launching || !plan.data || plan.isError}
            >
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
    </section>
  );
}
