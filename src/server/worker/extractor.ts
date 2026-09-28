import type { Driver } from "../db/driver";
import type { ModelRow } from "../db/types";
import { pickExtraction } from "@/lib/extraction-choice";
import { configuredProviders } from "./keys";
import { getPreferredExtractionModelId, listExtractionCandidates } from "./queries";

/**
 * The project's extraction model, by the shared rule in lib/extraction-choice:
 * its preferred extractor when that is a candidate and its provider has a key,
 * else the cheapest keyed candidate, else null. Under the mock seam every
 * provider has a key. Project creation and the setup check apply the same rule
 * to the client-facing catalogue list before a project exists.
 */
export function resolveExtractionModel(db: Driver, projectId: string | null): ModelRow | null {
  const candidates = listExtractionCandidates(db);
  const preferredId = projectId === null ? null : getPreferredExtractionModelId(db, projectId);
  const preferred = preferredId
    ? (candidates.find((candidate) => candidate.id === preferredId) ?? null)
    : null;
  return pickExtraction(candidates, preferred, configuredProviders());
}
