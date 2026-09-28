import { MetricCard, pct } from "@/components/MetricCard";
import type { Agg } from "@/lib/metrics";

/**
 * The three headline numbers.
 *
 * Rank metrics stay out of the headline. A rank is not a number a brand owner
 * can act on, and an average rank hides its own denominator: a brand ranked
 * once, first, reports "average rank 1.0" beside a brand ranked third in every
 * answer. Top 3 rate keeps every answer in the denominator, so it stays
 * comparable between brands and between runs.
 *
 * Mention rate counts any mention, with no sentiment gate. A negative mention
 * rate is not computed anywhere.
 */
export function MetricGrid({
  agg,
  scopeHint,
  subject = "target",
  variant = "card",
  tourId = "metrics",
}: {
  agg: Agg;
  scopeHint?: string | undefined;
  /** Whose numbers these are. A competitor's card must not say "you": the
      top 3 and citation hints address the reader, and on a competitor panel
      that reads as if the competitor's rank were the user's own. */
  subject?: "target" | "competitor" | undefined;
  /** "plain" for grids that already sit inside a panel of their own. */
  variant?: "card" | "plain" | undefined;
  /** Null on pages that reuse the grid away from the dashboard, so the tour's
      data-tour="metrics" selector never matches twice. */
  tourId?: string | null | undefined;
}) {
  const them = subject === "competitor";
  return (
    <div
      className={`grid gap-3 sm:grid-cols-3 ${variant === "plain" ? "sm:gap-8" : ""}`}
      data-tour={tourId ?? undefined}
    >
      <MetricCard
        label="Mention rate"
        value={pct(agg.mention_rate)}
        ratio={agg.mention_rate}
        variant={variant}
        hint={scopeHint ?? (them ? "Answers that named them (all runs)" : "Answers that named you")}
        // The product green means "this is your brand", so a competitor's
        // panel, which reuses this grid, does not paint its mention rate in it.
        tone={them ? "default" : "signal"}
      />
      <MetricCard
        label="Top 3 rate"
        value={pct(agg.top3_rate)}
        ratio={agg.top3_rate}
        variant={variant}
        hint={
          them
            ? "Answers ranking them in the first three"
            : "Answers ranking you in the first three"
        }
      />
      <MetricCard
        label="Citation rate"
        value={pct(agg.citation_rate)}
        ratio={agg.citation_rate}
        variant={variant}
        hint={them ? "Answers linking one of their domains" : "Answers linking one of your domains"}
      />
    </div>
  );
}
