import type { Availability } from "@/lib/availability";
import { Button } from "@/components/ui/button";

export const NO_KEY_CONFIGURED =
  "No provider key is configured, so nothing can be asked yet. Add OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_API_KEY to the .env file in the app's folder, then press Check again. There is no need to restart.";

/**
 * Renders the states of a gate that is not on: still checking, could not
 * check, and unavailable. A check that has not landed or that failed is not a
 * "no", and showing it as one tells the user a working feature is missing.
 */
export function AvailabilityNotice({
  availability,
  onRetry,
}: {
  availability: Availability;
  onRetry?: (() => void) | undefined;
}) {
  if (availability.state === "loading") {
    return (
      <div className="panel p-4 text-sm text-muted-foreground">
        <span className="num">Checking…</span>
      </div>
    );
  }

  if (availability.state === "unknown") {
    return (
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-muted-foreground">
        <span>{availability.reason}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  if (availability.state === "off") {
    return <div className="panel p-4 text-sm text-muted-foreground">{availability.reason}</div>;
  }

  return null;
}
