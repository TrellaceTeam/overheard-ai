/**
 * The typed failure vocabulary written where failures happen.
 *
 * Every failed run task records one of these codes beside its detail text, so
 * classification matches a code instead of parsing prose, and a failure kind
 * that reaches the persisting seam without a code does not compile. The detail
 * column (`run_tasks.error`) holds the scrubbed message: the technical-detail
 * disclosure shows it, and a row with no code carries it alone.
 *
 * Stored grammar: `BASE` or `BASE:param`. A param exists only where the card
 * needs one: the provider slug, the HTTP status, the stop reason, the search
 * failure reason. Params are part of the code, never scraped from sentences.
 */

export const FAILURE_CODES = [
  /** The user stopped the run; the task was never asked. Not a fault. */
  "CANCELLED_BY_USER",
  /** The attempt ceiling closed a task that never recorded a reason. */
  "MAX_ATTEMPTS_EXCEEDED",
  /** No API key for the provider the call needs. Param: provider slug. */
  "MISSING_CREDENTIAL",
  /**
   * Subscription mode: the provider's command could not be started, or is not
   * signed in. Param: provider slug.
   */
  "CLI_SIGN_IN",
  /** Subscription mode: the user's plan is at its usage limit. Param: provider slug. */
  "PLAN_LIMIT",
  /** A model names a provider this build has no adapter for. Param: provider slug. */
  "UNSUPPORTED_PROVIDER",
  /** No key for any model that can read answers. */
  "NO_EXTRACTION_CREDENTIAL",
  /** The task row has no question to ask. */
  "PROMPT_MISSING",
  /** The provider answered with no text. Param: reported stop reason. */
  "EMPTY_ANSWER",
  /** A search-capable model answered without searching; the answer is thrown away. */
  "NO_WEB_SEARCH",
  /** The provider's own search step failed. Param: provider failure reason. */
  "WEB_SEARCH_FAILED",
  /** A call asked for enforced shape and web search together. */
  "SCHEMA_WITH_SEARCH",
  /** Extraction ran against a task whose answer is gone. */
  "NO_ANSWER_TO_EXTRACT",
  /** The call passed its wall-clock budget. */
  "TIMEOUT",
  /** No time was left on the budget before the call started. */
  "DEADLINE_EXCEEDED",
  /** The transport failed below HTTP: DNS, socket, connection reset. */
  "NETWORK",
  /** The provider returned an error response. Param: HTTP status. */
  "HTTP",
  /** Every reader on the extraction ladder replied in the wrong shape. */
  "EXTRACTION_UNREADABLE",
  /** Every reader tried stopped at its output token limit before finishing. */
  "EXTRACTION_TRUNCATED",
  /** One reader replied in the wrong shape (the perception path, and prose-only rows). */
  "SCHEMA_VIOLATION",
  /** A throw this codebase did not recognise: a bug, or a new failure kind. */
  "UNEXPECTED",
] as const;

export type FailureCodeBase = (typeof FAILURE_CODES)[number];

/** The stored form: a base alone, or a base with one structured param. */
export type FailureCode = FailureCodeBase | `${FailureCodeBase}:${string}`;

export function failureCode(base: FailureCodeBase, param?: string | number | null): FailureCode {
  return param === undefined || param === null || param === "" ? base : `${base}:${param}`;
}

export type ParsedFailureCode = { base: FailureCodeBase; param: string | null };

/**
 * Reads the stored grammar. Null when the string is not one of ours, such as a
 * code from a newer build or corruption, which classification treats as
 * unrecognised.
 */
export function parseFailureCode(stored: string | null | undefined): ParsedFailureCode | null {
  if (!stored) return null;
  const text = stored.trim();
  const colon = text.indexOf(":");
  const candidate = (colon === -1 ? text : text.slice(0, colon)) as FailureCodeBase;
  if (!(FAILURE_CODES as readonly string[]).includes(candidate)) return null;
  const param = colon === -1 ? null : text.slice(colon + 1).trim();
  return { base: candidate, param: param === "" ? null : param };
}

export function failureCodeBase(stored: string | null | undefined): FailureCodeBase | null {
  return parseFailureCode(stored)?.base ?? null;
}

/** One persisted failure: the typed code plus the detail text, either nullable. */
export type StoredFailure = { code: string | null; error: string | null };

export function toStoredFailure(row: {
  failure_code?: string | null;
  error?: string | null;
}): StoredFailure {
  return { code: row.failure_code ?? null, error: row.error ?? null };
}

/**
 * The code for a throw that carries none of its own: a plain Error from a
 * parser, or anything unexpected. Known message prefixes map to their codes.
 * Anything else is UNEXPECTED, so a new failure kind shows up as a code nobody
 * maps yet instead of prose nobody notices.
 */
export function deriveCodeFromMessage(message: string): FailureCode {
  const text = message.trim();
  const http = /^HTTP (\d{3})\b/.exec(text);
  if (http) return failureCode("HTTP", http[1]);
  for (const base of FAILURE_CODES) {
    if (base === "UNEXPECTED") continue;
    if (text !== base && !text.startsWith(`${base}:`) && !text.startsWith(`${base} `)) continue;
    switch (base) {
      case "MISSING_CREDENTIAL":
      case "UNSUPPORTED_PROVIDER": {
        const provider = new RegExp(`^${base}:(\\w+)`).exec(text);
        return provider ? failureCode(base, provider[1]) : base;
      }
      case "EMPTY_ANSWER": {
        const stop = /stop_reason=(\S+)/.exec(text);
        return failureCode(base, stop?.[1] ?? "unreported");
      }
      case "WEB_SEARCH_FAILED": {
        const reason = /^WEB_SEARCH_FAILED:\s*(\S+)/.exec(text);
        return failureCode(base, reason?.[1]?.replace(/[,;]$/, "") ?? null);
      }
      default:
        return base;
    }
  }
  return "UNEXPECTED";
}
