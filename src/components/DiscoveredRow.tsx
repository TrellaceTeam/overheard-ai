import { pct } from "@/components/MetricCard";
import { DeleteBrandButton } from "@/components/DeleteBrandButton";
import { TrackButton } from "@/components/TrackButton";

/**
 * One discovered competitor as a compact row: name, times mentioned, mention
 * rate, Track.
 *
 * A brand nobody tracks yet has no variants, domains or deep dive to show, so
 * it gets none of the tracked card's furniture. It uses the same TrackButton as
 * the dashboard's table, so promoting a rival looks the same everywhere.
 *
 * The count sits beside the rate because a rate alone rounds away the signal:
 * one mention in a hundred answers reads as 1%, one mention in a small run
 * reads as a big rate, and a single mention behind a 0% rate reads as nothing.
 *
 * Delete sits quietly at the far end. The extractor finds stray names that are
 * not rivals at all, and this is how one is cleared out of the lists.
 */
export function DiscoveredRow({
  name,
  mentionRate,
  mentions,
  busy = false,
  locked = null,
  deleting = false,
  onTrack,
  onDelete,
}: {
  name: string;
  /** Mention rate in the screen's current scope. Null when unmeasured. */
  mentionRate: number | null;
  /** Times mentioned in the screen's current scope. */
  mentions: number;
  /** This row's role change is in flight. */
  busy?: boolean | undefined;
  /** When set, actions are unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
  deleting?: boolean | undefined;
  onTrack: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="num type-meta whitespace-nowrap">
          Mentioned <span className="text-foreground">{mentions}</span>{" "}
          {mentions === 1 ? "time" : "times"} · Mention rate{" "}
          <span className="text-foreground">{pct(mentionRate)}</span>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <TrackButton onTrack={onTrack} busy={busy} locked={locked} />
        <DeleteBrandButton
          brandName={name}
          onDelete={onDelete}
          deleting={deleting}
          locked={locked}
        />
      </div>
    </div>
  );
}
