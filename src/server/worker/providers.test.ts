import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SHAPE } from "./extraction";
import {
  anthropicAcceptsForcedTools,
  applyLowEffort,
  callExtractionModel,
  callProvider,
  canForceSearch,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_PROBE_MAX_TOKENS,
  extractorCheck,
  MAX_CALL_TIMEOUT_MS,
  RAISED_TIMEOUT_MS,
  scrubError,
  searchCheck,
  searchCheckModelId,
  TIMEOUT_MS,
  timeoutForRetry,
  webSearchFailure,
  withCitations,
  withGroundingCitations,
} from "./providers";
import { standInCommand } from "./cli-test-support";

// Fixture brands are fictional. Keep them that way: no real company, domain or
// customer name in test data.

/**
 * The response_format an enforced OpenAI call must carry. Asserted at both
 * places that send it, the adapter and the setup probe, so they cannot drift.
 */
const STRICT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: EXTRACTION_SHAPE.name,
    schema: EXTRACTION_JSON_SCHEMA,
    strict: true,
  },
};

beforeEach(() => {
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

describe("applyLowEffort", () => {
  it("uses output_config for Anthropic", () => {
    expect(applyLowEffort("anthropic", { model: "claude-sonnet-5" })).toEqual({
      model: "claude-sonnet-5",
      output_config: { effort: "low" },
    });
  });

  it("keeps a structured-output format already in Anthropic's output_config", () => {
    const format = { type: "json_schema", schema: { type: "object" } };
    expect(
      applyLowEffort("anthropic", { model: "claude-opus-5-5", output_config: { format } }),
    ).toEqual({ model: "claude-opus-5-5", output_config: { format, effort: "low" } });
  });

  it("nests it for the OpenAI Responses API, which is the shape with `input`", () => {
    expect(applyLowEffort("openai", { model: "gpt-5.6-terra", input: "hi" })).toEqual({
      model: "gpt-5.6-terra",
      input: "hi",
      reasoning: { effort: "low" },
    });
  });

  it("flattens it for OpenAI chat completions, which has `messages` instead", () => {
    expect(applyLowEffort("openai", { model: "gpt-5.6-terra", messages: [] })).toEqual({
      model: "gpt-5.6-terra",
      messages: [],
      reasoning_effort: "low",
    });
  });

  it("keeps the rest of Google's generationConfig instead of replacing it", () => {
    // A shallow spread would drop maxOutputTokens, and Gemini answers would
    // lose their token cap.
    const body = {
      contents: [],
      generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" },
    };
    expect(applyLowEffort("google", body)).toEqual({
      contents: [],
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "low" },
      },
    });
  });

  it("builds Google's generationConfig when the request has none", () => {
    expect(applyLowEffort("google", { contents: [] })).toEqual({
      contents: [],
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  it("never mutates the caller's body, since the fallback re-sends the original", () => {
    const body = { model: "claude-sonnet-5", generationConfig: { maxOutputTokens: 8192 } };
    const before = structuredClone(body);
    applyLowEffort("anthropic", body);
    applyLowEffort("google", body);
    expect(body).toEqual(before);
  });
});

describe("webSearchFailure", () => {
  const results = {
    type: "web_search_tool_result",
    content: [{ type: "web_search_result", title: "a" }],
  };

  it("says nothing when the search returned results", () => {
    expect(webSearchFailure([{ type: "text", text: "hi" }, results])).toBeUndefined();
  });

  it("finds the error code when content is an object instead of a list", () => {
    // Both shapes arrive as HTTP 200, so only the shape tells a searched answer
    // from one written without searching.
    expect(
      webSearchFailure([
        { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
        { type: "text", text: "I could not search, so from memory..." },
      ]),
    ).toBe("max_uses_exceeded");
  });

  it("keeps the answer when one search worked and another was refused", () => {
    // max_uses_exceeded fires whenever the model wants more searches than
    // MAX_SEARCHES allows, which is often. An answer grounded in one real
    // search is still a measurement.
    expect(
      webSearchFailure([
        results,
        { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
      ]),
    ).toBeUndefined();
  });

  it("treats a search that matched nothing as a search that ran", () => {
    // A search with no matches returns an empty list, not an error. Finding
    // nothing is a real observation, not a failure to look.
    expect(webSearchFailure([{ type: "web_search_tool_result", content: [] }])).toBeUndefined();
  });

  it("reports the first code when every search failed", () => {
    expect(
      webSearchFailure([
        { type: "web_search_tool_result", content: { error_code: "too_many_requests" } },
        { type: "web_search_tool_result", content: { error_code: "unavailable" } },
      ]),
    ).toBe("too_many_requests");
  });

  it("ignores blocks that are not search results", () => {
    expect(webSearchFailure([{ type: "thinking" }, { type: "text", text: "x" }])).toBeUndefined();
  });

  it("survives the shapes a provider might actually send", () => {
    expect(webSearchFailure(undefined)).toBeUndefined();
    expect(webSearchFailure([])).toBeUndefined();
    expect(webSearchFailure([{ type: "web_search_tool_result" }])).toBeUndefined();
    expect(webSearchFailure([{ type: "web_search_tool_result", content: null }])).toBeUndefined();
    // An error object with no code must not be reported as the string
    // "undefined".
    expect(webSearchFailure([{ type: "web_search_tool_result", content: {} }])).toBeUndefined();
  });
});

describe("withCitations", () => {
  it("puts the source in the text, since that is the only place extraction looks", () => {
    expect(
      withCitations("Acme Analytics is a strong option", [
        { type: "web_search_result_location", url: "https://acme-analytics.example.com" },
      ]),
    ).toBe("Acme Analytics is a strong option [https://acme-analytics.example.com]");
  });

  it("leaves text alone when the block cites nothing", () => {
    expect(withCitations("plain sentence", undefined)).toBe("plain sentence");
    expect(withCitations("plain sentence", [])).toBe("plain sentence");
  });

  it("does not repeat a source cited twice in one block", () => {
    expect(
      withCitations("x", [
        { url: "https://a.example.com" },
        { url: "https://a.example.com" },
        { url: "https://b.example.com" },
      ]),
    ).toBe("x [https://a.example.com, https://b.example.com]");
  });

  it("skips citations that carry no url", () => {
    expect(withCitations("x", [{ type: "web_search_result_location" }])).toBe("x");
  });

  it("goes before the block's trailing whitespace, which is the gap to the next block", () => {
    // Blocks are concatenated, so trailing whitespace is the only separator
    // and has to stay on the right of the bracket.
    const cite = [{ url: "https://a" }];
    expect(withCitations("ends in a word", cite)).toBe("ends in a word [https://a]");
    expect(withCitations("ends in a space ", cite)).toBe("ends in a space [https://a] ");
    expect(withCitations("ends a paragraph\n\n", cite)).toBe("ends a paragraph [https://a]\n\n");
    // Only the trailing run moves: whitespace inside the block stays put.
    expect(withCitations("a b  ", cite)).toBe("a b [https://a]  ");
    // Degenerate blocks have nothing to anchor to, so the suffix is all there is.
    expect(withCitations("", cite)).toBe(" [https://a]");
    expect(withCitations("  ", cite)).toBe(" [https://a]  ");
  });
});

describe("scrubError", () => {
  it("masks an OpenAI key under the generic prefix", () => {
    expect(scrubError("HTTP 401: bad key sk-abcdefgh12345678 rejected")).toBe(
      "HTTP 401: bad key sk-*** rejected",
    );
  });

  it("masks an Anthropic key under its own prefix, not the generic one", () => {
    // The generic `sk-` pattern would also match, so the Anthropic pattern has
    // to run first.
    expect(scrubError("x-api-key sk-ant-abcdefgh12345678")).toBe("x-api-key sk-ant-***");
  });

  it("masks a Google key", () => {
    expect(scrubError("key AIzaabcdefgh12345678 refused")).toBe("key AIza*** refused");
  });

  it("clips at 500 characters, which is what bounds a stored error", () => {
    expect(scrubError("x".repeat(900))).toHaveLength(500);
  });

  it("removes a configured key whatever shape it is in", () => {
    // A key pasted from a web page can carry a zero-width space. Node refuses
    // the header and echoes the whole value back, and only six characters
    // follow the AIza prefix before the invisible one, under the eight the
    // pattern needs.
    const key = "AIzaSyAb12\u200bCd34EfGh56IjKl78MnOp90QrSt";
    const message = `Headers.append: "${key}" is an invalid header value.`;

    expect(scrubError(message, [])).toContain(key);
    expect(scrubError(message, [key])).toBe('Headers.append: "***" is an invalid header value.');
  });

  it("removes a configured key that the patterns would only half mask", () => {
    const key = "sk-ant-api03-Ab12 Cd34EfGh56IjKl78MnOp90QrSt-AA";
    expect(scrubError(`refused ${key}`, [])).toContain("Cd34EfGh56IjKl78MnOp90QrSt");
    expect(scrubError(`refused ${key}`, [key])).toBe("refused ***");
  });

  it("reads the configured keys from the environment when none are passed", () => {
    process.env["OPENAI_API_KEY"] = "not-a-recognised-shape-at-all-12345";
    try {
      expect(scrubError("rejected not-a-recognised-shape-at-all-12345")).toBe("rejected ***");
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });
});

describe("assembling an Anthropic answer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One turn, no search-result blocks, so the resume loop reads it and stops. */
  function answer(content: unknown) {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ content, stop_reason: "end_turn", usage: {} }), {
          headers: { "content-type": "application/json" },
        }),
    );
    return callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
  }

  it("does not break the line where the model paused to cite a source", async () => {
    // Anthropic splits one sentence into consecutive text blocks at each
    // citation. Joined on newlines, it would read as three lines with the full
    // stop on its own.
    const res = await answer([
      { type: "text", text: "**Acme Analytics** - Another emerging option, since " },
      {
        type: "text",
        text: "startups need flexible solutions",
        citations: [{ url: "https://example.com/acme-analytics" }],
      },
      { type: "text", text: "." },
    ]);
    expect(res.text).toBe(
      "**Acme Analytics** - Another emerging option, since startups need flexible solutions [https://example.com/acme-analytics].",
    );
  });

  it("keeps the paragraph breaks the model itself wrote", async () => {
    // Blocks carry their own newlines, so concatenating cannot flatten prose.
    const res = await answer([
      { type: "text", text: "First paragraph.\n\nSecond " },
      { type: "text", text: "paragraph." },
    ]);
    expect(res.text).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("keeps exactly one space between a cited block and the one after it", async () => {
    // The cited block ends in a space here, so a citation placed after it
    // would glue "[url]" to the next word.
    const res = await answer([
      { type: "text", text: "Acme Analytics suits startups ", citations: [{ url: "https://a" }] },
      { type: "text", text: "and Northwind Metrics suits teams." },
    ]);
    expect(res.text).toBe(
      "Acme Analytics suits startups [https://a] and Northwind Metrics suits teams.",
    );
  });

  it("leaves the next markdown list item at column 0 after a cited line", async () => {
    // A citation placed after the block's newline indents the following item
    // and stops it rendering as a list.
    const res = await answer([
      {
        type: "text",
        text: "- Acme Analytics suits startups\n",
        citations: [{ url: "https://a" }],
      },
      { type: "text", text: "- Northwind Metrics suits teams\n" },
    ]);
    expect(res.text).toBe(
      "- Acme Analytics suits startups [https://a]\n- Northwind Metrics suits teams\n",
    );
    expect(res.text.split("\n")[1]).toBe("- Northwind Metrics suits teams");
  });

  it("does not repeat a source the model wrote inline itself", async () => {
    // The answer prompt asks for source URLs, so a block can carry the same URL
    // in its text and as a citation.
    const res = await answer([
      {
        type: "text",
        text: "Acme Analytics is simple (https://crm.example.com/review).",
        citations: [{ type: "web_search_result_location", url: "https://crm.example.com/review" }],
      },
    ]);
    expect(res.text).toBe("Acme Analytics is simple (https://crm.example.com/review).");
  });

  it("fails the call when not one search succeeded", async () => {
    // max_uses_exceeded will not change on a retry, and an answer written
    // without search is not the measurement.
    await expect(
      answer([
        { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
        { type: "text", text: "From memory, then." },
      ]),
    ).rejects.toThrow(/WEB_SEARCH_FAILED: max_uses_exceeded/);
  });

  it("puts the response's real usage on the failed-search error", async () => {
    // The failed searches were billed, and the pass logs the real spend from
    // the usage on the error.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "web_search_tool_result", content: { error_code: "too_many_requests" } },
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 1234,
              output_tokens: 56,
              server_tool_use: { web_search_requests: 1 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const promise = callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("WEB_SEARCH_FAILED: too_many_requests"),
      usage: { inputTokens: 1234, outputTokens: 56, searchCalls: 1 },
    });
  });

  it("counts a search that ran even when usage does not report it", async () => {
    const res = await answer([
      { type: "server_tool_use", name: "web_search" },
      { type: "web_search_tool_result", content: [{ type: "web_search_result" }] },
      { type: "text", text: "Acme Analytics." },
    ]);
    expect(res.searchCalls).toBe(1);
  });

  it("reports no search when the model answered without one", async () => {
    const res = await answer([{ type: "text", text: "From memory." }]);
    expect(res.searchCalls).toBe(0);
  });
});

describe("forcing the Anthropic search", () => {
  const sentBodies: Array<Record<string, unknown>> = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    sentBodies.length = 0;
  });

  function stubResponses(...responses: unknown[]) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sentBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const response = responses[Math.min(sentBodies.length - 1, responses.length - 1)];
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    });
  }

  const searched = { type: "web_search_tool_result", content: [{ type: "web_search_result" }] };
  const textBlock = { type: "text", text: "An answer." };

  // A captured body is parsed JSON, so the cast narrows `tools` to the shape
  // the assertions read.
  const sentTools = (call = 0) => sentBodies[call]?.["tools"] as Array<Record<string, unknown>>;

  it("forces the search tool on every answer call", async () => {
    // A model offered the tool can skip it and answer from memory. Forcing
    // needs the direct-caller form, or the API returns 400.
    stubResponses({ content: [searched, textBlock], stop_reason: "end_turn", usage: {} });
    await callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
    expect(sentBodies[0]?.["tool_choice"]).toEqual({ type: "tool", name: "web_search" });
    expect(sentTools()[0]?.["allowed_callers"]).toEqual(["direct"]);
    expect(sentTools()[0]?.["max_uses"]).toBe(5);
  });

  it("does not re-force on a pause_turn resume, whose search already ran", async () => {
    stubResponses(
      { content: [searched], stop_reason: "pause_turn", usage: {} },
      { content: [textBlock], stop_reason: "end_turn", usage: {} },
    );
    await callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]).not.toHaveProperty("tool_choice");
    expect(sentTools(1)[0]?.["allowed_callers"]).toEqual(["direct"]);
  });

  it("offers no tool at all when the call must not search", async () => {
    stubResponses({ content: [textBlock], stop_reason: "end_turn", usage: {} });
    await callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: false,
    });
    expect(sentBodies[0]).not.toHaveProperty("tools");
    expect(sentBodies[0]).not.toHaveProperty("tool_choice");
  });

  it("offers the search unforced to a model that rejects forced tool use", async () => {
    // Claude Opus 5.5 answers tool_choice "tool" with a 400. An answer that
    // then skips the search is caught by the pass's NO_WEB_SEARCH check.
    stubResponses({ content: [searched, textBlock], stop_reason: "end_turn", usage: {} });
    await callProvider({
      provider: "anthropic",
      modelId: "claude-opus-5-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
    expect(sentBodies[0]).not.toHaveProperty("tool_choice");
    expect(sentTools()[0]?.["name"]).toBe("web_search");
  });

  it("enforces a JSON shape with output_config.format on a model that rejects forced tools", async () => {
    const input = { answer_format: "prose", total_items: 0, brands: [] };
    stubResponses({
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: JSON.stringify(input) },
      ],
      stop_reason: "end_turn",
      usage: {},
    });
    const res = await callProvider({
      provider: "anthropic",
      modelId: "claude-opus-5-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    expect(sentBodies[0]).not.toHaveProperty("tools");
    expect(sentBodies[0]).not.toHaveProperty("tool_choice");
    expect(sentBodies[0]?.["output_config"]).toEqual({
      format: { type: "json_schema", schema: EXTRACTION_JSON_SCHEMA },
    });
    expect(JSON.parse(res.text)).toEqual(input);
  });
});

describe("canForceSearch", () => {
  it("is true where the request can force the search, false where it can only offer it", () => {
    expect(canForceSearch("openai", "gpt-6-sol")).toBe(true);
    expect(canForceSearch("anthropic", "claude-sonnet-5")).toBe(true);
    expect(canForceSearch("anthropic", "claude-opus-5")).toBe(true);
    expect(canForceSearch("anthropic", "claude-opus-5-5")).toBe(false);
    expect(canForceSearch("anthropic", "claude-sonnet-5-5")).toBe(false);
    expect(canForceSearch("google", "gemini-3.8-flash")).toBe(false);
  });

  it("is false for the Anthropic families that reject forced tools", () => {
    expect(anthropicAcceptsForcedTools("claude-fable-5-1")).toBe(false);
    expect(anthropicAcceptsForcedTools("claude-mythos-5-1")).toBe(false);
    expect(anthropicAcceptsForcedTools("claude-haiku-4-5")).toBe(true);
  });
});

describe("assembling an OpenAI answer", () => {
  let sent: Record<string, unknown> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    sent = undefined;
  });

  function answer(output: unknown) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ output, usage: {} }), {
        headers: { "content-type": "application/json" },
      });
    });
    return callProvider({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
  }

  it("forces the web search tool rather than leaving it optional", async () => {
    await answer([]);
    expect(sent?.["tools"]).toEqual([{ type: "web_search" }]);
    expect(sent?.["tool_choice"]).toBe("required");
  });

  it("counts only searches that completed", async () => {
    const res = await answer([
      { type: "web_search_call", status: "failed" },
      { type: "web_search_call", status: "in_progress" },
      { type: "web_search_call" },
      { type: "message", content: [{ type: "output_text", text: "From memory." }] },
    ]);
    expect(res.searchCalls).toBe(0);

    const ok = await answer([
      { type: "web_search_call", status: "completed" },
      { type: "message", content: [{ type: "output_text", text: "Acme Analytics." }] },
    ]);
    expect(ok.searchCalls).toBe(1);
  });

  it("does not repeat a source the model already cited inline", async () => {
    const res = await answer([
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Acme Analytics suits startups ([acme](https://acme-analytics.example.com)).",
            annotations: [{ type: "url_citation", url: "https://acme-analytics.example.com" }],
          },
        ],
      },
    ]);
    expect(res.text).toBe(
      "Acme Analytics suits startups ([acme](https://acme-analytics.example.com)).",
    );
  });

  it("keeps the sources it cited, in the text where extraction looks", async () => {
    const res = await answer([
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Acme Analytics suits startups.",
            annotations: [{ type: "url_citation", url: "https://acme-analytics.example.com" }],
          },
        ],
      },
    ]);
    expect(res.text).toBe("Acme Analytics suits startups. [https://acme-analytics.example.com]");
  });
});

describe("assembling a Gemini answer", () => {
  let sent: Record<string, unknown> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    sent = undefined;
  });

  function answer(candidate: unknown) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ candidates: [candidate], usageMetadata: {} }), {
        headers: { "content-type": "application/json" },
      });
    });
    return callProvider({
      provider: "google",
      modelId: "gemini-3.6-flash",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch: true,
    });
  }

  it("sends the search tool and counts the searches grounding reports", async () => {
    const res = await answer({
      content: { parts: [{ text: "Acme Analytics." }] },
      groundingMetadata: { webSearchQueries: ["best analytics tools"] },
    });
    expect(sent?.["tools"]).toEqual([{ googleSearch: {} }]);
    expect(res.searchCalls).toBe(1);
  });

  it("reports no search when the answer carries no grounding", async () => {
    const res = await answer({ content: { parts: [{ text: "From memory." }] } });
    expect(res.searchCalls).toBe(0);
  });

  it("stores source domains from grounding, never the opaque redirect URI", async () => {
    // web.uri is a vertexaisearch redirect that 404s outside a browser session.
    // web.title is the bare source domain.
    const res = await answer({
      content: { parts: [{ text: "Acme Analytics suits startups." }] },
      groundingMetadata: {
        webSearchQueries: ["best analytics tools"],
        groundingChunks: [
          {
            web: {
              uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA",
              title: "acme-analytics.example.com",
            },
          },
        ],
      },
    });
    expect(res.text).toBe("Acme Analytics suits startups. [https://acme-analytics.example.com]");
    expect(res.text).not.toContain("vertexaisearch");
    expect(res.searchCalls).toBe(1);
  });
});

describe("withGroundingCitations", () => {
  const redirect = (title: string) => ({
    web: { uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${title}`, title },
  });

  it("leaves the answer alone when no search ran", () => {
    expect(
      withGroundingCitations("From memory.", { groundingChunks: [redirect("a.example.com")] }),
    ).toBe("From memory.");
    expect(withGroundingCitations("From memory.", undefined)).toBe("From memory.");
  });

  it("skips chunks whose title is a page title, not a domain", () => {
    // Inventing a URL from a headline would be guessing at a source.
    expect(
      withGroundingCitations("An answer.", {
        webSearchQueries: ["q"],
        groundingChunks: [
          {
            web: {
              uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/X",
              title: "The Best 10 CRMs for Consultants in 2026",
            },
          },
        ],
      }),
    ).toBe("An answer.");
  });

  it("does not repeat a source the model wrote inline itself", () => {
    expect(
      withGroundingCitations("See https://acme-analytics.example for details.", {
        webSearchQueries: ["q"],
        groundingChunks: [redirect("acme-analytics.example")],
      }),
    ).toBe("See https://acme-analytics.example for details.");
  });

  it("prefers a real page URI over the domain title when a chunk carries one", () => {
    expect(
      withGroundingCitations("An answer.", {
        webSearchQueries: ["q"],
        groundingChunks: [
          { web: { uri: "https://blog.example.com/crm-roundup", title: "blog.example.com" } },
        ],
      }),
    ).toBe("An answer. [https://blog.example.com/crm-roundup]");
  });

  it("places each source once, after the earliest segment that supports it", () => {
    const text = "First claim. Second claim.";
    const out = withGroundingCitations(text, {
      webSearchQueries: ["q"],
      groundingChunks: [redirect("a.example.com")],
      groundingSupports: [
        { segment: { endIndex: 12 }, groundingChunkIndices: [0] },
        { segment: { endIndex: 25 }, groundingChunkIndices: [0] },
      ],
    });
    expect(out).toBe("First claim. [https://a.example.com] Second claim.");
  });

  it("appends sources no support segment references flat at the end", () => {
    const out = withGroundingCitations("A claim.", {
      webSearchQueries: ["q"],
      groundingChunks: [redirect("a.example.com"), redirect("b.example.com")],
      groundingSupports: [{ segment: { endIndex: 8 }, groundingChunkIndices: [0] }],
    });
    expect(out).toBe("A claim. [https://a.example.com] [https://b.example.com]");
  });

  it("accepts the alternate chunk-indices field name and clamps out-of-range ends", () => {
    const out = withGroundingCitations("Short.", {
      webSearchQueries: ["q"],
      groundingChunks: [redirect("a.example.com")],
      groundingSupports: [{ segment: { endIndex: 999 }, supportingChunkIndices: [0] }],
    });
    expect(out).toBe("Short. [https://a.example.com]");
  });
});

describe("extractorCheck", () => {
  beforeEach(() => {
    process.env["OPENAI_API_KEY"] = "sk-test-key-value";
  });

  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
  });

  it("reports mocked under the offline seam, without any call", async () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    const ping = vi.fn();
    expect((await extractorCheck("openai", "gpt-5.6-luna", ping)).status).toBe("mocked");
    expect(ping).not.toHaveBeenCalled();
  });

  it("probes with the given prompt and the enforced shape an extraction call uses", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      body = init.body;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: {} }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const res = await extractorCheck(
      "openai",
      "gpt-5.6-luna",
      undefined,
      "Count every brand named, strictly in JSON.",
    );

    expect(res.status).toBe("ok");
    const sent = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>;
      response_format?: Record<string, unknown>;
      max_completion_tokens?: number;
    };
    expect(sent.messages[0]).toEqual({
      role: "system",
      content: "Count every brand named, strictly in JSON.",
    });
    // A run enforces the shape in the request, so the probe must too.
    expect(sent.response_format).toEqual(STRICT_RESPONSE_FORMAT);
    // The budget has to hold the smallest conforming reply, not just a ping.
    expect(sent.max_completion_tokens).toBe(EXTRACTION_PROBE_MAX_TOKENS);
    vi.unstubAllGlobals();
  });

  it("pings the exact model given and returns ok when it answers", async () => {
    let seen = "";
    const res = await extractorCheck("openai", "gpt-5.6-luna", async (_provider, modelId) => {
      seen = modelId;
      return { text: "ok" };
    });
    expect(seen).toBe("gpt-5.6-luna");
    expect(res.status).toBe("ok");
  });

  it("returns no_key when no key is configured, never a passing verdict", async () => {
    delete process.env["OPENAI_API_KEY"];
    const res = await extractorCheck("openai", "gpt-5.6-luna", async () => ({ text: "ok" }));
    expect(res.status).toBe("no_key");
  });

  it("classifies a provider auth failure as invalid_key", async () => {
    const res = await extractorCheck("openai", "gpt-5.6-luna", async () => {
      throw Object.assign(new Error("HTTP 401: invalid_api_key"), { status: 401 });
    });
    expect(res.status).toBe("invalid_key");
  });

  it("classifies a quota failure as no_credits", async () => {
    const res = await extractorCheck("openai", "gpt-5.6-luna", async () => {
      throw Object.assign(new Error("HTTP 429: you exceeded your current quota"), { status: 429 });
    });
    expect(res.status).toBe("no_credits");
  });

  it("treats an error without a status as provider_unavailable", async () => {
    const res = await extractorCheck("openai", "gpt-5.6-luna", async () => {
      throw new Error("socket hang up");
    });
    expect(res.status).toBe("provider_unavailable");
  });

  it("never lets a configured key value reach the verdict", async () => {
    const res = await extractorCheck("openai", "gpt-5.6-luna", async () => {
      throw Object.assign(new Error("HTTP 401: key sk-test-key-value rejected"), { status: 401 });
    });
    expect(JSON.stringify(res)).not.toContain("sk-test-key-value");
  });
});

describe("searchCheck", () => {
  let sent: Record<string, unknown> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    sent = undefined;
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
  });

  function stub(response: unknown, status = 200) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("reports mocked under the offline seam, without any call", async () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await searchCheck("openai", "gpt-5.6-terra", "k")).status).toBe("mocked");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports no_key rather than a false verdict when nothing is configured", async () => {
    expect((await searchCheck("anthropic", "claude-sonnet-5")).status).toBe("no_key");
  });

  it("requires the search on OpenAI and passes on a completed search call", async () => {
    stub({ output: [{ type: "web_search_call", status: "completed" }] });
    const res = await searchCheck("openai", "gpt-5.6-terra", "test-key");
    expect(sent?.["tools"]).toEqual([{ type: "web_search", search_context_size: "low" }]);
    expect(sent?.["tool_choice"]).toBe("required");
    expect(res.status).toBe("ok");
  });

  it("fails an OpenAI response whose search never completed", async () => {
    stub({ output: [{ type: "web_search_call", status: "failed" }] });
    expect((await searchCheck("openai", "gpt-5.6-terra", "test-key")).status).toBe(
      "search_not_performed",
    );
  });

  it("classifies an OpenAI billing failure", async () => {
    stub({ error: { code: "credit_balance_exhausted" } }, 429);
    const res = await searchCheck("openai", "gpt-5.6-terra", "test-key");
    expect(res.status).toBe("no_credits");
    expect(res.hint).toContain("billing");
  });

  it("caps the probe at one search and forces, mirroring the run's request shape", async () => {
    stub({
      content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result" }] }],
    });
    const res = await searchCheck("anthropic", "claude-sonnet-5", "test-key");
    const tools = sent?.["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]?.["name"]).toBe("web_search");
    expect(tools[0]?.["max_uses"]).toBe(1);
    // Run answers force the tool in the direct-caller form, so the probe sends
    // the same shape.
    expect(tools[0]?.["allowed_callers"]).toEqual(["direct"]);
    expect(sent?.["tool_choice"]).toEqual({ type: "tool", name: "web_search" });
    expect(res.status).toBe("ok");
  });

  it("probes a model that rejects forced tools the way its runs ask it: unforced", async () => {
    stub({
      content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result" }] }],
    });
    const res = await searchCheck("anthropic", "claude-opus-5-5", "test-key");
    expect(sent).not.toHaveProperty("tool_choice");
    expect(res.status).toBe("ok");
  });

  it("recognises Anthropic's documented org-disabled error", async () => {
    stub({ error: { type: "invalid_request_error", message: "web search is not enabled" } }, 400);
    const res = await searchCheck("anthropic", "claude-sonnet-5", "test-key");
    expect(res.status).toBe("search_disabled");
    expect(res.hint).toContain("Privacy");
  });

  it("reports an Anthropic search that ran and failed", async () => {
    stub({
      content: [{ type: "web_search_tool_result", content: { error_code: "too_many_requests" } }],
    });
    const res = await searchCheck("anthropic", "claude-sonnet-5", "test-key");
    expect(res.status).toBe("search_failed");
    expect(res.detail).toContain("too_many_requests");
  });

  it("passes on Gemini grounding data and fails without it", async () => {
    stub({ candidates: [{ groundingMetadata: { webSearchQueries: ["today's news"] } }] });
    const res = await searchCheck("google", "gemini-3.6-flash", "test-key");
    expect(sent?.["tools"]).toEqual([{ googleSearch: {} }]);
    // Room for a thinking model's reasoning before it searches.
    expect(sent?.["generationConfig"]).toEqual({ maxOutputTokens: 1024 });
    expect(res.status).toBe("ok");

    stub({ candidates: [{ content: { parts: [{ text: "From memory." }] } }] });
    const plain = await searchCheck("google", "gemini-3.6-flash", "test-key");
    expect(plain.status).toBe("search_not_performed");
    expect(plain.message).toContain("without searching");
    expect(plain.hint).toContain("Run the check again");
  });

  it("reports a Gemini reply cut off by the token limit as truncated, with the snippet", async () => {
    // A thinking model can spend its whole budget on reasoning (finishReason
    // MAX_TOKENS, no groundingMetadata) on an account where search works.
    stub({
      candidates: [
        {
          finishReason: "MAX_TOKENS",
          content: { parts: [{ text: "World leaders are currently gathered in" }] },
        },
      ],
    });
    const res = await searchCheck("google", "gemini-3.6-flash", "test-key");
    expect(res.status).toBe("search_not_performed");
    expect(res.message).toContain("cut off");
    expect(res.detail).toContain("World leaders are currently gathered in");
  });

  it("reports an Anthropic reply cut off at max_tokens as truncated", async () => {
    stub({ content: [{ type: "text", text: "I think…" }], stop_reason: "max_tokens" });
    const res = await searchCheck("anthropic", "claude-sonnet-5", "test-key");
    expect(res.status).toBe("search_not_performed");
    expect(res.message).toContain("cut off");
  });

  it("reports an incomplete OpenAI response as truncated", async () => {
    stub({ status: "incomplete", output: [{ type: "web_search_call", status: "in_progress" }] });
    const res = await searchCheck("openai", "gpt-5.6-terra", "test-key");
    expect(res.status).toBe("search_not_performed");
    expect(res.message).toContain("cut off");
  });

  it("recognises Gemini's free-tier billing precondition", async () => {
    stub(
      {
        error: {
          status: "FAILED_PRECONDITION",
          message: "a prerequisite is not met (disabled billing)",
        },
      },
      400,
    );
    const res = await searchCheck("google", "gemini-3.6-flash", "test-key");
    expect(res.status).toBe("billing_not_enabled");
    expect(res.hint).toContain("Upgrade");
  });
});

describe("searchCheckModelId", () => {
  it("picks the current mid tier search-capable model per provider, never a superseded one", () => {
    expect(searchCheckModelId("openai")).toBe("gpt-6.1-sol");
    expect(searchCheckModelId("anthropic")).toBe("claude-sonnet-5-5");
    expect(searchCheckModelId("google")).toBe("gemini-3.8-flash");
  });
});

describe("callExtractionModel, the extraction-family adapter", () => {
  let sent: Record<string, unknown> | undefined;

  beforeEach(() => {
    process.env["OPENAI_API_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["OPENAI_API_KEY"];
    sent = undefined;
  });

  function stubChat() {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: {} }),
        { headers: { "content-type": "application/json" } },
      );
    });
  }

  it("speaks JSON, never searches, and bounds tokens with the cheap extraction cap", async () => {
    stubChat();
    await callExtractionModel({ provider: "openai", model_id: "gpt-5.6-luna" }, "system", "user");
    expect(sent?.["response_format"]).toEqual({ type: "json_object" });
    expect(sent?.["max_completion_tokens"]).toBe(EXTRACTION_MAX_TOKENS);
    expect(sent).not.toHaveProperty("tools");
  });

  it("passes a caller's prose mode and token bound through", async () => {
    stubChat();
    await callExtractionModel({ provider: "openai", model_id: "gpt-5.6-luna" }, "system", "user", {
      jsonMode: false,
      maxTokens: 512,
    });
    expect(sent).not.toHaveProperty("response_format");
    expect(sent?.["max_completion_tokens"]).toBe(512);
  });

  it("refuses with the worker's credential error before any request when no key exists", async () => {
    delete process.env["OPENAI_API_KEY"];
    stubChat();
    await expect(
      callExtractionModel({ provider: "openai", model_id: "gpt-5.6-luna" }, "s", "u"),
    ).rejects.toMatchObject({ message: "MISSING_CREDENTIAL:openai", status: 400 });
    expect(sent).toBeUndefined();
  });

  it("refuses a catalog-only provider that has no adapter", async () => {
    await expect(
      callExtractionModel({ provider: "perplexity", model_id: "sonar" }, "s", "u"),
    ).rejects.toMatchObject({ message: "UNSUPPORTED_PROVIDER:perplexity", status: 400 });
  });

  it("needs no key under the mock seam, which answers before any request", async () => {
    delete process.env["OPENAI_API_KEY"];
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    // No fetch stub: a live call would throw or hang, so a clean resolve shows
    // the seam answers first.
    const res = await callExtractionModel(
      { provider: "openai", model_id: "gpt-5.6-luna" },
      "system",
      "user",
    );
    expect(res.text).not.toBe("");
  });
});

describe("timeoutForRetry", () => {
  it("raises the budget after every spelling of a timeout in an older row", () => {
    for (const text of [
      "TIMEOUT after 240004ms of a 240000ms budget: The operation timed out",
      "DEADLINE_EXCEEDED: no time left for this call",
      "The operation was aborted",
    ]) {
      expect(timeoutForRetry({ code: null, error: text })).toBe(RAISED_TIMEOUT_MS);
    }
  });

  it("raises the budget on the timeout codes", () => {
    expect(timeoutForRetry({ code: "TIMEOUT", error: null })).toBe(RAISED_TIMEOUT_MS);
    expect(timeoutForRetry({ code: "DEADLINE_EXCEEDED", error: null })).toBe(RAISED_TIMEOUT_MS);
  });

  it("keeps the standard budget for a first attempt and for every other failure", () => {
    expect(timeoutForRetry({ code: null, error: null })).toBe(TIMEOUT_MS);
    expect(timeoutForRetry({ code: "HTTP:429", error: "HTTP 429: rate limited" })).toBe(TIMEOUT_MS);
    expect(
      timeoutForRetry({
        code: "NO_WEB_SEARCH",
        error: "NO_WEB_SEARCH: the assistant answered from memory",
      }),
    ).toBe(TIMEOUT_MS);
  });

  it("pins the raised budget as the longest deadline any call can hold", () => {
    expect(RAISED_TIMEOUT_MS).toBeGreaterThan(TIMEOUT_MS);
    expect(MAX_CALL_TIMEOUT_MS).toBe(RAISED_TIMEOUT_MS);
  });
});

describe("enforcing the extraction shape", () => {
  // What each adapter sends for a call carrying the shape, and how it reads
  // the reply. Fetch is stubbed.
  let sent: Record<string, unknown> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    sent = undefined;
  });

  function stub(response: unknown) {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("OpenAI: sends strict structured outputs, not the shapeless json_object mode", async () => {
    stub({ choices: [{ message: { content: "{}" } }], usage: {} });
    await callProvider({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    expect(sent?.["response_format"]).toEqual(STRICT_RESPONSE_FORMAT);
  });

  it("OpenAI: a plain JSON-mode call keeps the shapeless mode, for the callers that have no schema", async () => {
    // The prose-summary caller is one of them.
    stub({ choices: [{ message: { content: "{}" } }], usage: {} });
    await callProvider({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
    });
    expect(sent?.["response_format"]).toEqual({ type: "json_object" });
  });

  it("Anthropic: forces a tool whose input schema is the shape", async () => {
    stub({ content: [], stop_reason: "tool_use", usage: {} });
    await callProvider({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    const tools = sent?.["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: EXTRACTION_SHAPE.name,
      input_schema: EXTRACTION_JSON_SCHEMA,
    });
    expect(sent?.["tool_choice"]).toEqual({ type: "tool", name: EXTRACTION_SHAPE.name });
  });

  it("Anthropic: reads the reply out of the tool_use block, so the caller's contract stays 'the text is the JSON'", async () => {
    const input = { answer_format: "prose", total_items: 0, brands: [] };
    stub({
      content: [{ type: "tool_use", id: "tu_1", name: EXTRACTION_SHAPE.name, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 30 },
    });
    const res = await callProvider({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    expect(res.text).toBe(JSON.stringify(input));
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(30);
  });

  it("Anthropic: ignores a tool_use block for some other tool, and keeps text blocks", async () => {
    stub({
      content: [
        { type: "tool_use", id: "tu_1", name: "something_else", input: { junk: true } },
        { type: "text", text: '{"answer_format":"prose"}' },
      ],
      stop_reason: "end_turn",
      usage: {},
    });
    const res = await callProvider({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    expect(res.text).toBe('{"answer_format":"prose"}');
  });

  it("Gemini: sends the response schema in its own dialect beside the JSON mime type", async () => {
    stub({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: {} });
    await callProvider({
      provider: "google",
      modelId: "gemini-3.1-flash-lite",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    const generationConfig = sent?.["generationConfig"] as Record<string, unknown>;
    expect(generationConfig["responseMimeType"]).toBe("application/json");
    const schema = generationConfig["responseSchema"] as Record<string, unknown>;
    expect(schema["type"]).toBe("OBJECT");
    expect(schema["required"]).toEqual(["answer_format", "total_items", "brands"]);
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["total_items"]).toEqual({ type: "INTEGER", nullable: true });
    expect(properties["answer_format"]).toMatchObject({ type: "STRING" });
    expect((properties["brands"] as Record<string, unknown>)["type"]).toBe("ARRAY");
  });

  it("callExtractionModel passes the shape through and keeps the extraction bounds", async () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    stub({ choices: [{ message: { content: "{}" } }], usage: {} });
    await callExtractionModel({ provider: "openai", model_id: "gpt-5.6-luna" }, "system", "user", {
      jsonSchema: EXTRACTION_SHAPE,
    });
    expect(sent).toMatchObject({ response_format: { type: "json_schema" } });
    expect(sent?.["max_completion_tokens"]).toBe(EXTRACTION_MAX_TOKENS);
    expect(sent).not.toHaveProperty("tools");
    delete process.env["OPENAI_API_KEY"];
  });

  it("refuses to enforce a shape and search at once, loudly rather than dropping one", async () => {
    // No caller does this. The guard fails a mistake instead of silently
    // answering unenforced. No fetch stub: it must refuse before any request.
    await expect(
      callProvider({
        provider: "openai",
        modelId: "gpt-5.6-luna",
        apiKey: "test-key",
        system: "system",
        user: "user",
        jsonMode: true,
        jsonSchema: EXTRACTION_SHAPE,
        webSearch: true,
      }),
    ).rejects.toThrow(/SCHEMA_WITH_SEARCH/);
  });

  it("the mock seam still answers an enforced extraction with no keys and no network", async () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    delete process.env["OPENAI_API_KEY"];
    // No fetch stub: a live call would throw or hang, so a clean resolve shows
    // the seam answers before any request is built.
    const res = await callProvider({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      apiKey: "ignored",
      system: "system",
      user: "1. Acme Analytics is a reasonable choice for this.",
      jsonMode: true,
      jsonSchema: EXTRACTION_SHAPE,
    });
    expect(JSON.parse(res.text)).toMatchObject({ answer_format: expect.any(String) });
    delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  });
});

describe("reading the model version the provider reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reply(
    provider: "openai" | "anthropic" | "google",
    response: unknown,
    webSearch = false,
  ) {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        }),
    );
    return callProvider({
      provider,
      modelId: "asked-for",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: false,
      webSearch,
    });
  }

  it("OpenAI: the model field on both APIs", async () => {
    const chat = await reply("openai", {
      model: "reader-2026-09-22",
      choices: [{ message: { content: "hi" } }],
    });
    expect(chat.model).toBe("reader-2026-09-22");
    const responses = await reply("openai", { model: "answerer-2026-09-22", output: [] }, true);
    expect(responses.model).toBe("answerer-2026-09-22");
  });

  it("Anthropic: the model field", async () => {
    const res = await reply("anthropic", {
      model: "answerer-5-5",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {},
    });
    expect(res.model).toBe("answerer-5-5");
  });

  it("Gemini: modelVersion, and undefined when the reply names none", async () => {
    const named = await reply("google", {
      modelVersion: "answerer-flash-001",
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
    });
    expect(named.model).toBe("answerer-flash-001");
    const unnamed = await reply("google", {
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
    });
    expect(unnamed.model).toBeUndefined();
  });
});

describe("reporting a reply cut off at the output cap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reply(
    provider: "openai" | "anthropic" | "google",
    response: unknown,
    webSearch = false,
  ) {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        }),
    );
    return callProvider({
      provider,
      modelId: "reader",
      apiKey: "test-key",
      system: "system",
      user: "user",
      jsonMode: !webSearch,
      webSearch,
      ...(webSearch ? {} : { jsonSchema: EXTRACTION_SHAPE }),
    });
  }

  it("OpenAI chat completions: finish_reason length", async () => {
    const cut = await reply("openai", {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { completion_tokens: 8192 },
    });
    expect(cut.truncated).toBe(true);
    const whole = await reply("openai", {
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: {},
    });
    expect(whole.truncated).toBe(false);
  });

  it("OpenAI responses: an incomplete response for max_output_tokens, and nothing else", async () => {
    const cut = await reply(
      "openai",
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      true,
    );
    expect(cut.truncated).toBe(true);
    const filtered = await reply(
      "openai",
      { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] },
      true,
    );
    expect(filtered.truncated).toBe(false);
  });

  it("Anthropic: stop_reason max_tokens", async () => {
    const cut = await reply("anthropic", { content: [], stop_reason: "max_tokens", usage: {} });
    expect(cut.truncated).toBe(true);
    const whole = await reply("anthropic", { content: [], stop_reason: "tool_use", usage: {} });
    expect(whole.truncated).toBe(false);
  });

  it("Gemini: finishReason MAX_TOKENS", async () => {
    const cut = await reply("google", {
      candidates: [
        { content: { parts: [{ text: '{"answer_format":' }] }, finishReason: "MAX_TOKENS" },
      ],
      usageMetadata: {},
    });
    expect(cut.truncated).toBe(true);
    const whole = await reply("google", {
      candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
      usageMetadata: {},
    });
    expect(whole.truncated).toBe(false);
  });
});

describe("subscription mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["OVERHEARD_ANTHROPIC_CLI"];
    delete process.env["OVERHEARD_OPENAI_CLI"];
  });

  /** What a signed-out Codex prints at the end of its turn. */
  const CODEX_SIGNED_OUT = `process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }) + "\\n");
process.exit(1);`;

  it("asks through the command, never the API, and does not retry a signed-out one", async () => {
    process.env["OVERHEARD_ANTHROPIC_CLI"] = standInCommand();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const error = await callProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "unused",
      system: "s",
      user: "u",
      jsonMode: false,
      webSearch: true,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "CLI_SIGN_IN:anthropic", status: 401, retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tells the setup check to sign the command in, not to fix a key", async () => {
    process.env["OVERHEARD_OPENAI_CLI"] = standInCommand(CODEX_SIGNED_OUT);
    const verdict = await searchCheck("openai", "gpt-5.6-terra");
    expect(verdict.status).toBe("invalid_key");
    expect(verdict.message).toBe("The codex command could not answer with your ChatGPT plan.");
    expect(verdict.hint).toBe(
      "Check Codex is installed, then run codex login in a terminal and check again.",
    );
    const extractor = await extractorCheck("openai", "gpt-5.6-luna");
    expect(extractor.message).toBe("The codex command could not answer with your ChatGPT plan.");
  });

  it("presses for a search in words, since neither command can force one", () => {
    expect(canForceSearch("openai", "gpt-5.6-terra")).toBe(true);
    process.env["OVERHEARD_OPENAI_CLI"] = standInCommand();
    expect(canForceSearch("openai", "gpt-5.6-terra")).toBe(false);
  });
});
