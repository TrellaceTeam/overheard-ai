/**
 * Grouping the Prompts tab by tag, and keeping tags from splintering.
 *
 * The tag is stored in `prompts.category`. Nothing that composes a question
 * reads it.
 *
 * These are labels, not kinds. Nothing branches on the value, so a user can
 * move prompts from `visibility` to `top of funnel`, or invent five tags of
 * their own, and the only thing that changes is how the list is stacked.
 */

/** Seeded by onboarding, so they sort to the top ahead of anything invented. */
export const SEEDED_TAGS: string[] = ["visibility", "comparison"];

export type TagGroup<T> = { tag: string | null; prompts: T[] };

type Taggable = { category: string | null };

/**
 * Prompts stacked under their tag: seeded tags first in their seeded order,
 * then everything else alphabetically, then untagged last.
 *
 * Untagged goes last because it is a leftover, not a heading.
 *
 * A tag of `""` or `"   "` is treated as no tag. The column has no check
 * against it, and a group with a blank heading would look like the untagged
 * pile while sorting somewhere else entirely.
 */
export function groupByTag<T extends Taggable>(prompts: T[]): TagGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const prompt of prompts) {
    const key = prompt.category?.trim() ? prompt.category : null;
    const list = groups.get(key);
    if (list) list.push(prompt);
    else groups.set(key, [prompt]);
  }

  const rank = (tag: string | null) => {
    if (tag === null) return 2;
    return SEEDED_TAGS.includes(tag.toLowerCase()) ? 0 : 1;
  };

  return [...groups.entries()]
    .map(([tag, list]) => ({ tag, prompts: list }))
    .sort((a, b) => {
      const byRank = rank(a.tag) - rank(b.tag);
      if (byRank !== 0) return byRank;
      if (a.tag === null || b.tag === null) return 0;
      const ai = SEEDED_TAGS.indexOf(a.tag.toLowerCase());
      const bi = SEEDED_TAGS.indexOf(b.tag.toLowerCase());
      if (ai !== -1 && bi !== -1) return ai - bi;
      return a.tag.localeCompare(b.tag);
    });
}

/**
 * The spelling to store for a tag somebody just typed.
 *
 * A free-text field beside a dropdown of existing values is how you end up with
 * `Visibility`, `visibility ` and `VISIBILITY` as three separate groups holding
 * one idea. A new tag matching an existing one apart from case or surrounding
 * space reuses the existing spelling, so the groups stay merged.
 *
 * Only case and whitespace. Anything cleverer, such as stemming, near-matching
 * or singular and plural, would merge tags a user meant to keep apart, and
 * that error is invisible, where a duplicate heading is one they can see and
 * fix.
 */
export function canonicalTag(draft: string, existing: string[]): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return null;
  const match = existing.find((tag) => tag.trim().toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}

/** "23 answers", "1 answer", or a plain sentence when the prompt has never run. */
export function answerCountLabel(answers: number | undefined): string {
  if (answers === undefined || answers === 0) return "no answers yet";
  return `${answers} answer${answers === 1 ? "" : "s"}`;
}
