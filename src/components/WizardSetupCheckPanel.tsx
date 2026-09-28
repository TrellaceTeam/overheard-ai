import { Loader2 } from "lucide-react";
import { SetupCheckRows } from "@/components/SetupCheckRows";
import { Button } from "@/components/ui/button";
import type { SelectionCheck } from "@/components/useSelectionCheck";

/** The panel that runs the setup check on the ticked assistants and shows each model's result. */
export function WizardSetupCheckPanel({ check }: { check: SelectionCheck }) {
  return (
    <div className="space-y-3">
      <h2 className="type-section">Setup check</h2>
      <div className="panel space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          The setup check asks each assistant you picked one short question on the exact model, with
          web search forced, and asks the extractor a plain one. It costs about a cent per OpenAI or
          Anthropic model and nothing noticeable on Gemini. Creating runs it again server-side, so
          nothing is spent on a run that was always going to fail.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={check.checking}
          onClick={() => void check.run()}
        >
          {check.checking && <Loader2 className="mr-2 size-3.5 animate-spin" />}
          {check.gate === "never" ? "Run setup check" : "Run setup check again"}
        </Button>
        {check.error && <p className="text-sm text-warn">{check.error}</p>}
        {check.report && check.gate === "selection-changed" && (
          <p className="text-xs text-warn">
            You changed the assistant selection since that check. Run it again.
          </p>
        )}
        {check.report && <SetupCheckRows report={check.report} />}
      </div>
    </div>
  );
}
