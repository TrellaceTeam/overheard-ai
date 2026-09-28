/**
 * Brands: the target, the competitors being tracked, and the ones the worker
 * discovered in an answer.
 *
 * A competitor's domain is optional, and without one it scores no citations.
 * A domain that is given must look like one. Correcting a domain re-decides
 * every past observation and re-scores the runs it touched, so fixing a typo
 * repairs past runs as well as future ones.
 */
import type { Driver } from "../../db/driver";
import type { BrandRole, BrandRow, SqlBool } from "../../db/types";
import { isCitation, isPlausibleDomain, normalizeDomain } from "@/lib/brand-matching";
import { finalizeRun } from "../../logic/finalize-run";
import { normalizeDomains } from "./projects";
import {
  encodeList,
  expectChanged,
  InvalidInputError,
  newId,
  NotFoundError,
  nowIso,
  parseList,
  refuseDemoForBrand,
  refuseDemoProject,
} from "./shared";

export interface BrandView {
  id: string;
  name: string;
  role: BrandRole;
  variants: string[];
}

export interface BrandFullView extends BrandView {
  domains: string[];
  suggestedDomains: string[];
  createdAt: string;
}

/** Role order for the competitors screen: the target, then tracked, then found. */
const ROLE_ORDER = "CASE role WHEN 'target' THEN 0 WHEN 'competitor' THEN 1 ELSE 2 END";

function toView(row: BrandRow): BrandView {
  return { id: row.id, name: row.name, role: row.role, variants: parseList(row.variants) };
}

function toFullView(row: BrandRow): BrandFullView {
  return {
    ...toView(row),
    domains: parseList(row.domains),
    suggestedDomains: parseList(row.suggested_domains),
    createdAt: row.created_at,
  };
}

/** Name, role and variants, for the screens that show brands rather than edit them. */
export function listBrands(db: Driver, projectId: string): BrandView[] {
  return db
    .prepare(`SELECT * FROM brands WHERE project_id = ? ORDER BY ${ROLE_ORDER}, created_at, id`)
    .all<BrandRow>(projectId)
    .map(toView);
}

/** Everything the competitors and settings screens edit. */
export function listBrandsFull(db: Driver, projectId: string): BrandFullView[] {
  return db
    .prepare(`SELECT * FROM brands WHERE project_id = ? ORDER BY ${ROLE_ORDER}, created_at, id`)
    .all<BrandRow>(projectId)
    .map(toFullView);
}

/** The brand this project is about, or null if it has none. */
export function getTargetBrand(db: Driver, projectId: string): BrandFullView | null {
  const row = db
    .prepare(
      `SELECT * FROM brands
        WHERE project_id = ? AND role = 'target' AND is_active = 1
        ORDER BY created_at LIMIT 1`,
    )
    .get<BrandRow>(projectId);
  return row ? toFullView(row) : null;
}

export function getBrand(db: Driver, brandId: string): BrandFullView {
  const row = db.prepare("SELECT * FROM brands WHERE id = ?").get<BrandRow>(brandId);
  if (!row) throw new NotFoundError("BRAND_NOT_FOUND", "that brand does not exist");
  return toFullView(row);
}

/**
 * The brand in this project with the same name, or null.
 *
 * Matched in JavaScript, not with `lower(name) = lower(?)`, because SQLite's
 * lower() folds only A-Z. A name with an umlaut and the same name in capitals
 * would miss, the unique index (also on lower(name)) would accept the insert,
 * and the project would hold two rows for one brand, each scoring about half
 * its mentions. nameKey folds both.
 *
 * A project holds tens of brands, so reading them all is cheap. The read and
 * the insert that follows run synchronously, so nothing can slip between them.
 */
function findBrandByName(
  db: Driver,
  projectId: string,
  name: string,
): { id: string; role: BrandRole; name: string } | null {
  const key = nameKey(name);
  const rows = db
    .prepare("SELECT id, role, name FROM brands WHERE project_id = ?")
    .all<{ id: string; role: BrandRole; name: string }>(projectId);
  const hit = rows.find((row) => nameKey(row.name) === key);
  return hit ? { id: hit.id, role: hit.role, name: hit.name } : null;
}

/** Two brand names are the same when their keys match. Folds non-ASCII letters, unlike SQLite's lower(). */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export interface CreateCompetitorInput {
  projectId: string;
  name: string;
  /** Empty for none. A non-empty value that does not look like a domain is refused. */
  domain: string;
}

/**
 * What the add turned out to be: a new row, or a brand that already existed
 * under that name. The caller turns the case into a message.
 */
export interface CreateCompetitorResult {
  id: string;
  /** The stored name: the existing brand's, or the trimmed input. */
  name: string;
  /** Where the name was found: discovered (promoted by this call), competitor (left untouched), or null for a new row. */
  existingRole: "discovered" | "competitor" | null;
  /**
   * What re-scoring corrected when a promoted brand brought a domain, and null
   * otherwise. A discovered brand's past answers were scored with no domains,
   * so its citations are recomputed as soon as one arrives.
   */
  rescored: { changed: number; runs: number } | null;
}

export function createCompetitor(db: Driver, input: CreateCompetitorInput): CreateCompetitorResult {
  refuseDemoProject(db, input.projectId);
  const name = input.name.trim();
  if (name === "") throw new InvalidInputError("NO_NAME", "give the competitor a name");

  const domain = input.domain.trim();
  if (domain !== "" && !isPlausibleDomain(domain)) {
    throw new InvalidInputError(
      "BAD_DOMAIN",
      "that does not look like a domain. Use the form acme.example.com, or leave it empty",
    );
  }
  const domains = encodeList(domain === "" ? [] : [normalizeDomain(domain)]);

  const existing = findBrandByName(db, input.projectId, name);
  if (existing && existing.role === "target") {
    // The project's own brand cannot be a competitor. setBrandRole refuses the
    // same move with the same code, and the promotion below would otherwise
    // demote the target.
    throw new InvalidInputError(
      "TARGET_BRAND",
      "that is this project's own brand, so it cannot be added as a competitor",
    );
  }
  if (existing && existing.role === "competitor") {
    // Already tracked. Re-adding changes nothing and the caller says so. A
    // tracked brand's domains are edited on its card, never overwritten from
    // this form.
    return { id: existing.id, name: existing.name, existingRole: "competitor", rescored: null };
  }
  if (existing) {
    // A discovered brand is promoted, not duplicated: the unique index would
    // refuse the insert, and the observations on that row are kept. With no
    // domain given, the row keeps the domains it has.
    if (domain === "") {
      db.prepare("UPDATE brands SET role = 'competitor' WHERE id = ?").run(existing.id);
      return {
        id: existing.id,
        name: existing.name,
        existingRole: "discovered",
        rescored: null,
      };
    }
    db.prepare("UPDATE brands SET role = 'competitor', domains = ? WHERE id = ?").run(
      domains,
      existing.id,
    );
    // Every past citation verdict for this brand was decided without the new
    // domain. Recomputing calls no provider, because the links are stored.
    const rescored = recomputeCitations(db, existing.id);
    return { id: existing.id, name: existing.name, existingRole: "discovered", rescored };
  }

  const id = newId();
  db.prepare(
    `INSERT INTO brands (id, project_id, name, role, variants, domains, suggested_domains, created_at)
     VALUES (?, ?, ?, 'competitor', '[]', ?, '[]', ?)`,
  ).run(id, input.projectId, name, domains, nowIso());
  return { id, name, existingRole: null, rescored: null };
}

export interface UpdateBrandInput {
  id: string;
  name?: string | undefined;
  variants?: string[] | undefined;
  domains?: string[] | undefined;
  suggestedDomains?: string[] | undefined;
}

/**
 * Edit a brand's name, variants and domains. Invalid domains are refused by
 * name, not dropped, so a user who mistyped one is told which.
 */
export function updateBrand(db: Driver, input: UpdateBrandInput): { ok: true } {
  refuseDemoForBrand(db, input.id);
  const sets: string[] = [];
  const params: string[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") throw new InvalidInputError("NO_NAME", "give the brand a name");
    sets.push("name = ?");
    params.push(name);
  }
  if (input.variants !== undefined) {
    sets.push("variants = ?");
    params.push(encodeList(input.variants));
  }
  if (input.domains !== undefined) {
    sets.push("domains = ?");
    params.push(encodeList(normalizeDomains(input.domains)));
  }
  if (input.suggestedDomains !== undefined) {
    sets.push("suggested_domains = ?");
    params.push(encodeList(input.suggestedDomains.map(normalizeDomain)));
  }

  if (sets.length === 0) return { ok: true };

  params.push(input.id);
  const changes = db
    .prepare(`UPDATE brands SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params).changes;
  expectChanged(changes, "BRAND_NOT_FOUND", "that brand does not exist");
  return { ok: true };
}

/**
 * Track a discovered brand, or stop tracking one. The target brand's role
 * cannot change, because a project without a target has nothing to measure.
 */
export function setBrandRole(
  db: Driver,
  input: { id: string; role: Extract<BrandRole, "competitor" | "discovered"> },
): { ok: true } {
  refuseDemoForBrand(db, input.id);
  const row = db
    .prepare("SELECT id, role FROM brands WHERE id = ?")
    .get<{ id: string; role: BrandRole }>(input.id);
  if (!row) throw new NotFoundError("BRAND_NOT_FOUND", "that brand does not exist");
  if (row.role === "target") {
    throw new InvalidInputError(
      "TARGET_BRAND",
      "the brand this project is about cannot be untracked",
    );
  }

  const changes = db
    .prepare("UPDATE brands SET role = ? WHERE id = ?")
    .run(input.role, input.id).changes;
  expectChanged(changes, "BRAND_NOT_FOUND", "that brand does not exist");
  return { ok: true };
}

/**
 * Delete a brand and re-score every finalised run it was measured in. Its
 * observations keep their raw name with a null brand_id, which finalisation
 * skips, so the re-scored runs read as if the brand had never been tracked.
 */
export function deleteBrand(db: Driver, brandId: string): { ok: true } {
  refuseDemoForBrand(db, brandId);
  const row = db.prepare("SELECT role FROM brands WHERE id = ?").get<{ role: BrandRole }>(brandId);
  if (!row) throw new NotFoundError("BRAND_NOT_FOUND", "that brand does not exist");
  if (row.role === "target") {
    throw new InvalidInputError(
      "TARGET_BRAND",
      "the brand this project is about cannot be deleted",
    );
  }

  const scoredRuns = db
    .prepare(
      `SELECT id FROM runs
        WHERE finalised_at IS NOT NULL
          AND id IN (SELECT run_id FROM run_metrics WHERE brand_id = ?
                     UNION SELECT run_id FROM brand_observations WHERE brand_id = ?)`,
    )
    .all<{ id: string }>(brandId, brandId);

  // The metric rows go before the brand. Left to the foreign key they would
  // become null-brand rows, and two deleted brands in one scope would collide
  // on run_metrics_scope_idx.
  db.transaction(() => {
    db.prepare("DELETE FROM run_metrics WHERE brand_id = ?").run(brandId);
    db.prepare("DELETE FROM brands WHERE id = ?").run(brandId);
  });

  for (const run of scoredRuns) finalizeRun(db, run.id);
  return { ok: true };
}

export interface RecomputeResult {
  /** Observations whose citation verdict changed. */
  changed: number;
  /** Runs whose metrics were recomputed because of it. */
  runs: number;
}

/**
 * Re-decide whether each of a brand's observations counts as a citation, then
 * recompute the metrics of every run where a verdict moved.
 *
 * is_cited is set at extraction time and run_metrics when the run is
 * finalised, so neither follows a domain edit on its own. Each observation
 * stores its linked_url, so this calls no provider.
 */
export function recomputeCitations(db: Driver, brandId: string): RecomputeResult {
  refuseDemoForBrand(db, brandId);
  const brand = db
    .prepare("SELECT id, domains FROM brands WHERE id = ?")
    .get<{ id: string; domains: string }>(brandId);
  if (!brand) throw new NotFoundError("BRAND_NOT_FOUND", "that brand does not exist");

  const domains = parseList(brand.domains);
  const observations = db
    .prepare(
      `SELECT id, run_id, linked_url, is_cited FROM brand_observations
        WHERE brand_id = ? LIMIT 50000`,
    )
    .all<{ id: string; run_id: string; linked_url: string | null; is_cited: SqlBool }>(brandId);

  const affectedRuns = new Set<string>();
  const toCited: string[] = [];
  const toUncited: string[] = [];

  for (const observation of observations) {
    const correct = isCitation(observation.linked_url, domains);
    if (correct === (observation.is_cited === 1)) continue;
    (correct ? toCited : toUncited).push(observation.id);
    affectedRuns.add(observation.run_id);
  }

  if (toCited.length + toUncited.length === 0) return { changed: 0, runs: 0 };

  db.transaction(() => {
    const update = db.prepare("UPDATE brand_observations SET is_cited = ? WHERE id = ?");
    for (const id of toCited) update.run(1, id);
    for (const id of toUncited) update.run(0, id);
  });

  // finalizeRun rebuilds a whole run, so it runs once per affected run.
  for (const runId of affectedRuns) finalizeRun(db, runId);

  return { changed: toCited.length + toUncited.length, runs: affectedRuns.size };
}
