import { AlertTriangle } from "lucide-react";
import type { RunPlan } from "@/components/types";
import { DEFAULT_MAX_PLANNED_CALLS } from "@/lib/call-limits";
import { money } from "@/lib/money";

/**
 * The planner's ceiling when a caller does not pass the live one: the shared
 * tight default, so a big plan warns here before the run exists. The real
 * limit is the install's setting (app_state.max_planned_calls), and the server
 * refusal names it when a plan is over. Callers that know the live limit
 * should pass maxCalls.
 */
export const MAX_PLANNED_CALLS = DEFAULT_MAX_PLANNED_CALLS;

/**
 * The plan a Run now confirmation shows: the planner's counts, plus the shared
 * estimate once it has resolved. A null estimate (still loading, or a screen
 * that cannot price the run) drops the dollar line instead of showing a stale
 * or zero figure. Both Run now dialogs build their summary this way, so the
 * confirmation and the Runner line beside it agree about the money.
 */
export function planWithEstimate(plan: RunPlan, estimate: number | null | undefined): RunPlan {
  return { ...plan, estimateUsd: estimate ?? undefined };
}

/**
 * What a run will cost before the Run button is pressed: how many answers,
 * across how many assistants and prompts, and how many provider calls that is.
 *
 * Both units are shown. Answers is what the user chose. Calls is what they are
 * charged for, and it is double, because scoring an answer is a second call.
 * Hiding that and then showing a provider bill twice the size is how a
 * local-first tool loses trust in one run.
 *
 * The perception line is there for the same reason: a project's first run also
 * asks each assistant what it knows about the brand, and that is real spend.
 */
export function RunPlanSummary({
  plan,
  maxCalls = MAX_PLANNED_CALLS,
}: {
  plan: RunPlan;
  maxCalls?: number | undefined;
}) {
  const overCeiling = plan.calls > maxCalls;
  const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const perceptionCalls = plan.perceptionCalls ?? 0;

  return (
    <div className="panel space-y-2 p-4">
      <p className="num text-sm">
        <span className="font-semibold">{noun(plan.answers, "answer", "answers")}</span> from{" "}
        {noun(plan.assistants, "assistant", "assistants")} across{" "}
        {noun(plan.prompts, "prompt", "prompts")}.
      </p>
      <p className="num text-xs text-muted-foreground">
        {noun(plan.calls, "provider call", "provider calls")}: one to ask each prompt and one to
        read the answer back. You pay the provider directly.
      </p>
      {plan.estimateUsd !== undefined && (
        <p className="num text-sm">
          This run will cost about <span className="font-semibold">{money(plan.estimateUsd)}</span>{" "}
          on your own keys, at list prices. Every answer's real cost is logged as it lands.
        </p>
      )}
      {perceptionCalls > 0 && (
        <p className="num text-xs text-muted-foreground">
          Plus {noun(perceptionCalls, "call", "calls")} to ask each assistant what it already knows
          about your brand. That happens on your first run only.
        </p>
      )}
      {overCeiling && (
        <p className="flex items-start gap-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="num">
            That is over your run size limit of {maxCalls} calls, so this run will not start. Lower
            some iterations, switch off an assistant, or raise the limit in Account settings.
          </span>
        </p>
      )}
    </div>
  );
}
