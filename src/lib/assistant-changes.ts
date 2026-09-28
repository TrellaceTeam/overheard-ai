/**
 * Where a project's assistants changed from one run to the next. A trend that
 * crosses a change compares different models, so the dashboard says at which
 * run each change falls.
 */

export interface AssistantChange {
  /** When the first run with the new set was created. */
  at: string;
  added: string[];
  removed: string[];
}

/**
 * `runs` is oldest first, as [run id, created at]. A run with no known
 * assistants is skipped rather than read as every assistant removed.
 */
export function assistantChanges(
  runs: ReadonlyArray<readonly [string, string]>,
  runModels: Readonly<Record<string, readonly string[]>>,
): AssistantChange[] {
  const changes: AssistantChange[] = [];
  let previous: ReadonlySet<string> | null = null;
  for (const [runId, at] of runs) {
    const models = runModels[runId];
    if (!models || models.length === 0) continue;
    const current = new Set(models);
    if (previous) {
      const before = previous;
      const added = [...current].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !current.has(id));
      if (added.length > 0 || removed.length > 0) changes.push({ at, added, removed });
    }
    previous = current;
  }
  return changes;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One change as a sentence, for the line under the trend. */
export function assistantChangeLine(
  change: AssistantChange,
  nameOf: (modelId: string) => string,
  date: string,
): string {
  const added = list(change.added.map(nameOf));
  const removed = list(change.removed.map(nameOf));
  if (added && removed) return `From ${date}, runs ask ${added} instead of ${removed}.`;
  if (added) return `From ${date}, runs also ask ${added}.`;
  return `From ${date}, runs no longer ask ${removed}.`;
}
