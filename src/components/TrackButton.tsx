import { Loader2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The Track control, shared by the dashboard's competitor table and the
 * Competitors tab's compact rows. Promoting a discovered rival is the same
 * promise on both screens, so it gets the same button: same icon, same busy
 * spinner, same demo lock.
 */
export function TrackButton({
  onTrack,
  busy = false,
  locked = null,
}: {
  onTrack: () => void;
  /** This brand's role change is in flight. */
  busy?: boolean | undefined;
  /** When set, tracking is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onTrack}
      disabled={busy || locked !== null}
      title={locked ?? undefined}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />}
      Track
    </Button>
  );
}
