import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const COUNTING_RULE =
  "Prompts that name your own brand are asked and kept, but never count in statistics, so they cannot inflate your results.";

/**
 * Explains how statistics are counted. The server always applies the rule to
 * the statistics the screens read, and this tooltip is where a reader learns
 * why some stored answers are missing from a figure.
 */
export function CountingInfo() {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex cursor-help items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Info className="size-3.5" aria-hidden="true" />
            How is this counted?
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{COUNTING_RULE}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
