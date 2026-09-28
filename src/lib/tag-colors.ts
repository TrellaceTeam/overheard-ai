/**
 * Which palette slot a tag wears.
 *
 * A stable hash of the tag's canonical spelling (trimmed and lowercased, the
 * normalisation canonicalTag dedupes with), never its position in the
 * project's tag list: an index from ordering would repaint every chip the
 * moment a tag is inserted or renamed, and two fresh databases would disagree.
 * Collisions are expected and harmless. The chip's text carries the identity,
 * and the colour only helps the eye group.
 *
 * FNV-1a over UTF-16 code units: deterministic across engines, no dependency,
 * good enough avalanche for a six-slot palette.
 */

/** Slots in the --tag-N palette in styles.css. */
export const TAG_COLOR_COUNT = 6;

export function tagColorIndex(tag: string): number {
  const key = tag.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // imul can leave the sign bit set; the modulo must not go negative.
  return (hash >>> 0) % TAG_COLOR_COUNT;
}

/**
 * The data attribute value a chip wears: 1-based palette slot, because 0 is
 * left to the neutral (untagged) chip in the stylesheet.
 */
export function tagColorSlot(tag: string | null): number {
  return tag === null ? 0 : tagColorIndex(tag) + 1;
}
