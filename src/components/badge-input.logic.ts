/**
 * Commits a raw string into an existing list. The string may be comma or
 * newline separated, so a list pasted from a spreadsheet works. Fragments are
 * trimmed, empties dropped and duplicates removed case-insensitively, keeping
 * the first casing. The list never grows past `limit`.
 */
export function commitEntries(current: string[], raw: string, limit: number): string[] {
  const parts = raw
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const next = [...current];
  for (const part of parts) {
    if (next.length >= limit) break;
    if (!next.some((v) => v.toLowerCase() === part.toLowerCase())) next.push(part);
  }
  return next;
}
