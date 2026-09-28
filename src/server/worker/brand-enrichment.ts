/**
 * The two passes that run once a run has drained and touch `brands` instead of
 * measurements: seeding a newly seen brand's variants and domains, and tracking
 * one rival automatically at the end of a project's first measured run.
 *
 * pass.ts runs them after the claim loop, in this order: enrichNewBrands, then
 * finalizeRun, then autoTrackTopCompetitor. They live apart from extraction.ts
 * because extraction is a pure contract over one answer and these are database
 * passes over a whole run.
 */
import { linkHost, normalizeName } from "@/lib/brand-matching";
import { topCandidate } from "@/lib/top-competitor";
import type { Driver } from "../db/driver";
import {
  countTrackedCompetitors,
  hasEarlierCompletedMeasuredRun,
  isMeasuredRun,
  listBrandIdsSeenInOtherRuns,
  listBrandsForEnrichment,
  listDiscoveredBrands,
  listRunObservations,
  listRunWideMetrics,
  promoteBrandToCompetitor,
  updateBrandLists,
  type BrandPatch,
} from "./queries";

/** At most five seeded variants and three seeded domains per brand. */
const MAX_VARIANTS = 5;
const MAX_DOMAINS = 3;

/**
 * Seed name variants and domains for brands making their first appearance in a
 * run, using only that run's observations.
 *
 * Existing values are never touched, so manual edits win, and a brand seen in
 * an earlier run is skipped entirely, so a brand is only ever seeded once.
 *
 * The user's own brand is never rewritten silently: for role `target` new hosts
 * go to `suggested_domains`, and only when that list is currently empty.
 */
export function enrichNewBrands(db: Driver, runId: string, projectId: string): void {
  const observations = listRunObservations(db, runId);
  if (observations.length === 0) return;

  const ids = [...new Set(observations.map((o) => o.brand_id))];
  const seenBefore = listBrandIdsSeenInOtherRuns(db, ids, runId);
  const brands = listBrandsForEnrichment(db, projectId, ids);

  for (const brand of brands) {
    if (seenBefore.has(brand.id)) continue;
    const rows = observations.filter((o) => o.brand_id === brand.id);
    const patch: BrandPatch = {};

    if (brand.variants.length === 0) {
      const canonical = normalizeName(brand.name);
      const variants = [
        ...new Set(
          rows.map((r) => r.raw_name.trim()).filter((n) => n && normalizeName(n) !== canonical),
        ),
      ].slice(0, MAX_VARIANTS);
      if (variants.length > 0) patch.variants = variants;
    }

    if (brand.domains.length === 0 || brand.role === "target") {
      const domains = [
        ...new Set(rows.map((r) => linkHost(r.linked_url)).filter((h): h is string => Boolean(h))),
      ].slice(0, MAX_DOMAINS);
      if (domains.length > 0) {
        if (brand.role === "target") {
          const known = new Set(brand.domains);
          const fresh = domains.filter((d) => !known.has(d));
          if (fresh.length > 0 && brand.suggested_domains.length === 0) {
            patch.suggested_domains = fresh;
          }
        } else {
          patch.domains = domains;
        }
      }
    }

    updateBrandLists(db, brand.id, patch);
  }
}

/**
 * Tracks one rival automatically at the end of a project's first measured run.
 *
 * Tracking is otherwise a manual promotion, so a new user would reach the
 * dashboard with an empty Competitors picker, just as they decide whether the
 * product is worth using.
 *
 * Two guards keep it to once:
 *
 *   - this must be the project's first completed measured run.
 *   - the project must have no tracked competitor yet.
 *
 * The second makes a repeat pass over the same run a no-op, and keeps a
 * competitor the user chose during onboarding from gaining a second one
 * beside it. The first means a user who removes the tracked rival does not
 * get it back on a later run.
 *
 * Safe after finalizeRun because `role` is not an input to any metric:
 * finalizeRun never reads `brands`. That is also why this reads finalizeRun's
 * own output instead of counting observations again.
 */
export function autoTrackTopCompetitor(db: Driver, runId: string, projectId: string): void {
  if (!isMeasuredRun(db, runId)) return;
  if (hasEarlierCompletedMeasuredRun(db, projectId, runId)) return;
  if (countTrackedCompetitors(db, projectId) > 0) return;

  const discovered = listDiscoveredBrands(db, projectId);
  if (discovered.length === 0) return;

  const rows = listRunWideMetrics(db, runId);

  // Only brands this run measured. A brand discovered by an earlier run did
  // not show up in this one, and with no rows it would win on the name
  // tie-break alone.
  const measured = new Set(rows.map((r) => r.brand_id));
  const winner = topCandidate(
    discovered.filter((b) => measured.has(b.id)),
    rows,
  );
  if (!winner) return;

  promoteBrandToCompetitor(db, winner.id);
}
