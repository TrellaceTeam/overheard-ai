import { describe, expect, it } from "vitest";
import {
  allRowsPassed,
  classifySearchFailure,
  searchFailed,
  searchNotPerformed,
  searchOk,
} from "./setup-check";

describe("classifySearchFailure: anthropic", () => {
  it("recognises the documented org-disabled error verbatim", () => {
    const r = classifySearchFailure(
      "anthropic",
      400,
      'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"web search is not enabled"}}',
    );
    expect(r.status).toBe("search_disabled");
    expect(r.hint).toContain("Settings → Privacy");
  });

  it("recognises a credit balance that is too low", () => {
    const r = classifySearchFailure(
      "anthropic",
      400,
      "HTTP 400: Your credit balance is too low to access the Claude API",
    );
    expect(r.status).toBe("no_credits");
  });

  it("classifies auth, model, rate limit and overload", () => {
    expect(classifySearchFailure("anthropic", 401, "HTTP 401: invalid x-api-key").status).toBe(
      "invalid_key",
    );
    expect(
      classifySearchFailure(
        "anthropic",
        404,
        'HTTP 404: {"error":{"message":"model: claude-x not found"}}',
      ).status,
    ).toBe("model_unavailable");
    expect(classifySearchFailure("anthropic", 429, "HTTP 429: rate limit").status).toBe(
      "rate_limited",
    );
    expect(classifySearchFailure("anthropic", 529, "HTTP 529: overloaded").status).toBe(
      "provider_unavailable",
    );
  });
});

describe("classifySearchFailure: openai", () => {
  it("classifies credit, spend limit and plain rate limit apart", () => {
    expect(
      classifySearchFailure("openai", 429, '{"error":{"code":"credit_balance_exhausted"}}').status,
    ).toBe("no_credits");
    expect(
      classifySearchFailure("openai", 429, '{"error":{"code":"organization_spend_limit_exceeded"}}')
        .status,
    ).toBe("no_credits");
    expect(classifySearchFailure("openai", 429, '{"error":{"code":"slow_down"}}').status).toBe(
      "rate_limited",
    );
  });

  it("classifies auth, region and model", () => {
    expect(classifySearchFailure("openai", 401, "Incorrect API key provided").status).toBe(
      "invalid_key",
    );
    expect(
      classifySearchFailure("openai", 403, "Country, region, or territory not supported").status,
    ).toBe("region_unsupported");
    expect(classifySearchFailure("openai", 404, "The model `gpt-x` does not exist").status).toBe(
      "model_unavailable",
    );
  });

  it("reads a 400 naming the tool as search blocked (heuristic, to confirm)", () => {
    expect(
      classifySearchFailure("openai", 400, "web_search tool is not allowed for this project")
        .status,
    ).toBe("search_disabled");
    expect(classifySearchFailure("openai", 400, "something else entirely").status).toBe("unknown");
  });
});

describe("classifySearchFailure: google", () => {
  it("reads a billing precondition as the free tier's missing search", () => {
    const r = classifySearchFailure(
      "google",
      400,
      '{"error":{"status":"FAILED_PRECONDITION","message":"a prerequisite is not met (for example, disabled billing)"}}',
    );
    expect(r.status).toBe("billing_not_enabled");
    expect(r.hint).toContain("aistudio.google.com/projects");
  });

  it("classifies key, credits, quota and model", () => {
    expect(
      classifySearchFailure("google", 400, "API key not valid. Please pass a valid API key.")
        .status,
    ).toBe("invalid_key");
    expect(
      classifySearchFailure("google", 402, "payment_required: Prepay credit balance depleted")
        .status,
    ).toBe("no_credits");
    expect(classifySearchFailure("google", 429, "RESOURCE_EXHAUSTED: quota_exceeded").status).toBe(
      "rate_limited",
    );
    expect(classifySearchFailure("google", 404, "models/gemini-x is not found").status).toBe(
      "model_unavailable",
    );
  });

  it("names a leaked key", () => {
    const r = classifySearchFailure(
      "google",
      403,
      "PERMISSION_DENIED: Your API key was reported as leaked",
    );
    expect(r.status).toBe("invalid_key");
    expect(r.message).toContain("leaked");
  });
});

describe("the 200-shaped verdicts", () => {
  it("reports a search that did not happen and one that failed", () => {
    expect(searchNotPerformed("google").status).toBe("search_not_performed");
    expect(searchFailed("anthropic", "too_many_requests").detail).toContain("too_many_requests");
    expect(searchOk("openai").status).toBe("ok");
  });

  it("keeps the provider's text as detail, clipped", () => {
    const long = "x".repeat(900);
    expect(classifySearchFailure("anthropic", 400, long).detail?.length).toBeLessThanOrEqual(401);
  });
});

describe("allRowsPassed", () => {
  const row = (status: string) => ({ result: { status } as never });

  it("passes when every row is ok or mocked", () => {
    expect(allRowsPassed([row("ok"), row("mocked")])).toBe(true);
  });

  it("fails when any row did not pass, including ones we could not classify", () => {
    expect(allRowsPassed([row("ok"), row("no_credits")])).toBe(false);
    expect(allRowsPassed([row("unknown")])).toBe(false);
  });

  it("fails on an empty report: the gate never opens on silence", () => {
    expect(allRowsPassed([])).toBe(false);
  });
});

describe("model_unavailable hints", () => {
  it("names where to fix it for every provider", () => {
    for (const provider of ["openai", "anthropic", "google"] as const) {
      const verdict = classifySearchFailure(provider, 404, "model not found");
      expect(verdict.status).toBe("model_unavailable");
      expect(verdict.hint).toContain("Pick a different model");
    }
  });
});

describe("searchNotPerformed evidence", () => {
  it("separates a reply cut off by the token limit from one that skipped search", () => {
    const cut = searchNotPerformed("google", {
      truncated: true,
      answerSnippet: "World leaders are",
    });
    expect(cut.message).toContain("cut off");
    expect(cut.detail).toContain("World leaders are");
    expect(cut.hint).toContain("Run the check again");

    const skipped = searchNotPerformed("google");
    expect(skipped.message).toContain("without searching");
    expect(skipped.detail).toBeUndefined();
  });
});
