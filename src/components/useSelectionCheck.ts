import { useState } from "react";
import { errorText } from "@/lib/error-text";
import { checkUnlocksCreate, setupCheckGate } from "@/lib/onboarding";
import { allRowsPassed } from "@/lib/setup-check";
import { modelsSetupCheck, type SetupCheckReport } from "@/server/api/settings";

/** A setup check report, with the selection it was run against. */
export type SelectionReport = SetupCheckReport & { checkedSelection: string[] };

/**
 * The setup check the wizard's create gate hangs on: every ticked assistant at
 * its exact model with web search forced, plus the extractor a create would
 * pick. A report only proves something about the selection it was run on.
 */
export function useSelectionCheck(selectedModelIds: string[]) {
  const [report, setReport] = useState<SelectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gateNow = () =>
    setupCheckGate({
      checkedSelection: report?.checkedSelection ?? null,
      checkedAt: report?.checkedAt ?? null,
      rows: report?.rows ?? [],
      selectedModelIds,
      now: Date.now(),
    });
  const gate = gateNow();

  /** Returns whether the gate may open. The report stays on screen either way. */
  async function run(): Promise<"passed" | "failed"> {
    const selection = [...selectedModelIds];
    setChecking(true);
    setError(null);
    try {
      const next = await modelsSetupCheck({ data: { assistantModelIds: selection } });
      setReport({ ...next, checkedSelection: selection });
      return allRowsPassed(next.rows) ? "passed" : "failed";
    } catch (failure) {
      setReport(null);
      setError(errorText(failure, "Could not run the setup check"));
      return "failed";
    } finally {
      setChecking(false);
    }
  }

  /**
   * True once the gate holds at this moment. A stale pass runs again first:
   * the gate exists to be true when money is about to be spent.
   */
  async function ensurePassed(): Promise<boolean> {
    if (gateNow() === "passed") return true;
    return (await run()) === "passed";
  }

  return {
    report,
    checking,
    error,
    gate,
    unlocked: checkUnlocksCreate(gate),
    run,
    ensurePassed,
  };
}

export type SelectionCheck = ReturnType<typeof useSelectionCheck>;
