import { describe, expect, it } from "vitest";
import {
  deriveCodeFromMessage,
  FAILURE_CODES,
  failureCode,
  failureCodeBase,
  parseFailureCode,
  toStoredFailure,
} from "./failure-codes";

describe("failureCode / parseFailureCode", () => {
  it("stores a base alone or with one structured param", () => {
    expect(failureCode("TIMEOUT")).toBe("TIMEOUT");
    expect(failureCode("HTTP", 429)).toBe("HTTP:429");
    expect(failureCode("MISSING_CREDENTIAL", "google")).toBe("MISSING_CREDENTIAL:google");
    expect(failureCode("EMPTY_ANSWER", null)).toBe("EMPTY_ANSWER");
    expect(failureCode("EMPTY_ANSWER", "")).toBe("EMPTY_ANSWER");
  });

  it("round-trips the stored grammar", () => {
    expect(parseFailureCode("HTTP:429")).toEqual({ base: "HTTP", param: "429" });
    expect(parseFailureCode("TIMEOUT")).toEqual({ base: "TIMEOUT", param: null });
    expect(parseFailureCode("MISSING_CREDENTIAL:google")).toEqual({
      base: "MISSING_CREDENTIAL",
      param: "google",
    });
  });

  it("refuses strings that are not the vocabulary", () => {
    expect(parseFailureCode(null)).toBeNull();
    expect(parseFailureCode("")).toBeNull();
    expect(parseFailureCode("SOMETHING_NEW")).toBeNull();
    expect(parseFailureCode("HTTP 429: prose, not a code")).toBeNull();
    expect(parseFailureCode("CANCELLED_BY_USER: stopped from the run page.")).toEqual({
      base: "CANCELLED_BY_USER",
      param: "stopped from the run page.",
    });
  });

  it("reads just the base", () => {
    expect(failureCodeBase("WEB_SEARCH_FAILED:max_uses_exceeded")).toBe("WEB_SEARCH_FAILED");
    expect(failureCodeBase("nonsense")).toBeNull();
  });

  it("keeps every stored code parseable", () => {
    for (const base of FAILURE_CODES) {
      expect(parseFailureCode(base)?.base).toBe(base);
      expect(parseFailureCode(failureCode(base, "x"))).toEqual({ base, param: "x" });
    }
  });
});

describe("deriveCodeFromMessage", () => {
  it("types the historical prefixes a plain Error can still carry", () => {
    expect(deriveCodeFromMessage("SCHEMA_VIOLATION: no JSON object")).toBe("SCHEMA_VIOLATION");
    expect(deriveCodeFromMessage("MISSING_CREDENTIAL:google")).toBe("MISSING_CREDENTIAL:google");
    expect(deriveCodeFromMessage("UNSUPPORTED_PROVIDER:mystery")).toBe(
      "UNSUPPORTED_PROVIDER:mystery",
    );
    expect(deriveCodeFromMessage("EMPTY_ANSWER: stop_reason=max_tokens")).toBe(
      "EMPTY_ANSWER:max_tokens",
    );
    expect(deriveCodeFromMessage("EMPTY_ANSWER: stop_reason=pause_turn")).toBe(
      "EMPTY_ANSWER:pause_turn",
    );
    expect(deriveCodeFromMessage("WEB_SEARCH_FAILED: max_uses_exceeded")).toBe(
      "WEB_SEARCH_FAILED:max_uses_exceeded",
    );
    expect(deriveCodeFromMessage("TIMEOUT after 500ms of a 100ms budget: aborted")).toBe("TIMEOUT");
    expect(deriveCodeFromMessage("DEADLINE_EXCEEDED: no time left for this call")).toBe(
      "DEADLINE_EXCEEDED",
    );
    expect(
      deriveCodeFromMessage("NO_WEB_SEARCH: the assistant answered without searching the web"),
    ).toBe("NO_WEB_SEARCH");
    expect(
      deriveCodeFromMessage("EXTRACTION_UNREADABLE: 3 readers replied in the wrong shape"),
    ).toBe("EXTRACTION_UNREADABLE");
    // The perception reader throws a plain Error, so its code comes from here.
    expect(
      deriveCodeFromMessage("EXTRACTION_TRUNCATED: the reader stopped at the output token limit"),
    ).toBe("EXTRACTION_TRUNCATED");
  });

  it("reads the HTTP status line into the param", () => {
    expect(deriveCodeFromMessage("HTTP 429: slow down")).toBe("HTTP:429");
    expect(deriveCodeFromMessage("HTTP 520: <!DOCTYPE html>")).toBe("HTTP:520");
  });

  it("records anything unrecognised as UNEXPECTED rather than dropping it", () => {
    expect(deriveCodeFromMessage("fetch failed")).toBe("UNEXPECTED");
    expect(deriveCodeFromMessage("Cannot read properties of undefined")).toBe("UNEXPECTED");
    expect(deriveCodeFromMessage("")).toBe("UNEXPECTED");
  });

  it("never derives a code the parser would reject", () => {
    for (const message of [
      "SCHEMA_VIOLATION: x",
      "MISSING_CREDENTIAL:google",
      "EMPTY_ANSWER: stop_reason=max_tokens",
      "HTTP 429: slow down",
      "fetch failed",
    ]) {
      expect(parseFailureCode(deriveCodeFromMessage(message))).not.toBeNull();
    }
  });
});

describe("toStoredFailure", () => {
  it("defaults both fields to null", () => {
    expect(toStoredFailure({})).toEqual({ code: null, error: null });
    expect(toStoredFailure({ failure_code: "TIMEOUT", error: "TIMEOUT after 1ms" })).toEqual({
      code: "TIMEOUT",
      error: "TIMEOUT after 1ms",
    });
  });
});
