/**
 * The canonical perception prompt, and how it is resolved.
 *
 * The prompt's stored default is the column default on
 * `projects.perception_prompt` (0001_initial.sql), so every project created
 * without one is seeded from it. The setup screen also needs the text, to
 * pre-fill the perception prompt card before a project exists, so it is held
 * here as well. The two are kept identical by a schema test, which fails the
 * moment either one is edited on its own.
 *
 * Interpolation exists twice. The server's interpolateBrand (create-run.ts)
 * resolves `{brand}` when a run fans out, which is what gets asked and stored
 * on `run_tasks.question_text`, and this resolves it again for the previews in
 * setup and project settings. The two must agree, or the screen shows a prompt
 * that is not the one asked. Both replace every occurrence, and both leave the
 * token in place when there is no target brand: an unresolved `{brand}` is
 * visible, whereas "What do you know about ?" looks like a bug in the prompt
 * the user wrote.
 */

export const BRAND_TOKEN = "{brand}";

/** The canonical perception prompt. Must match the column default character for character. */
export const PERCEPTION_TEMPLATE = `What do you know about {brand}?

Please cover, in order: what {brand} does; who its typical customers are, including their size and the industries they work in; what it is well regarded for; and what criticisms, weaknesses or common complaints come up, with specifics rather than generalities.

If you are not familiar with {brand}, say so plainly instead of guessing.`;

/** The prompt as it will be asked, with {brand} resolved. */
export function resolvePerceptionPrompt(prompt: string, brand: string | null | undefined): string {
  const name = brand?.trim();
  if (!name) return prompt;
  // split/join rather than replace, which would substitute only the first.
  return prompt.split(BRAND_TOKEN).join(name);
}

/**
 * Whether this project asks a perception prompt at all.
 *
 * A blank prompt is the off switch, so there is no separate enabled flag to
 * disagree with it. createPerceptionRun applies the same test and refuses to
 * start a run for a blank prompt.
 */
export function perceptionEnabled(prompt: string | null | undefined): boolean {
  return Boolean(prompt?.trim());
}
