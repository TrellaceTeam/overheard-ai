import { Check, Loader2, Sparkles } from "lucide-react";
import { TOUR_SELECTORS } from "@/components/TutorialTour";
import { Button } from "@/components/ui/button";
import {
  EDITED_HINT,
  type GenerateState,
  generateButtonLabel,
  NO_KEY_HINT,
  THREE_DOORS_LINE,
} from "@/lib/starter-generation";

/**
 * The line under the prompt library that names the three doors (keep the
 * five, edit them by hand, or generate a set), and the generate button.
 *
 * The button is null in the tutorial, which never shows it: the tour rings
 * the line alone. The rough cost is on the button before any spend, because
 * the call goes to the user's own key. The route owns the server call, the
 * busy state and the toast.
 */
export function WizardPromptDoors({
  button,
}: {
  button: { state: GenerateState; costUsd: number; onGenerate: () => void } | null;
}) {
  return (
    <div className="space-y-3" data-tour={TOUR_SELECTORS.wizardDoors}>
      <p className="type-meta">{THREE_DOORS_LINE}</p>
      {button && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={button.state !== "armed"}
            title={button.state === "edited" ? EDITED_HINT : undefined}
            onClick={button.onGenerate}
          >
            {button.state === "generating" ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : button.state === "generated" ? (
              <Check className="mr-2 size-3.5" />
            ) : (
              <Sparkles className="mr-2 size-3.5" />
            )}
            {generateButtonLabel(button.state, button.costUsd)}
          </Button>
          {button.state === "no-key" && <p className="type-meta">{NO_KEY_HINT}</p>}
        </div>
      )}
    </div>
  );
}
