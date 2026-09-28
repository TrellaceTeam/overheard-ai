/**
 * Turns a thrown server error into a sentence a user can read.
 *
 * Every refusal raised by src/server carries a machine-readable prefix, for
 * example `NO_MODELS: select at least one assistant`. The prefix is for callers
 * to branch on, not for a person to read in a toast. This strips it and leaves
 * the sentence, which is written to stand on its own.
 *
 * An HTTP status line is left intact: `HTTP 500: ...` has a space before the
 * colon, so it does not match, which is what we want. Those go through
 * classifyFailure instead.
 */
const CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/;

export function stripCode(message: string): string {
  return message.replace(CODE_PREFIX, "");
}

/** Upper-cases the first letter, because the sentence after a code starts in lower case. */
function sentence(text: string): string {
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A ZodError's message is the JSON of its issues array, which reads as a stack
 * trace in a toast. When a message parses as that array, each issue becomes a
 * sentence naming the field and the bound it broke, and they are joined.
 */
function zodIssues(message: string): string | null {
  if (!message.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const parts: string[] = [];
  for (const issue of parsed) {
    if (typeof issue !== "object" || issue === null) return null;
    const record = issue as {
      code?: unknown;
      path?: unknown;
      message?: unknown;
      maximum?: unknown;
      minimum?: unknown;
    };
    if (typeof record.message !== "string") return null;
    const path = Array.isArray(record.path)
      ? record.path.filter((step): step is string => typeof step === "string").join(".")
      : "";
    const label = path === "" ? "This value" : sentence(path);
    if (record.code === "too_big" && typeof record.maximum === "number") {
      parts.push(`${label} must be at most ${record.maximum}.`);
    } else if (record.code === "too_small" && typeof record.minimum === "number") {
      parts.push(`${label} must be at least ${record.minimum}.`);
    } else {
      parts.push(`${label}: ${record.message}.`);
    }
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * The message to show for a caught error, or `fallback` when there is nothing
 * readable in it. Never returns an empty string.
 */
export function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  // The browser's own words for "the server is not there", which is a state
  // of the app, not of the request: say what to do about it.
  if (raw === "Failed to fetch") {
    return "Overheard AI cannot reach its own server. Start the app again, then reload this page.";
  }
  const text = sentence(stripCode(zodIssues(raw) ?? raw));
  return text === "" ? fallback : text;
}
