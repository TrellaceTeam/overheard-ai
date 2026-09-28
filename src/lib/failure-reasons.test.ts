import { describe, expect, it } from "vitest";
import {
  CANCELLED_KEY,
  classifyFailure,
  dominantFailure,
  groupFailures,
  providerLabel,
} from "./failure-reasons";
import { FAILURE_CODES, failureCode, type StoredFailure } from "./failure-codes";

// The literal src/server/logic/cancel-run.ts writes. Browser code does not
// import from src/server, so the two are tied together by a test on the
// server side instead: see cancel-run.test.ts.
const CANCEL_ERROR = "CANCELLED_BY_USER: stopped from the run page.";

/** A row with no failure code, which carries prose alone. */
function legacy(error: string | null): StoredFailure {
  return { code: null, error };
}

describe("classifyFailure, legacy prose rows", () => {
  it("names the provider on a missing key and puts it on the user", () => {
    const reason = classifyFailure(legacy("MISSING_CREDENTIAL:anthropic"));
    expect(reason.owner).toBe("you");
    expect(reason.title).toContain("Anthropic");
    expect(reason.key).toBe("missing-credential:anthropic");
  });

  it("treats both spellings of the abort as a provider timeout", () => {
    for (const text of [
      "The operation was aborted",
      "This operation was aborted",
      "TIMEOUT after 120004ms of a 120000ms budget: aborted",
      "DEADLINE_EXCEEDED: no time left for this call",
    ]) {
      expect(classifyFailure(legacy(text)).owner).toBe("provider");
      expect(classifyFailure(legacy(text)).key).toBe("timeout");
    }
  });

  it("separates a cut-off answer from an empty one", () => {
    expect(classifyFailure(legacy("EMPTY_ANSWER: stop_reason=max_tokens")).key).toBe(
      "empty-answer-max-tokens",
    );
    expect(classifyFailure(legacy("EMPTY_ANSWER")).key).toBe("empty-answer");
  });

  it("maps HTTP statuses to the right owner", () => {
    expect(classifyFailure(legacy("HTTP 401: bad key")).owner).toBe("you");
    expect(classifyFailure(legacy("HTTP 429: slow down")).owner).toBe("provider");
    expect(classifyFailure(legacy("HTTP 520: gateway")).owner).toBe("provider");
    expect(classifyFailure(legacy("HTTP 400: bad payload")).owner).toBe("us");
  });

  it("points a rate limit at the provider's calls in flight in Account settings", () => {
    const reason = classifyFailure(legacy("HTTP 429: slow down"));
    expect(reason.key).toBe("rate-limited");
    expect(reason.advice).toBe(
      "Too many requests in a short window on their side. Not a billing problem and not your fault. Try again later, or lower this provider's calls in flight in Account settings.",
    );
  });

  it("never shows an HTML error page as text", () => {
    const reason = classifyFailure(
      legacy('HTTP 520: <!DOCTYPE html>\n<html class="x">boom</html>'),
    );
    expect(reason.isHtml).toBe(true);
    expect(reason.detail).toBe("");
    expect(reason.owner).toBe("provider");
  });

  it("falls back to ours, never to the user", () => {
    expect(classifyFailure(legacy("something nobody predicted")).owner).toBe("us");
    expect(classifyFailure(legacy(null)).owner).toBe("us");
    expect(classifyFailure(legacy("")).key).toBe("unknown");
  });

  it("reads a deliberate stop as a stop rather than as a fault", () => {
    // Pressing Cancel is the most likely thing a first-time user does when the
    // spend line starts climbing, and it must not read as the product being
    // broken.
    const reason = classifyFailure(legacy(CANCEL_ERROR));
    expect(reason.key).toBe(CANCELLED_KEY);
    expect(reason.owner).toBe("stopped");
    expect(reason.title).toBe("You stopped this run");
    expect(reason.advice).toContain("cost nothing");
  });

  it("still reads the pre-code cancel text in an older database", () => {
    expect(classifyFailure(legacy("Cancelled by user")).key).toBe(CANCELLED_KEY);
  });

  it("explains a failed web search as thrown-away data, not a broken app", () => {
    const reason = classifyFailure(legacy("WEB_SEARCH_FAILED: max_uses_exceeded"));
    expect(reason.key).toBe("web-search-failed");
    expect(reason.owner).toBe("provider");
    // Search cannot be switched off, so the advice must not suggest it.
    expect(reason.advice).not.toContain("web search off");
  });

  it("explains an answer written without any search", () => {
    const reason = classifyFailure(
      legacy("NO_WEB_SEARCH: the assistant answered without searching the web"),
    );
    expect(reason.key).toBe("no-web-search");
    expect(reason.owner).toBe("provider");
    expect(reason.advice).toContain("we did not score it");
    expect(reason.advice).not.toContain("web search off");
  });

  it("puts an unreadable extractor reply on us and points at the extractor", () => {
    for (const text of ["SCHEMA_VIOLATION: no JSON object", "SCHEMA_VIOLATION: answer_format"]) {
      const reason = classifyFailure(legacy(text));
      expect(reason.key).toBe("schema-violation");
      expect(reason.owner).toBe("us");
      expect(reason.advice).toContain("extractor");
    }
  });

  it("gives an exhausted ladder no fault owner, and the exact settled copy", () => {
    // The card a user sees only after the extractor, the same provider's next
    // tier and the cheapest keyed extractor all replied in the wrong shape.
    // The copy is pinned word for word, and the card wears no chip.
    const reason = classifyFailure(
      legacy(
        "EXTRACTION_UNREADABLE: 3 readers replied in the wrong shape (last: SCHEMA_VIOLATION: answer_format)",
      ),
    );
    expect(reason.key).toBe("unreadable-answer");
    expect(reason.owner).toBeNull();
    expect(reason.title).toBe("We could not read this answer");
    expect(reason.advice).toBe(
      "The model that reads answers replied in a slightly different format than we asked for. It happens occasionally. Retry reads those answers again.",
    );
  });

  it("tells a reader that ran out of room apart from one that replied in the wrong shape", () => {
    const reason = classifyFailure({
      code: "EXTRACTION_TRUNCATED",
      error: "EXTRACTION_TRUNCATED: 2 readers stopped at the output token limit before finishing",
    });
    expect(reason.key).toBe("extraction-truncated");
    expect(reason.owner).toBeNull();
    expect(reason.title).toBe("The model that reads answers ran out of room");
    expect(reason.advice).not.toMatch(/format/);
  });

  it("asks nobody to report anything, since there is nobody to report to", () => {
    // This tool has no account, no support desk and no telemetry, so no copy
    // may ask a local user to "tell us".
    for (const text of ["", "something nobody predicted", "TIMEOUT: gone"]) {
      const reason = classifyFailure(legacy(text));
      expect(reason.advice).not.toMatch(/tell us/i);
      expect(reason.advice).not.toMatch(/your account/i);
    }
  });

  it("labels known provider slugs and passes unknown ones through", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("mystery")).toBe("mystery");
  });
});

describe("classifyFailure, coded rows", () => {
  /**
   * The identity table: for every failure kind, the coded row and the prose
   * row of the same failure must classify to the same card, so a user sees the
   * same thing whether or not a row carries a code.
   */
  const identities: Array<[StoredFailure, string]> = [
    [{ code: "CANCELLED_BY_USER", error: CANCEL_ERROR }, CANCEL_ERROR],
    [
      {
        code: failureCode("MISSING_CREDENTIAL", "anthropic"),
        error: "MISSING_CREDENTIAL:anthropic",
      },
      "MISSING_CREDENTIAL:anthropic",
    ],
    [
      { code: "NO_EXTRACTION_CREDENTIAL", error: "NO_EXTRACTION_CREDENTIAL" },
      "NO_EXTRACTION_CREDENTIAL",
    ],
    [
      {
        code: failureCode("EMPTY_ANSWER", "max_tokens"),
        error: "EMPTY_ANSWER: stop_reason=max_tokens",
      },
      "EMPTY_ANSWER: stop_reason=max_tokens",
    ],
    [
      {
        code: failureCode("EMPTY_ANSWER", "pause_turn"),
        error: "EMPTY_ANSWER: stop_reason=pause_turn",
      },
      "EMPTY_ANSWER: stop_reason=pause_turn",
    ],
    [
      { code: "TIMEOUT", error: "TIMEOUT after 120004ms of a 120000ms budget: aborted" },
      "TIMEOUT after 120004ms",
    ],
    [
      { code: "DEADLINE_EXCEEDED", error: "DEADLINE_EXCEEDED: no time left for this call" },
      "DEADLINE_EXCEEDED: no time left",
    ],
    [{ code: "NO_ANSWER_TO_EXTRACT", error: "NO_ANSWER_TO_EXTRACT" }, "NO_ANSWER_TO_EXTRACT"],
    [
      {
        code: failureCode("WEB_SEARCH_FAILED", "max_uses_exceeded"),
        error: "WEB_SEARCH_FAILED: max_uses_exceeded",
      },
      "WEB_SEARCH_FAILED: max_uses_exceeded",
    ],
    [
      {
        code: "NO_WEB_SEARCH",
        error: "NO_WEB_SEARCH: the assistant answered without searching the web",
      },
      "NO_WEB_SEARCH: the assistant",
    ],
    [
      {
        code: "EXTRACTION_UNREADABLE",
        error: "EXTRACTION_UNREADABLE: 3 readers replied in the wrong shape",
      },
      "EXTRACTION_UNREADABLE: 3 readers",
    ],
    [
      { code: "SCHEMA_VIOLATION", error: "SCHEMA_VIOLATION: no JSON object" },
      "SCHEMA_VIOLATION: no JSON object",
    ],
    [{ code: failureCode("HTTP", 401), error: "HTTP 401: bad key" }, "HTTP 401: bad key"],
    [{ code: failureCode("HTTP", 429), error: "HTTP 429: slow down" }, "HTTP 429: slow down"],
    [{ code: failureCode("HTTP", 520), error: "HTTP 520: gateway" }, "HTTP 520: gateway"],
    [{ code: failureCode("HTTP", 400), error: "HTTP 400: bad payload" }, "HTTP 400: bad payload"],
  ];

  it("classifies a coded row exactly like the legacy prose row", () => {
    for (const [coded, prose] of identities) {
      const label = `${coded.code} vs ${prose}`;
      const a = classifyFailure(coded);
      const b = classifyFailure(legacy(prose));
      expect({ key: a.key, owner: a.owner, title: a.title, advice: a.advice }, label).toEqual({
        key: b.key,
        owner: b.owner,
        title: b.title,
        advice: b.advice,
      });
    }
  });

  it("keeps the HTML rule and the detail rule on coded rows", () => {
    const reason = classifyFailure({
      code: failureCode("HTTP", 520),
      error: '<!DOCTYPE html>\n<html class="x">boom</html>',
    });
    expect(reason.isHtml).toBe(true);
    expect(reason.detail).toBe("");
    expect(reason.owner).toBe("provider");

    const plain = classifyFailure({ code: failureCode("HTTP", 429), error: "HTTP 429: slow down" });
    expect(plain.isHtml).toBe(false);
    expect(plain.detail).toBe("HTTP 429: slow down");
  });

  it("defaults to ours for a code it does not know, without reading the prose", () => {
    // A code from a newer build: this one must not imply the user broke
    // something, and must not fall back to parsing a detail that may describe
    // a different failure kind than the code says.
    const reason = classifyFailure({
      code: "SOMETHING_NEW:with-a-param",
      error: "HTTP 401: bad key",
    });
    expect(reason.owner).toBe("us");
    expect(reason.key).toBe("unknown");
    expect(reason.title).toBe("We could not classify this failure");
  });

  it("defaults to ours for a param-shaped code with a missing or invalid param", () => {
    expect(classifyFailure({ code: "MISSING_CREDENTIAL", error: null }).owner).toBe("us");
    expect(classifyFailure({ code: "HTTP", error: null }).owner).toBe("us");
    expect(classifyFailure({ code: "HTTP:not-a-status", error: null }).owner).toBe("us");
  });

  it("classifies every code in the vocabulary, and only the deliberate six land on the default card", () => {
    // No failure kind slips through unclassified: the types stop a code
    // outside the vocabulary from being written, and every code in the
    // vocabulary has an explicit home here. The six on the default card have
    // no user-facing copy of their own.
    const deliberateDefaults = new Set([
      "MAX_ATTEMPTS_EXCEEDED",
      "UNSUPPORTED_PROVIDER",
      "PROMPT_MISSING",
      "SCHEMA_WITH_SEARCH",
      "NETWORK",
      "UNEXPECTED",
    ]);
    for (const base of FAILURE_CODES) {
      const reason = classifyFailure({ code: base, error: `${base}: detail` });
      const isDefault =
        reason.key === "unknown" && reason.title === "We could not classify this failure";
      if (deliberateDefaults.has(base)) {
        expect(isDefault, base).toBe(true);
      } else if (base === "MISSING_CREDENTIAL" || base === "HTTP") {
        // Param-bearing: the bare base defaults, the param form does not.
        expect(isDefault, base).toBe(true);
      } else {
        expect(isDefault, base).toBe(false);
      }
    }
    // Only credential problems are ever the user's.
    expect(
      classifyFailure({ code: failureCode("MISSING_CREDENTIAL", "openai"), error: null }).owner,
    ).toBe("you");
    expect(classifyFailure({ code: failureCode("HTTP", 401), error: null }).owner).toBe("you");
  });

  it("classifies a coded row with an empty detail like the coded row", () => {
    const reason = classifyFailure({ code: "NO_WEB_SEARCH", error: null });
    expect(reason.key).toBe("no-web-search");
    expect(reason.detail).toBe("");
    expect(reason.isHtml).toBe(false);
  });
});

describe("groupFailures", () => {
  const rows: StoredFailure[] = [
    { code: null, error: "MISSING_CREDENTIAL:anthropic" },
    { code: failureCode("MISSING_CREDENTIAL", "anthropic"), error: "MISSING_CREDENTIAL:anthropic" },
    { code: null, error: "The operation was aborted" },
    { code: failureCode("MISSING_CREDENTIAL", "openai"), error: "MISSING_CREDENTIAL:openai" },
  ];

  it("collapses identical reasons across coded and legacy rows, and orders by count", () => {
    const groups = groupFailures(rows);
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["missing-credential:anthropic", 2],
      ["timeout", 1],
      ["missing-credential:openai", 1],
    ]);
  });

  it("reports the dominant reason, or null when there are none", () => {
    expect(dominantFailure(rows)?.key).toBe("missing-credential:anthropic");
    expect(dominantFailure([])).toBeNull();
  });
});
