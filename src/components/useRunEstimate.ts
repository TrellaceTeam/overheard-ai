import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunPlan } from "@/components/types";
import { estimateRunSpend, type PricedModelRow } from "@/lib/run-estimate";
import { listExtractionModels, listModels, listProjectModels } from "@/server/api/models";
import { getProjectSettings } from "@/server/api/projects";

/** The iteration facts the estimate needs from a prompt library. */
export interface EstimatePrompt {
  is_active: number;
  archived: number;
  iterations: number;
}

/**
 * Which prompts a run counts: switched on and not archived. The plan line's
 * reconciliation and the estimate must agree on it, so both read it from here.
 */
export function countsTowardRun(prompt: EstimatePrompt): boolean {
  return prompt.is_active === 1 && prompt.archived === 0;
}

/**
 * The next run's price, computed the wizard's way (lib/run-estimate): list
 * prices, typical call sizes, the project's own extractor, and perception only
 * while the planner says the next run adds it. The Runner's inline line and
 * both Run now dialogs read their estimate from here, so the confirmation
 * where the spend is decided cannot disagree with the line that led to it.
 */
export function useRunEstimate({
  projectId,
  prompts,
  plan,
}: {
  projectId: string;
  /** The project's prompts, from whichever query the caller already keeps. */
  prompts: readonly EstimatePrompt[] | undefined;
  /** The planner's next-run plan. Its perception count decides whether perception is priced. */
  plan: RunPlan | null | undefined;
}): number | null {
  // Priced only once a plan exists: on screens that fetch the plan lazily for
  // the dialog, the catalogues stay unfetched until the dialog can show a plan.
  const hasPlan = plan != null;
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => listModels(),
    enabled: hasPlan,
  });
  const selected = useQuery({
    queryKey: ["project-models", projectId],
    queryFn: () => listProjectModels({ data: { projectId } }),
    enabled: hasPlan,
  });
  const extractionModels = useQuery({
    queryKey: ["extraction-models"],
    queryFn: () => listExtractionModels(),
    enabled: hasPlan,
  });
  const settings = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => getProjectSettings({ data: { projectId } }),
    enabled: hasPlan,
  });

  // Held back until every input has resolved: an estimate that silently omits
  // the extractor while the settings load would show a wrong number next to a
  // correct call count.
  return useMemo(() => {
    if (
      !plan ||
      !prompts ||
      !models.data ||
      !selected.data ||
      !extractionModels.data ||
      !settings.data
    ) {
      return null;
    }
    // The catalogue rows carry the price columns the estimate reads, but the
    // API's row type does not name them, hence the two casts.
    const catalogue = models.data as PricedModelRow[];
    const extractionCatalogue = extractionModels.data as PricedModelRow[];
    const totalIterations = prompts
      .filter(countsTowardRun)
      .reduce((sum, prompt) => sum + prompt.iterations, 0);
    return estimateRunSpend({
      totalIterations,
      assistants: selected.data
        .map((row) => catalogue.find((model) => model.id === row.modelId))
        .filter((model): model is PricedModelRow => model !== undefined),
      extractorId: settings.data.extractionModelId ?? null,
      extractionCatalogue,
      includePerception: (plan.perceptionCalls ?? 0) > 0,
    });
  }, [plan, prompts, models.data, selected.data, extractionModels.data, settings.data]);
}
