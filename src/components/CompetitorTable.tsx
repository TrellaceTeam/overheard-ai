import { pct } from "@/components/MetricCard";
import { TrackButton } from "@/components/TrackButton";
import type { BrandView, CompetitorRow } from "@/components/types";

const ROLE_CLASS: Record<string, string> = {
  target: "border-primary/40 text-primary",
  competitor: "border-border text-mist",
  discovered: "border-dashed border-border text-muted-foreground",
};

/* The stored role is an enum and the pill is user text. "target" never appears
   in user text, and competitors split into tracked and discovered, the words
   the rest of the app uses. */
const ROLE_LABEL: Record<string, string> = {
  target: "Your brand",
  competitor: "Tracked",
  discovered: "Discovered",
};

function Role({ role }: { role: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${
        ROLE_CLASS[role] ?? ROLE_CLASS["competitor"]
      }`}
    >
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

/**
 * What a screen passes for the table to offer inline tracking of discovered
 * rows. Without it, as on the run detail screen, there is no action column.
 */
export type TableTrack = {
  onTrack: (brand: BrandView) => void;
  /** The brand whose role change is in flight, if any. */
  busyId: string | null;
  /** When set, every Track button is disabled and this says why. */
  locked: string | null;
};

/**
 * The brand-by-brand table on the run detail screen and the dashboard. Rank
 * rate and top pick share appear only here, where they are read across brands
 * in one scope and not as a headline.
 *
 * Every column after the first two holds a rate, so they are right aligned and
 * tabular: a column of figures is compared by its last digit.
 *
 * A screen that passes `track` gets a Track button on each discovered row, so
 * promoting a rival does not need a trip to the Competitors tab.
 */
export function CompetitorTable({
  rows,
  empty = "No competitor observations yet.",
  track,
}: {
  rows: CompetitorRow[];
  empty?: string | undefined;
  track?: TableTrack | undefined;
}) {
  const columns = track ? 7 : 6;
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-3xl text-sm">
        <thead className="type-label text-left">
          <tr className="border-b border-border">
            <th className="px-4 py-3 font-medium">Brand</th>
            <th className="px-4 py-3 font-medium">Role</th>
            <th className="px-4 py-3 text-right font-medium">Mention rate</th>
            <th className="px-4 py-3 text-right font-medium">Rank rate</th>
            <th className="px-4 py-3 text-right font-medium">Share of voice</th>
            <th className="px-4 py-3 text-right font-medium">Top pick share</th>
            {track && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="type-meta px-4 py-4" colSpan={columns}>
                {empty}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr
              key={row.brand.id}
              className="border-b border-border/60 transition-colors last:border-0 hover:bg-accent/60"
            >
              <td className="px-4 py-3 font-medium">{row.brand.name}</td>
              <td className="px-4 py-3">
                <Role role={row.brand.role} />
              </td>
              <td className="num px-4 py-3 text-right">{pct(row.agg.mention_rate)}</td>
              <td className="num px-4 py-3 text-right">{pct(row.agg.rank_rate)}</td>
              <td className="num px-4 py-3 text-right">{pct(row.agg.share_of_voice)}</td>
              <td className="num px-4 py-3 text-right">{pct(row.agg.top_pick_share)}</td>
              {track && (
                <td className="px-4 py-3 text-right">
                  {row.brand.role === "discovered" && (
                    <TrackButton
                      onTrack={() => track.onTrack(row.brand)}
                      busy={track.busyId === row.brand.id}
                      locked={track.locked}
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
