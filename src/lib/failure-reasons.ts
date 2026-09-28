/**
 * Turns a stored failure, a typed code plus its detail text, into something a
 * marketer can act on.
 *
 * The detail (`run_tasks.error`) is raw provider output. It is scrubbed of
 * key-shaped strings and clipped to 500 characters before it is written (see
 * scrubError), but it is written for us, not for a user: on a bad day it is
 * the first 500 bytes of a CDN error page. So every failure is classified into
 * whose problem it is and what, if anything, the user can do.
 *
 * A row with `run_tasks.failure_code` is classified by code (lib/failure-codes).
 * A row without one carries prose alone, and the prose parser below reads its
 * prefix. Both paths build their cards from the same functions, so a coded row
 * and a prose row of the same failure classify identically.
 *
 * The default owner is "us": an unrecognised code or text must not imply the
 * user broke something.
 */

import { keyEnvNamesSafe } from "./provider-keys";
import { parseFailureCode, type ParsedFailureCode, type StoredFailure } from "./failure-codes";

/**
 * Whose problem this is. `stopped` is not a fault: a cancelled run's tasks are
 * marked failed, so they land beside real failures, and the card must not call
 * the user's own button press something that went wrong.
 */
export type FaultOwner = "you" | "provider" | "us" | "stopped";

export type FailureReason = {
  /** Stable grouping key, so identical failures collapse into one row. */
  key: string;
  /**
   * Whose problem this is, or null when the failure wears no chip at all.
   * Only an answer that no reader on the extraction ladder could parse gets
   * null: Retry usually reads it, so no fault owner is useful.
   */
  owner: FaultOwner | null;
  title: string;
  advice: string;
  /** True when the raw text is an HTML document rather than a message. */
  isHtml: boolean;
  /** Raw text, safe to show behind a disclosure. Empty when it is HTML. */
  detail: string;
};

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

export function providerLabel(slug: string): string {
  return PROVIDER_NAMES[slug.toLowerCase()] ?? slug;
}

export const OWNER_LABEL: Record<FaultOwner, string> = {
  you: "Yours to fix",
  provider: "Provider's side",
  us: "Ours to fix",
  stopped: "You stopped it",
};

/** The grouping key a cancelled task classifies to. Not a failure. */
export const CANCELLED_KEY = "cancelled";

type Card = Pick<FailureReason, "key" | "owner" | "title" | "advice">;

function cancelledCard(): Card {
  return {
    key: CANCELLED_KEY,
    owner: "stopped",
    title: "You stopped this run",
    advice:
      "These calls were never made, so they cost nothing. Start the run again, or retry just these, whenever you are ready.",
  };
}

function missingCredentialCard(slug: string): Card {
  const provider = providerLabel(slug);
  return {
    key: `missing-credential:${slug}`,
    owner: "you",
    title: `No ${provider} API key configured`,
    advice: `Add ${keyEnvNamesSafe(slug.toLowerCase()) ?? `your ${provider} key`} to the .env file in the app's folder, then run again. There is no need to restart. The template, .env.example, lists every variable name.`,
  };
}

function noExtractionCredentialCard(): Card {
  return {
    key: "no-extraction-credential",
    owner: "you",
    title: "No key for the model that reads answers",
    advice:
      "The extractor turns each answer into scores. Add a key for its provider to your .env file, or pick an extractor you have a key for.",
  };
}

function emptyAnswerCard(cutOff: boolean): Card {
  return cutOff
    ? {
        key: "empty-answer-max-tokens",
        owner: "provider",
        title: "The assistant ran out of room mid-answer",
        advice:
          "It hit its length limit before saying anything usable. Usually a one-off, and shorter prompts make it rarer.",
      }
    : {
        key: "empty-answer",
        owner: "provider",
        title: "The assistant returned nothing",
        advice: "It replied with no text at all. Usually a one-off, so try the run again.",
      };
}

function timeoutCard(): Card {
  return {
    key: "timeout",
    owner: "provider",
    title: "The assistant took too long to answer",
    advice:
      "Answers that search the web are slow, and this one passed our time limit. The retry had more time and still did not finish. This is not a key or billing problem.",
  };
}

function noAnswerToExtractCard(): Card {
  return {
    key: "no-answer-to-extract",
    owner: "us",
    title: "We had no answer to score",
    advice: "That is a fault on our side, not yours.",
  };
}

function webSearchFailedCard(): Card {
  return {
    key: "web-search-failed",
    owner: "provider",
    title: "The assistant could not search the web",
    advice:
      "Its search step failed. An answer written without a search measures the model's training data, not the live web, so we threw it away instead of scoring it. Run the failed calls again later. If it keeps happening, check that web search is allowed for your account in the provider's console.",
  };
}

function noWebSearchCard(): Card {
  return {
    key: "no-web-search",
    owner: "provider",
    title: "The assistant answered without searching the web",
    advice:
      "The assistant answered from memory instead of searching, so the answer reflects its training data, not the live web, and we did not score it. It happens most on simple or generic questions a model thinks it can answer alone. Retrying asks again with the search forced, which often works. More specific questions help too, because a model cannot answer those from memory. If it keeps happening on one assistant, check that web search is allowed for your account in the provider's console.",
  };
}

function unreadableCard(): Card {
  // The extraction ladder exhausted: the project's extractor, the same
  // provider's next tier up and the cheapest keyed extractor all replied in
  // the wrong shape (worker/extraction-ladder). No chip, and a test pins the
  // copy word for word.
  return {
    key: "unreadable-answer",
    owner: null,
    title: "We could not read this answer",
    advice:
      "The model that reads answers replied in a slightly different format than we asked for. It happens occasionally. Retry reads those answers again.",
  };
}

function truncatedCard(): Card {
  // Every reader tried spent its whole output allowance, reasoning included,
  // before the JSON was finished. The reply was never parsed.
  return {
    key: "extraction-truncated",
    owner: null,
    title: "The model that reads answers ran out of room",
    advice:
      "It reached its length limit before it finished reading the answer, so nothing could be scored. It is rare and usually happens on very long answers. Retry reads those answers again.",
  };
}

function schemaViolationCard(): Card {
  return {
    key: "schema-violation",
    owner: "us",
    title: "The model that reads answers replied in a shape we could not use",
    advice:
      "The assistant answered, but the extractor's reply was not the JSON we asked it for, so nothing could be scored from it. Retrying usually works. A cheaper extractor gets this wrong more often, so a mid-tier one in project settings is the fix if it keeps happening.",
  };
}

function authCard(status: number): Card {
  return {
    key: `auth-${status}`,
    owner: "you",
    title: "The provider rejected your API key",
    advice:
      "The key is present but the provider refused it. Check it is still valid and has billing enabled, then update it in your .env file and run again.",
  };
}

function rateLimitedCard(): Card {
  return {
    key: "rate-limited",
    owner: "provider",
    title: "The provider rate-limited this call",
    advice:
      "Too many requests in a short window on their side. Not a billing problem and not your fault. Try again later, or lower this provider's calls in flight in Account settings.",
  };
}

function providerDownCard(): Card {
  return {
    key: "provider-down",
    owner: "provider",
    title: "The provider was having a bad day",
    advice:
      "Their service failed on this call. We already retried it. Running again later usually works.",
  };
}

function badRequestCard(status: number): Card {
  return {
    key: `bad-request-${status}`,
    owner: "us",
    title: "We sent this call in a shape the provider refused",
    advice: "That is ours to fix, not yours.",
  };
}

function noRecordedReasonCard(): Card {
  return {
    key: "unknown",
    owner: "us",
    title: "This call failed without saying why",
    advice:
      "Nothing was recorded against it, so there is nothing to read. Running the failed calls again is the only way to learn more.",
  };
}

function defaultCard(): Card {
  return {
    key: "unknown",
    owner: "us",
    title: "We could not classify this failure",
    advice: "The technical detail below shows what the provider sent back.",
  };
}

function looksLikeHtml(text: string): boolean {
  return /<!DOCTYPE html|<html[\s>]/i.test(text);
}

function httpStatus(text: string): number | null {
  const match = /^HTTP (\d{3})\b/.exec(text.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function statusCard(status: number): Card | null {
  if (status === 401 || status === 403) return authCard(status);
  if (status === 429) return rateLimitedCard();
  if (status >= 500) return providerDownCard();
  if (status >= 400) return badRequestCard(status);
  return null;
}

/**
 * The card for a typed code, or null when the code has no card of its own and
 * the failure gets the default ("ours") card.
 */
function classifyCode(parsed: ParsedFailureCode): Card | null {
  switch (parsed.base) {
    case "CANCELLED_BY_USER":
      return cancelledCard();
    case "MISSING_CREDENTIAL":
      return parsed.param ? missingCredentialCard(parsed.param) : null;
    case "NO_EXTRACTION_CREDENTIAL":
      return noExtractionCredentialCard();
    case "EMPTY_ANSWER":
      return emptyAnswerCard(parsed.param === "max_tokens");
    case "TIMEOUT":
    case "DEADLINE_EXCEEDED":
      return timeoutCard();
    case "NO_ANSWER_TO_EXTRACT":
      return noAnswerToExtractCard();
    case "WEB_SEARCH_FAILED":
      return webSearchFailedCard();
    case "NO_WEB_SEARCH":
      return noWebSearchCard();
    case "EXTRACTION_UNREADABLE":
      return unreadableCard();
    case "EXTRACTION_TRUNCATED":
      return truncatedCard();
    case "SCHEMA_VIOLATION":
      return schemaViolationCard();
    case "HTTP": {
      const status = parsed.param === null ? NaN : Number(parsed.param);
      return Number.isInteger(status) ? statusCard(status) : null;
    }
    // Recorded and grouped like any other failure, but none of these has
    // user-facing copy of its own, so they wear the default card.
    case "MAX_ATTEMPTS_EXCEEDED":
    case "UNSUPPORTED_PROVIDER":
    case "PROMPT_MISSING":
    case "SCHEMA_WITH_SEARCH":
    case "NETWORK":
    case "UNEXPECTED":
      return null;
  }
}

/**
 * The fallback for rows with no failure code, which carry prose alone. It
 * matches the prefixes those rows hold in run_tasks.error. The list is closed:
 * a new failure kind gets a code where it is recorded, not a prefix here.
 */
function classifyProse(text: string): Card | null {
  if (!text) return noRecordedReasonCard();

  if (text.startsWith("CANCELLED_BY_USER") || text === "Cancelled by user") {
    return cancelledCard();
  }

  const missingKey = /^MISSING_CREDENTIAL:(\w+)/.exec(text);
  if (missingKey?.[1]) return missingCredentialCard(missingKey[1]);

  if (text.startsWith("NO_EXTRACTION_CREDENTIAL")) return noExtractionCredentialCard();

  if (text.startsWith("EMPTY_ANSWER")) {
    return emptyAnswerCard(text.includes("stop_reason=max_tokens"));
  }

  if (
    text.startsWith("TIMEOUT") ||
    text.startsWith("DEADLINE_EXCEEDED") ||
    /operation was aborted/i.test(text)
  ) {
    return timeoutCard();
  }

  if (text.startsWith("NO_ANSWER_TO_EXTRACT")) return noAnswerToExtractCard();

  if (text.startsWith("WEB_SEARCH_FAILED")) return webSearchFailedCard();

  if (text.startsWith("NO_WEB_SEARCH")) return noWebSearchCard();

  if (text.startsWith("EXTRACTION_UNREADABLE")) return unreadableCard();

  if (text.startsWith("SCHEMA_VIOLATION")) return schemaViolationCard();

  const status = httpStatus(text);
  if (status !== null) {
    const card = statusCard(status);
    if (card) return card;
  }

  return null;
}

export function classifyFailure(failure: StoredFailure): FailureReason {
  const text = (failure.error ?? "").trim();
  const isHtml = looksLikeHtml(text);
  const detail = isHtml ? "" : text;
  const base = { isHtml, detail };

  const hasCode = failure.code !== null && failure.code !== undefined && failure.code.trim() !== "";
  if (hasCode) {
    const parsed = parseFailureCode(failure.code);
    // A code this build cannot parse comes from a build that knows more:
    // default to "ours", never to the prose in the detail.
    if (!parsed) return { ...base, ...defaultCard() };
    return { ...base, ...(classifyCode(parsed) ?? defaultCard()) };
  }

  return { ...base, ...(classifyProse(text) ?? defaultCard()) };
}

export type FailureGroup = FailureReason & { count: number };

/** Collapse a list of stored failures into groups, most common first. */
export function groupFailures(failures: readonly StoredFailure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const failure of failures) {
    const reason = classifyFailure(failure);
    const existing = groups.get(reason.key);
    if (existing) existing.count += 1;
    else groups.set(reason.key, { ...reason, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** One-line summary of why a run came back partial. */
export function dominantFailure(failures: readonly StoredFailure[]): FailureGroup | null {
  return groupFailures(failures)[0] ?? null;
}
