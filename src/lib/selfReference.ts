/**
 * A prompt is "self-referenced" when it names your own brand ("is Acme good
 * for X?"). Those answers almost always mention you, so counting them inflates
 * mention rate. Detection runs against the brand record at read time, so a
 * renamed brand or a new variant applies to every past run on the next read.
 * Names are normalised by ./brand-matching, the same rule extraction uses, so
 * "is Acme good?" is detected for a brand called "Acme Inc".
 */
import { normalizeName as norm } from "./brand-matching";

export function isSelfReferenced(
  text: string,
  brand: { name: string; variants?: string[] | null } | null | undefined,
): boolean {
  if (!brand) return false;
  const haystack = ` ${norm(text)} `;
  const needles = [brand.name, ...(brand.variants ?? [])].map(norm).filter((n) => n.length >= 3);
  return needles.some((n) => haystack.includes(` ${n} `));
}

/** Ids of every prompt whose text names the target brand. */
export function selfReferencedPromptIds(
  prompts: { id: string; text: string }[] | null | undefined,
  brand: { name: string; variants?: string[] | null } | null | undefined,
): Set<string> {
  return new Set((prompts ?? []).filter((p) => isSelfReferenced(p.text, brand)).map((p) => p.id));
}
