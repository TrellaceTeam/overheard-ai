/**
 * Which rival is the most present one, given a set of measured rows.
 *
 * The worker asks at the end of a project's first run, to pick which
 * discovered brand to start tracking. The dashboard asks to pick which tracked
 * competitor its comparison opens on. Both want the rival you would look at
 * first, so both use this rule.
 *
 * It works over rows, not a query, because the callers hold different row
 * sets: the worker has the run-wide scope rows, one per brand, and the
 * dashboard has per-model, per-prompt rows already narrowed by its filters.
 */

/** The little a row needs for one brand's presence to be comparable. */
export type PresenceRow = {
  brand_id: string | null;
  mentions: number | null;
  answers: number | null;
  top3_rate: number | null;
};

export type Candidate = { id: string; name: string };

type Presence = { mentions: number; top3: number };

/**
 * Ranked by mentions, then by top-3 placements, then by name.
 *
 * Counts, not rates: every candidate shares the same scope, so the counts
 * order them as the rates would, and a count is never null. A short first run
 * often ties rivals on mentions, which is why placement comes next. The name
 * tie-break makes the order stable, so the same data always auto-tracks the
 * same competitor.
 */
export function rankCandidates<T extends Candidate>(candidates: T[], rows: PresenceRow[]): T[] {
  const presence = new Map<string, Presence>();
  for (const row of rows) {
    if (!row.brand_id) continue;
    const seen = presence.get(row.brand_id) ?? { mentions: 0, top3: 0 };
    seen.mentions += Number(row.mentions ?? 0);
    // The stored rate times its own scope's answers recovers the count; the
    // rate is rounded to four places, so the product is rounded back.
    seen.top3 += Math.round(Number(row.top3_rate ?? 0) * Number(row.answers ?? 0));
    presence.set(row.brand_id, seen);
  }
  const of = (id: string): Presence => presence.get(id) ?? { mentions: 0, top3: 0 };

  return [...candidates].sort(
    (a, b) =>
      of(b.id).mentions - of(a.id).mentions ||
      of(b.id).top3 - of(a.id).top3 ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The single most present candidate, or null if there are none.
 *
 * A candidate with no rows at all is still eligible. The dashboard can be asked
 * this before any run has been measured, and pre-selecting a competitor
 * somebody typed in by hand beats opening on an empty chart.
 */
export function topCandidate<T extends Candidate>(candidates: T[], rows: PresenceRow[]): T | null {
  return rankCandidates(candidates, rows)[0] ?? null;
}
