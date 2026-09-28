/**
 * Who the dashboard's competitor table lists, as one rule both screens share.
 *
 * Discovered rivals pile up without bound, so the table does not show every
 * measured brand. Your own brand and every tracked competitor are always in,
 * whatever their rate. Discovered competitors fill the remaining places of a
 * top ten, most mentioned first. What did not fit is named in one sentence
 * that points at the Competitors tab, which lists all of them.
 *
 * Typed against the least it needs, not a component's prop shape: any row with
 * a named brand, a role and a mention rate.
 */

/** The slice of a measured-brand row the rule reads. Both screens' rows satisfy it. */
export interface RankedBrandRow {
  brand: { id: string; name: string; role: string };
  agg: { mention_rate: number | null };
}

/**
 * Places for non-target rows. Tracked competitors take theirs first and are
 * never capped; discovered ones fill what is left.
 */
export const COMPETITOR_TABLE_LIMIT = 10;

/**
 * Most mentioned first. A brand with no measured rate (null) sorts last, and
 * ties break by name, so the dashboard and the Competitors tab, which both use
 * this ranking, never disagree about who comes first.
 */
export function rankByMention<T extends RankedBrandRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ra = a.agg.mention_rate;
    const rb = b.agg.mention_rate;
    if (ra === null && rb !== null) return 1;
    if (rb === null && ra !== null) return -1;
    if (ra !== null && rb !== null && ra !== rb) return rb - ra;
    return a.brand.name.localeCompare(b.brand.name);
  });
}

export interface CompetitorSelection<T extends RankedBrandRow> {
  /** What the table shows, in ranking order. */
  visible: T[];
  shownDiscovered: number;
  hiddenDiscovered: number;
}

/**
 * Apply the dashboard rule: own brand and tracked competitors always visible,
 * discovered ranked and capped at the remaining places. Input order does not
 * matter; output is ranked.
 */
export function selectVisibleCompetitors<T extends RankedBrandRow>(
  rows: readonly T[],
  limit: number = COMPETITOR_TABLE_LIMIT,
): CompetitorSelection<T> {
  const kept = rows.filter((row) => row.brand.role !== "discovered");
  const discovered = rankByMention(rows.filter((row) => row.brand.role === "discovered"));
  // Tracked competitors eat into the ten places; they are never capped
  // themselves, so a project that tracks twelve rivals shows twelve.
  const places = Math.max(0, limit - kept.filter((row) => row.brand.role === "competitor").length);
  const shown = discovered.slice(0, places);
  return {
    visible: rankByMention([...kept, ...shown]),
    shownDiscovered: shown.length,
    hiddenDiscovered: discovered.length - shown.length,
  };
}

/**
 * The line under the table when the rule hid something, or null when nothing
 * was hidden. An all-tracked table gets its own sentence instead of "top 0".
 */
export function hiddenDiscoveredSentence(shown: number, hidden: number): string | null {
  if (hidden <= 0) return null;
  if (shown === 0) {
    return `Every place is taken by a tracked competitor. The ${hidden} discovered ${hidden === 1 ? "one is" : "ones are"} in the Competitors tab.`;
  }
  return `Showing the top ${shown} of ${shown + hidden} discovered competitors; the rest are in the Competitors tab.`;
}
