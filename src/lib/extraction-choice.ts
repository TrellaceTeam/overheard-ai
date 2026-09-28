/**
 * Which model reads the answers: the project's preferred extractor when it is
 * a candidate and its provider has a key, otherwise the first candidate on a
 * keyed provider, otherwise nothing. `candidates` arrive cheapest first. The
 * worker, both summary writers, project creation and the setup check all
 * resolve through this, so none of them picks a model whose provider has no
 * key.
 *
 * Client-safe: the wizard picks the extractor a create would pick, from the
 * catalogue it already has, with no database in reach.
 */
export function pickExtraction<T extends { provider: string }>(
  candidates: readonly T[],
  preferred: T | null | undefined,
  keyedProviders: readonly string[],
): T | null {
  const ordered =
    preferred !== null && preferred !== undefined && candidates.includes(preferred)
      ? [preferred, ...candidates.filter((candidate) => candidate !== preferred)]
      : candidates;
  const keyed = new Set(keyedProviders);
  return ordered.find((candidate) => keyed.has(candidate.provider)) ?? null;
}
