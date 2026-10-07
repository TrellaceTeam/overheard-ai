// Provider adapters for OpenAI, Anthropic and Google, and the setup-check
// probes. API keys come from ./keys, which reads the user's own environment.
// A provider in subscription mode is asked through its own command line tool
// instead (./cli-provider).
import type { Provider } from "../db/types";
import { CATALOGUE } from "../db/seed-models";
import {
  classifySearchFailure,
  cliNotReady,
  extractorOk,
  planLimited,
  planSearchOk,
  searchFailed,
  searchMocked,
  searchNoKey,
  searchNotPerformed,
  searchOk,
  type SearchCheckResult,
} from "@/lib/setup-check";
import { classifyFailure } from "@/lib/failure-reasons";
import {
  failureCode,
  failureCodeBase,
  type FailureCode,
  type StoredFailure,
} from "@/lib/failure-codes";
import { isCliProvider } from "@/lib/provider-keys";
import { callCli, type CliFailure } from "./cli-provider";
import { type CliTarget, providerCli, providerKeyValues, resolveProviderKey } from "./keys";
import {
  EXTRACTION_SHAPE,
  EXTRACTION_SYSTEM,
  toGeminiResponseSchema,
  type EnforcedShape,
} from "./extraction";
import { mockCallProvider, mockProvidersEnabled } from "./mock-provider";

export type { Provider };

/** Narrows to a provider with an adapter. The catalogue CHECK also allows two that have none. */
export function supportedProvider(provider: string): Provider | null {
  if (provider === "openai" || provider === "anthropic" || provider === "google") {
    return provider as Provider;
  }
  return null;
}

/** Providers report usage, never cost. Pricing is catalogue data (see costOf in pass.ts). */
export type ProviderResult = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  tokens: number | null; // stored as run_tasks.answer_tokens
  searchCalls: number;
  /**
   * Why the provider stopped. Only Anthropic reports it. A response with no
   * text can then say why, instead of reading as an empty answer.
   */
  stopReason?: string | undefined;
  /**
   * The provider stopped at the output token cap, so the text may be empty or
   * cut off mid-reply. OpenAI says finish_reason "length" or an incomplete
   * response, Anthropic stop_reason "max_tokens", Gemini finishReason
   * "MAX_TOKENS".
   */
  truncated?: boolean | undefined;
  /**
   * The model version the provider says answered: OpenAI and Anthropic `model`,
   * Gemini `modelVersion`. It can name a dated snapshot behind the id that was
   * asked for. Undefined when the provider reports none.
   */
  model?: string | undefined;
};

/** The usage part of a result, which a rejected call is still billed for. */
export type ProviderUsage = Pick<ProviderResult, "inputTokens" | "outputTokens" | "searchCalls">;

export class ProviderError extends Error {
  status: number;
  retryable: boolean;
  /**
   * Recorded with the task when it fails. The constructor requires it, so
   * every throw site has to name its failure kind.
   */
  code: FailureCode;
  /**
   * The usage the rejected response reported, if it got that far. A rejected
   * answer is still billed, and this lets the pass log its real spend instead
   * of a worst-case estimate.
   */
  usage?: ProviderUsage | undefined;
  constructor(
    message: string,
    status: number,
    code: FailureCode,
    usage?: ProviderUsage | undefined,
  ) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500 || status === 0;
    this.code = code;
    this.usage = usage;
  }
}

/**
 * Masks API keys in an error message and clips it to 500 characters.
 * Providers echo request context on failure, so a raw body is never stored.
 *
 * The configured key values are replaced literally first, which covers any
 * key format. Node's fetch rejects a header value with a byte outside
 * 0x21-0x7E and echoes the whole value back, so a key with a zero-width space
 * near its start can leave too few characters after its prefix for the shape
 * patterns to match.
 *
 * The shape patterns then catch keys that are not this process's own, such as
 * one quoted in a provider's error text. The Anthropic prefix goes first, or
 * the generic `sk-` pattern masks `sk-ant-...` under the wrong prefix.
 *
 * The clip bounds a stored error, and @/lib/failure-reasons relies on it.
 */
export function scrubError(input: string, keys: readonly string[] = providerKeyValues()): string {
  let masked = input;
  for (const key of keys) masked = masked.split(key).join("***");
  return masked
    .replace(/(sk-ant-|AIza)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .slice(0, 500);
}

/**
 * The call budgets live in logic/types because the recovery sweep derives its
 * stale-lock window from them. A lock reclaimed while its call is still in
 * flight pays for the same answer twice.
 */
export { MAX_CALL_TIMEOUT_MS, RAISED_TIMEOUT_MS, TIMEOUT_MS } from "../logic/types";
import { RAISED_TIMEOUT_MS, TIMEOUT_MS } from "../logic/types";

/**
 * The budget for this attempt's call, from the phase's last failure. Only a
 * timeout earns the raised budget. classifyFailure is the same reading the
 * failure card uses, so the worker and the card agree on what a timeout is.
 * The run page's Retry keeps the last failure reason on the row, so a manual
 * retry after a timeout gets the raised budget too.
 */
export function timeoutForRetry(lastFailure: StoredFailure): number {
  return classifyFailure(lastFailure).key === "timeout" ? RAISED_TIMEOUT_MS : TIMEOUT_MS;
}

/**
 * Output token cap for an answer, on every provider.
 *
 * Current models reason before they write, and the reasoning spends the same
 * allowance. A turn that spends it all returns stop_reason "max_tokens" with
 * no text. The cap applies per turn of a server tool loop, while usage sums
 * every turn, so reported usage cannot show that the cap was hit. Visible
 * answers run to about 400 tokens. The rest is room for reasoning.
 */
export const ANSWER_MAX_TOKENS = 8192;

/**
 * Output token cap for every call to the extraction model. Reasoning spends
 * the same allowance as the JSON, and extraction runs at the model's default
 * effort, so a long answer can take a reader close to 2,000 tokens. Output is
 * billed as used, so a high cap costs nothing until a reply needs it.
 */
export const EXTRACTION_MAX_TOKENS = 8192;

/**
 * Output cap for the extractor probe. The probe sends the enforced extraction
 * shape, and the smallest conforming reply is a full JSON object. A probe cut
 * off mid-reply fails a key that works. 256 fits a thinking model's reasoning
 * plus the minimal object.
 */
export const EXTRACTION_PROBE_MAX_TOKENS = 256;

/**
 * Sent only as Anthropic's web_search max_uses. OpenAI's web_search tool and
 * Gemini's googleSearch grounding take no per-call limit, so there the model
 * decides how often to search.
 *
 * Comparative, multi-entity questions need several searches. Refused a
 * search it wants, the model says it could not search and answers from
 * memory. Anthropic's searches are heavy (tens of thousands of input tokens
 * for a single search) and they spend the user's own key, so the cap is five.
 */
export const MAX_SEARCHES = 5;

/**
 * The shallowest reasoning setting each provider offers.
 *
 * On a searching answer, reasoning is most of the wall-clock time and most of
 * the output tokens, and at a run's volume it decides whether calls finish
 * inside their timeout. The cost is fidelity: a buyer asking the real
 * assistant gets its default depth, and this measures something slightly
 * shallower.
 *
 * Each provider spells it differently and support varies by model, so
 * postWithLowEffort retries without it on a 400.
 */
const LOW_EFFORT = "low";

/**
 * How many times a paused turn is resumed. Resumes share the original call's
 * deadline, so this guards against looping. It is not a time budget.
 */
export const PAUSE_RESUME_LIMIT = 4;

/**
 * Appends a text block's citation URLs to the block, in brackets.
 *
 * Web search citations arrive as an array on the block, never in its text, and
 * extraction only credits a linked_url that appears in the answer. Each block
 * carries its own URLs, so a source stays beside the sentence it supports and
 * extraction can tell which brand it belongs to.
 */
export function withCitations(
  text: string,
  citations: Array<{ type?: string; url?: string }> | undefined,
): string {
  const urls = [
    ...new Set((citations ?? []).map((c) => c.url).filter((u): u is string => Boolean(u))),
  ];
  if (urls.length === 0) return text;
  // Inserted before the block's trailing whitespace. Blocks are concatenated,
  // so that whitespace is the gap to the next block. Appending after it runs
  // "[url]" into the next word, or pushes the next markdown list item off
  // column 0. A replacer function, because a "$" in a url would be read as $&.
  return text.replace(/\s*$/, (trailing) => ` [${urls.join(", ")}]${trailing}`);
}

/**
 * Gemini grounding reports each source as a chunk tied to the answer segments
 * it supports. With the googleSearch tool the chunk's `uri` is an opaque
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/…` link that 404s
 * outside a browser session, and its `title` is the bare source domain. The
 * redirect host never matches a brand domain, and enrichNewBrands would seed
 * it as every discovered brand's domain, after which isCitation's "no known
 * domains, any link cites" rule counts every Gemini link as a citation. So the
 * redirect is dropped and the domain title becomes the URL: domain-level
 * attribution, as in Google's own sources UI.
 */
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

function groundingChunkUrl(web: { uri?: string; title?: string } | undefined): string | null {
  const uri = web?.uri;
  if (uri) {
    try {
      const parsed = new URL(uri);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname !== GROUNDING_REDIRECT_HOST
      ) {
        // A real page URL, if one appears, is more precise than the domain.
        return uri;
      }
    } catch {
      // Fall through to the title.
    }
  }
  const title = (web?.title ?? "").trim();
  // Bare domains only ("northwind.example"). A page title is skipped, not
  // turned into a guessed URL.
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(title)) {
    return `https://${title.toLowerCase()}`;
  }
  return null;
}

export type GeminiGrounding = {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  groundingSupports?: Array<{
    segment?: { startIndex?: number; endIndex?: number };
    // The field name varies by API surface. Both occur.
    groundingChunkIndices?: number[];
    supportingChunkIndices?: number[];
  }>;
};

/**
 * Puts Gemini's grounding sources into the answer text, since extraction only
 * credits a URL that appears in it. Each unique URL goes in once, beside the
 * earliest segment that references it, for the reason withCitations gives.
 * URLs no segment references are appended at the end. The text is returned
 * unchanged when no search ran.
 */
export function withGroundingCitations(
  text: string,
  grounding: GeminiGrounding | undefined,
): string {
  if ((grounding?.webSearchQueries?.length ?? 0) === 0) return text;
  const urls = (grounding?.groundingChunks ?? []).map((chunk) => groundingChunkUrl(chunk.web));

  const placed = new Set<string>();
  const inserts: Array<{ at: number; urls: string[] }> = [];
  // Sorted by segment end so each URL lands at its earliest segment, whatever
  // order the supports arrive in.
  const supports = [...(grounding?.groundingSupports ?? [])].sort(
    (a, b) => (a.segment?.endIndex ?? 0) - (b.segment?.endIndex ?? 0),
  );
  for (const support of supports) {
    const end = support.segment?.endIndex;
    if (typeof end !== "number") continue;
    const at = Math.min(Math.max(end, 0), text.length);
    const list: string[] = [];
    for (const index of support.groundingChunkIndices ?? support.supportingChunkIndices ?? []) {
      const url = urls[index];
      if (!url || placed.has(url) || text.includes(url)) continue;
      placed.add(url);
      list.push(url);
    }
    if (list.length > 0) inserts.push({ at, urls: list });
  }
  inserts.sort((a, b) => a.at - b.at);

  let out = "";
  let cursor = 0;
  for (const insert of inserts) {
    out += `${text.slice(cursor, insert.at)} [${insert.urls.join(", ")}]`;
    cursor = insert.at;
  }
  out += text.slice(cursor);

  const leftover = urls.filter(
    (url): url is string => url !== null && !placed.has(url) && !text.includes(url),
  );
  return withCitations(
    out,
    leftover.map((url) => ({ url })),
  );
}

/**
 * The first error code when no search succeeded, or undefined.
 *
 * A failed search does not raise. The request returns HTTP 200 and the model
 * answers from memory. The only signal is the result block's `content`: a list
 * when the search ran, an object with an `error_code` when it did not. An
 * empty list is a search that matched nothing, which counts as a success.
 *
 * One successful search is enough. max_uses_exceeded fires whenever the model
 * wants more searches than MAX_SEARCHES allows, which is common on comparative
 * questions, so failing on any error would reject grounded answers.
 */
export function webSearchFailure(
  content: Array<{ type: string; text?: string; content?: unknown }> | undefined,
): string | undefined {
  let firstError: string | undefined;
  for (const block of content ?? []) {
    if (block.type !== "web_search_tool_result") continue;
    const inner = block.content;
    if (Array.isArray(inner)) return undefined; // one search ran, which is enough
    if (inner === null || typeof inner !== "object") continue;
    const code = (inner as { error_code?: unknown }).error_code;
    if (typeof code === "string" && firstError === undefined) firstError = code;
  }
  return firstError;
}

/** A copy of the body with the provider's low-effort reasoning setting added. */
export function applyLowEffort(
  provider: Provider,
  body: Record<string, unknown>,
): Record<string, unknown> {
  switch (provider) {
    case "anthropic": {
      // Merged, so a structured-output format in the same block survives.
      const outputConfig = (body["output_config"] ?? {}) as Record<string, unknown>;
      return { ...body, output_config: { ...outputConfig, effort: LOW_EFFORT } };
    }
    case "openai":
      // The Responses API nests it. Chat Completions takes it flat.
      return "input" in body
        ? { ...body, reasoning: { effort: LOW_EFFORT } }
        : { ...body, reasoning_effort: LOW_EFFORT };
    case "google": {
      // Gemini 3 takes thinkingLevel and 2.5 takes thinkingBudget. Sending both
      // is a 400, so only thinkingLevel goes out, and a model that rejects it
      // gets the retry without any setting.
      const generationConfig = (body["generationConfig"] ?? {}) as Record<string, unknown>;
      return {
        ...body,
        generationConfig: { ...generationConfig, thinkingConfig: { thinkingLevel: LOW_EFFORT } },
      };
    }
  }
}

/**
 * Posts with the low-effort setting, then without it if the provider answers
 * 400. Support varies by model, and some models take no effort setting at all.
 * A 400 for any other reason fails again on the retry, and that second error
 * is the one raised.
 *
 * JSON-mode calls, which include every extraction, never get the setting. One
 * extraction-tier model rejects it outright, which would cost a failed request
 * before every extraction.
 */
async function postWithLowEffort(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  jsonMode: boolean,
  deadlineAt?: number,
) {
  if (jsonMode) return post(url, headers, body, deadlineAt);
  try {
    return await post(url, headers, applyLowEffort(provider, body), deadlineAt);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 400) {
      return post(url, headers, body, deadlineAt);
    }
    throw err;
  }
}

/**
 * `deadlineAt` is a wall-clock budget shared by every request in one logical
 * call, so resuming a paused turn cannot extend it. A task stays locked until
 * its call returns, and reapStuckTasks reclaims a lock held past the
 * stale-lock window, which logic/types derives from the longest call budget.
 * A resume with its own full timeout could outlast that window, be reclaimed
 * mid-flight, and be paid for twice.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  deadlineAt: number = Date.now() + TIMEOUT_MS,
) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new ProviderError(
      "DEADLINE_EXCEEDED: no time left for this call",
      0,
      "DEADLINE_EXCEEDED",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        scrubError(`HTTP ${res.status}: ${text}`),
        res.status,
        failureCode("HTTP", res.status),
      );
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const message = String((err as Error)?.message ?? err);
    // An abort does not say which budget expired, and its wording varies by
    // runtime, so the message records the elapsed time and the budget.
    if (controller.signal.aborted) {
      throw new ProviderError(
        `TIMEOUT after ${Date.now() - startedAt}ms of a ${remaining}ms budget: ${scrubError(message)}`,
        0,
        "TIMEOUT",
      );
    }
    throw new ProviderError(scrubError(message), 0, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

function totalOf(input: number | null, output: number | null): number | null {
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

type ChatCompletion = {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    num_search_queries?: number;
  };
};

function fromChatCompletion(json: unknown, searchCalls = 0): ProviderResult {
  const data = json as ChatCompletion;
  const text = data.choices?.[0]?.message?.content ?? "";
  const inputTokens = data.usage?.prompt_tokens ?? null;
  const outputTokens = data.usage?.completion_tokens ?? null;
  return {
    text,
    inputTokens,
    outputTokens,
    tokens: data.usage?.total_tokens ?? totalOf(inputTokens, outputTokens),
    searchCalls: data.usage?.num_search_queries ?? searchCalls,
    truncated: data.choices?.[0]?.finish_reason === "length",
    model: data.model,
  };
}

/** Shared by run answers and the setup-check probe, so the probe keeps the run's request shape. */
const ANTHROPIC_FORCED_SEARCH = { type: "tool", name: "web_search" } as const;

/**
 * Whether an Anthropic model accepts a forced tool_choice. Claude Opus 5.5,
 * Claude Sonnet 5.5 and the Fable and Mythos models answer tool_choice "tool"
 * or "any" with a 400. They are offered the search tool unforced, and a JSON
 * shape is enforced with output_config.format instead of a forced tool.
 */
export function anthropicAcceptsForcedTools(modelId: string): boolean {
  return !/claude-(opus-5-5|sonnet-5-5|fable|mythos)/.test(modelId);
}

/**
 * Whether the request can force a web search: OpenAI's tool_choice "required",
 * and Anthropic's forced tool on the models that accept one. Gemini's grounding
 * tool has no force mode. A model that cannot be forced can skip the search,
 * so a retry after NO_WEB_SEARCH presses it in words (see pass.ts).
 */
export function canForceSearch(provider: string, modelId: string): boolean {
  // Neither command line tool takes a forced tool choice.
  if (providerCli(provider)) return false;
  if (provider === "openai") return true;
  if (provider === "anthropic") return anthropicAcceptsForcedTools(modelId);
  return false;
}

/**
 * The web search tool version depends on the model generation.
 *
 * `allowed_callers: ["direct"]` makes the tool forcible: web_search_20260209
 * defaults to calls through code execution, and tool_choice rejects a tool
 * that does not allow direct calls. Models without programmatic tool calling
 * also reject a forced search without it. The cost is no dynamic filtering,
 * so more input tokens per answer. Forcing, on the models that accept it, is
 * worth it because a model offered the tool can skip it and answer from memory.
 */
function anthropicSearchTool(modelId: string) {
  const modern = /claude-(sonnet-5|opus-5|haiku-4-5)/.test(modelId);
  return {
    type: modern ? "web_search_20260209" : "web_search_20250305",
    name: "web_search",
    max_uses: MAX_SEARCHES,
    allowed_callers: ["direct"],
  };
}

type ResponsesApi = {
  output?: Array<{
    type?: string;
    status?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string }>;
    }>;
  }>;
  output_text?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

/**
 * Reads a Responses API reply. OpenAI serves the web search tool on
 * /v1/responses, not chat completions.
 *
 * The text is rebuilt from the message items instead of `output_text`, so each
 * block's `url_citation` annotations can be checked. A source cited only in an
 * annotation is appended beside its block, because extraction only credits a
 * link that appears in the answer.
 *
 * Only a search with status "completed" counts. An answer built on an
 * unfinished search is an answer from memory.
 */
function fromResponses(json: unknown): ProviderResult {
  const data = json as ResponsesApi;
  const items = data.output ?? [];
  const blocks = items
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === "output_text");
  const text =
    blocks.length > 0
      ? blocks
          .map((c) => {
            const body = c.text ?? "";
            const missing = (c.annotations ?? []).filter((a) => a.url && !body.includes(a.url));
            return withCitations(body, missing);
          })
          .join("\n")
      : (data.output_text ?? "");
  const inputTokens = data.usage?.input_tokens ?? null;
  const outputTokens = data.usage?.output_tokens ?? null;
  return {
    text,
    inputTokens,
    outputTokens,
    tokens: data.usage?.total_tokens ?? totalOf(inputTokens, outputTokens),
    searchCalls: items.filter(
      (item) => item.type === "web_search_call" && item.status === "completed",
    ).length,
    truncated:
      data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens",
    model: data.model,
  };
}

export interface CallProviderArgs {
  provider: Provider;
  modelId: string;
  apiKey: string;
  system: string;
  user: string;
  jsonMode: boolean;
  /**
   * The JSON shape the reply must match, enforced the provider's own way:
   * OpenAI strict structured outputs, a Gemini response schema, an Anthropic
   * forced tool whose input schema is the shape. Implies jsonMode. Cannot be
   * combined with webSearch.
   */
  jsonSchema?: EnforcedShape | undefined;
  /** Set on every answer, never on an extraction-family call. */
  webSearch?: boolean | undefined;
  maxTokens?: number | undefined;
  /**
   * Wall-clock budget for the whole logical call, including Anthropic's
   * pause-turn resumes. The pass raises it through timeoutForRetry after a
   * timeout.
   */
  timeoutMs?: number | undefined;
}

export async function callProvider({
  provider,
  modelId,
  apiKey,
  system,
  user,
  jsonMode,
  jsonSchema,
  webSearch = false,
  maxTokens = ANSWER_MAX_TOKENS,
  timeoutMs = TIMEOUT_MS,
}: CallProviderArgs): Promise<ProviderResult> {
  // No provider can enforce a shape and search in one call. Gemini's JSON mode
  // refuses the grounding tool, and Anthropic cannot force the schema tool and
  // the search tool at once. No caller asks for both, so this fails loudly
  // instead of silently dropping one.
  if (jsonSchema && webSearch) {
    throw new ProviderError(
      "SCHEMA_WITH_SEARCH: a call cannot enforce a shape and search",
      400,
      "SCHEMA_WITH_SEARCH",
    );
  }
  // Checked before any request is built, so mock mode never makes a live HTTP
  // call. See mock-provider.ts.
  if (mockProvidersEnabled()) {
    return mockCallProvider({ provider, modelId, system, user, jsonMode });
  }
  // Checked before any request is built too, so subscription mode never sends
  // the placeholder key anywhere.
  const cli = providerCli(provider);
  if (cli) {
    return callThroughCli(cli, {
      modelId,
      system,
      user,
      jsonMode,
      jsonSchema,
      webSearch,
      timeoutMs,
    });
  }
  // One deadline for the whole logical call.
  const deadlineAt = Date.now() + timeoutMs;
  switch (provider) {
    case "openai": {
      if (webSearch) {
        const body: Record<string, unknown> = {
          model: modelId,
          instructions: system,
          input: user,
          tools: [{ type: "web_search" }],
          // "auto" lets the model skip the search and answer from training
          // data. The Responses API documents "required" as the way to force it.
          tool_choice: "required",
          max_output_tokens: maxTokens,
        };
        return fromResponses(
          await postWithLowEffort(
            provider,
            "https://api.openai.com/v1/responses",
            { authorization: `Bearer ${apiKey}` },
            body,
            jsonMode,
            deadlineAt,
          ),
        );
      }
      const body: Record<string, unknown> = {
        model: modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_completion_tokens: maxTokens,
      };
      if (jsonSchema) {
        // Strict structured outputs guarantee the reply matches the schema.
        // json_object only guarantees valid JSON of some shape.
        body["response_format"] = {
          type: "json_schema",
          json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true },
        };
      } else if (jsonMode) {
        body["response_format"] = { type: "json_object" };
      }
      return fromChatCompletion(
        await postWithLowEffort(
          provider,
          "https://api.openai.com/v1/chat/completions",
          { authorization: `Bearer ${apiKey}` },
          body,
          jsonMode,
          deadlineAt,
        ),
      );
    }
    case "anthropic": {
      type AnthropicMessage = {
        // A web_search_tool_result's content is a list when the search worked
        // and an object with an error_code when it did not. Both arrive as
        // HTTP 200.
        content?: Array<{
          type: string;
          text?: string;
          content?: unknown;
          // A forced schema tool answers as a tool_use block: the JSON is the
          // block's input, already parsed, and there is no text block.
          name?: string;
          input?: unknown;
          // Web search citations ride on the text block, never inside the text.
          citations?: Array<{ type?: string; url?: string }>;
        }>;
        stop_reason?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          server_tool_use?: { web_search_requests?: number };
        };
      };

      const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: user }];
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let searchCalls = 0;
      let stopReason: string | undefined;
      let reportedModel: string | undefined;

      // A server tool runs its own sampling loop. When that loop hits its
      // iteration limit, the turn returns stop_reason "pause_turn": HTTP 200,
      // billed, and often with no text. It is resumed by sending the
      // conversation back with the paused assistant turn appended and no new
      // user message. The API recognises the trailing server_tool_use block.
      for (let turn = 0; turn <= PAUSE_RESUME_LIMIT; turn += 1) {
        const body: Record<string, unknown> = {
          model: modelId,
          max_tokens: maxTokens,
          system,
          messages,
        };
        const forcible = anthropicAcceptsForcedTools(modelId);
        if (webSearch) {
          body["tools"] = [anthropicSearchTool(modelId)];
          // Forced on the first turn only. A resume continues a conversation
          // whose search already ran, and forcing there would pay for another
          // search on every resume and risk a pause loop.
          if (turn === 0 && forcible) body["tool_choice"] = { ...ANTHROPIC_FORCED_SEARCH };
        }
        if (jsonSchema && !webSearch && forcible) {
          // Forced tool use is Anthropic's shape enforcement: the schema is
          // the tool's input schema and tool_choice leaves the model no other
          // move. The JSON arrives as that tool_use block's input.
          body["tools"] = [
            {
              name: jsonSchema.name,
              description:
                jsonSchema.description ??
                "Return the extraction as this tool's input, with no other output.",
              input_schema: jsonSchema.schema,
            },
          ];
          body["tool_choice"] = { type: "tool", name: jsonSchema.name };
        } else if (jsonSchema && !webSearch) {
          // Structured output for a model that rejects forced tools. The JSON
          // arrives as the reply's text block.
          body["output_config"] = { format: { type: "json_schema", schema: jsonSchema.schema } };
        }
        const json = (await postWithLowEffort(
          provider,
          "https://api.anthropic.com/v1/messages",
          { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body,
          jsonMode,
          deadlineAt,
        )) as AnthropicMessage;

        // Every turn is billed, so usage accumulates across resumes.
        inputTokens += json.usage?.input_tokens ?? 0;
        outputTokens += json.usage?.output_tokens ?? 0;
        // A result block carrying a list is a search that ran. Usage normally
        // reports the same count, and the larger of the two is taken.
        const ranHere = (json.content ?? []).filter(
          (c) => c.type === "web_search_tool_result" && Array.isArray(c.content),
        ).length;
        searchCalls += Math.max(json.usage?.server_tool_use?.web_search_requests ?? 0, ranHere);
        // Joined with nothing: a new text block starts wherever the model cites
        // a search result, so consecutive blocks are fragments of one sentence.
        // Real paragraph breaks sit inside a block's own text.
        text += (json.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => {
            const body = c.text ?? "";
            // The answer prompt asks for source URLs, so a block can carry the
            // same URL inline and as a citation. Only the ones missing from the
            // text are appended, as in fromResponses.
            const missing = (c.citations ?? []).filter((cit) => cit.url && !body.includes(cit.url));
            return withCitations(body, missing);
          })
          .join("");
        // A forced schema tool answers with no text block. Its JSON is the
        // tool_use block's input, already parsed, so it is serialised back and
        // the text is the JSON on every provider.
        if (jsonSchema) {
          const toolUse = (json.content ?? []).find(
            (c) => c.type === "tool_use" && c.name === jsonSchema.name,
          );
          if (toolUse && toolUse.input !== undefined) text += JSON.stringify(toolUse.input);
        }
        stopReason = json.stop_reason;
        reportedModel = json.model ?? reportedModel;

        const searchFailure = webSearchFailure(json.content);
        if (searchFailure) {
          // An answer written without search is not what a run measures. It
          // reads like a normal answer, and stored it would turn mention rates
          // into a survey of the model's training data. max_uses_exceeded
          // will not change on a retry, so it is a 400. Any other code is
          // retried as a 429. The usage so far rides along because it was
          // billed, and the pass logs the real spend from the error.
          throw new ProviderError(
            `WEB_SEARCH_FAILED: ${searchFailure}`,
            searchFailure === "max_uses_exceeded" ? 400 : 429,
            failureCode("WEB_SEARCH_FAILED", searchFailure),
            { inputTokens, outputTokens, searchCalls },
          );
        }

        if (stopReason !== "pause_turn") break;
        messages.push({ role: "assistant", content: json.content ?? [] });
      }

      return {
        text,
        inputTokens,
        outputTokens,
        tokens: totalOf(inputTokens, outputTokens),
        searchCalls,
        stopReason,
        truncated: stopReason === "max_tokens",
        model: reportedModel,
      };
    }
    case "google": {
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(jsonMode || jsonSchema ? { responseMimeType: "application/json" } : {}),
          // Controlled generation: the reply is constrained to the schema, in
          // Gemini's own dialect (uppercase types, `nullable` as a keyword).
          ...(jsonSchema ? { responseSchema: toGeminiResponseSchema(jsonSchema.schema) } : {}),
        },
      };
      // Gemini cannot combine JSON mode with tools.
      if (webSearch && !jsonMode) body["tools"] = [{ googleSearch: {} }];
      // The key goes in a header, not the query string. Google accepts both,
      // but a URL ends up in access logs, proxies and any error that echoes the
      // request line.
      const json = (await postWithLowEffort(
        provider,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
        { "x-goog-api-key": apiKey },
        body,
        jsonMode,
        deadlineAt,
      )) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          groundingMetadata?: GeminiGrounding;
          finishReason?: string;
        }>;
        usageMetadata?: {
          totalTokenCount?: number;
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
        modelVersion?: string;
      };
      const candidate = json.candidates?.[0];
      const text = withGroundingCitations(
        (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
        candidate?.groundingMetadata,
      );
      const inputTokens = json.usageMetadata?.promptTokenCount ?? null;
      const outputTokens = json.usageMetadata?.candidatesTokenCount ?? null;
      return {
        text,
        inputTokens,
        outputTokens,
        tokens: json.usageMetadata?.totalTokenCount ?? totalOf(inputTokens, outputTokens),
        searchCalls: candidate?.groundingMetadata?.webSearchQueries?.length ?? 0,
        truncated: candidate?.finishReason === "MAX_TOKENS",
        model: json.modelVersion,
      };
    }
  }
}

/**
 * A subscription-mode failure as the ProviderError the worker records. A
 * missing or signed-out tool cannot fix itself, so it is not retried. A plan
 * at its limit is retried with the worker's backoff, like a 429.
 */
function cliProviderError(provider: Provider, failure: CliFailure): ProviderError {
  const message = scrubError(failure.message);
  switch (failure.kind) {
    case "sign_in":
      return new ProviderError(
        `CLI_SIGN_IN: ${message}`,
        401,
        failureCode("CLI_SIGN_IN", provider),
      );
    case "plan_limit":
      return new ProviderError(`PLAN_LIMIT: ${message}`, 429, failureCode("PLAN_LIMIT", provider));
    case "timeout":
      return new ProviderError(`TIMEOUT ${message}`, 0, "TIMEOUT");
    case "refused":
      return new ProviderError(
        `HTTP ${failure.status}: ${message}`,
        failure.status,
        failureCode("HTTP", failure.status),
      );
    case "failed":
      return new ProviderError(`CLI_FAILED: ${message}`, 0, "UNEXPECTED");
  }
}

async function callThroughCli(
  target: CliTarget,
  call: {
    modelId: string;
    system: string;
    user: string;
    jsonMode: boolean;
    jsonSchema: EnforcedShape | undefined;
    webSearch: boolean;
    timeoutMs: number;
  },
): Promise<ProviderResult> {
  const outcome = await callCli({ target, ...call });
  if (outcome.ok) return outcome.result;
  throw cliProviderError(target.provider, outcome.failure);
}

/**
 * A probe's failure as a verdict. Subscription mode's own two failures get
 * sentences about the command and the plan, and everything else the
 * provider's API wording.
 */
function probeVerdict(provider: Provider, err: unknown): SearchCheckResult {
  const raw = (err as { status?: unknown } | null)?.status;
  const status = typeof raw === "number" ? raw : 0;
  const message = scrubError((err as Error | null)?.message ?? "");
  const base = err instanceof ProviderError ? failureCodeBase(err.code) : null;
  if (isCliProvider(provider) && base === "CLI_SIGN_IN") return cliNotReady(provider, message);
  if (isCliProvider(provider) && base === "PLAN_LIMIT") return planLimited(provider, message);
  return classifySearchFailure(provider, status, message);
}

/** Injected so the extractor probe's orchestration is unit-testable with no network. */
export type ProviderPing = (
  provider: Provider,
  modelId: string,
  apiKey: string,
) => Promise<unknown>;

/**
 * Every call made with the project's extraction model goes through here:
 * extraction, perception merges and paid prose summaries. So does starter
 * prompt generation, the other call that never searches, whichever tier its
 * model is. It resolves the key, never searches, and fails with a typed error
 * when the provider has no adapter or no key. jsonMode defaults to on. The
 * prose-summary caller turns it off.
 */
export async function callExtractionModel(
  model: { provider: string; model_id: string },
  system: string,
  user: string,
  options: {
    jsonMode?: boolean | undefined;
    maxTokens?: number | undefined;
    jsonSchema?: EnforcedShape | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<ProviderResult> {
  const provider = supportedProvider(model.provider);
  if (!provider) {
    throw new ProviderError(
      `UNSUPPORTED_PROVIDER:${model.provider}`,
      400,
      failureCode("UNSUPPORTED_PROVIDER", model.provider),
    );
  }
  // Under the mock seam this is a placeholder key, and callProvider returns
  // before any request is built.
  const apiKey = resolveProviderKey(provider);
  if (!apiKey) {
    throw new ProviderError(
      `MISSING_CREDENTIAL:${provider}`,
      400,
      failureCode("MISSING_CREDENTIAL", provider),
    );
  }
  return callProvider({
    provider,
    modelId: model.model_id,
    apiKey,
    system,
    user,
    jsonMode: options.jsonSchema ? true : (options.jsonMode ?? true),
    jsonSchema: options.jsonSchema,
    webSearch: false,
    maxTokens: options.maxTokens ?? EXTRACTION_MAX_TOKENS,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Checks one extractor model with a short call shaped like a run's
 * extraction: the run's system prompt, the enforced schema, no web search. A
 * probe without the real prompt would pass a call that a long custom prompt
 * then fails, and one without the schema would pass a model that refuses it.
 * A clean resolve proves the key authenticates and has credit. Failures map to
 * the search probe's reason codes (see lib/setup-check). The key is read here
 * and never returned.
 */
export async function extractorCheck(
  provider: Provider,
  modelId: string,
  ping?: ProviderPing | undefined,
  systemPrompt: string = EXTRACTION_SYSTEM,
): Promise<SearchCheckResult> {
  if (mockProvidersEnabled()) return searchMocked();

  const apiKey = resolveProviderKey(provider);
  if (!apiKey) return searchNoKey(provider);

  const doPing: ProviderPing =
    ping ??
    ((p, m, k) =>
      callProvider({
        provider: p,
        modelId: m,
        apiKey: k,
        system: systemPrompt,
        user: "hi",
        jsonMode: true,
        jsonSchema: EXTRACTION_SHAPE,
        webSearch: false,
        maxTokens: EXTRACTION_PROBE_MAX_TOKENS,
      }));

  try {
    await doPing(provider, modelId, apiKey);
    return extractorOk();
  } catch (err) {
    return probeVerdict(provider, err);
  }
}

/* ------------------------------------------------------------ search probe */

/**
 * One short question, so the probe costs a search fee and a few tokens. Only a
 * live search can answer it, so a model that skips the tool cannot pass from
 * memory.
 */
const SEARCH_CHECK_PROMPT =
  "Search the web, then answer in one short sentence: what is the top world news headline right now?";
/**
 * Output cap for the probe. A thinking model can spend a few hundred tokens
 * reasoning, and a reply cut off before any grounding data exists reads as
 * "did not search". The prompt asks for one short sentence, so 1024 still
 * costs a fraction of a cent.
 */
const SEARCH_CHECK_MAX_TOKENS = 1024;

/**
 * Checks that web search works for one key and model: one small request that
 * must search, and evidence of a completed search in the response. Failures
 * map to a reason code with a fix hint (see lib/setup-check). The key is read
 * here and never returned. The request mirrors a run answer's shape, including
 * Anthropic's forced tool, so a passing check predicts a passing run.
 *
 * Evidence per provider: OpenAI a `web_search_call` item with status
 * "completed", Anthropic a `web_search_tool_result` block or billed searches
 * in usage unless every search failed, Google
 * `groundingMetadata.webSearchQueries`. In subscription mode the probe is a
 * run answer's own call through the command, and the evidence is the search
 * count the command's output shows (see cli-provider.ts).
 */
export async function searchCheck(
  provider: Provider,
  modelId: string,
  apiKey?: string | undefined,
): Promise<SearchCheckResult> {
  if (mockProvidersEnabled()) return searchMocked();
  const cli = providerCli(provider);
  if (cli) {
    try {
      const res = await callThroughCli(cli, {
        modelId,
        system: "Search the web before you answer.",
        user: SEARCH_CHECK_PROMPT,
        jsonMode: false,
        jsonSchema: undefined,
        webSearch: true,
        timeoutMs: TIMEOUT_MS,
      });
      return res.searchCalls > 0
        ? planSearchOk(cli.provider)
        : searchNotPerformed(provider, { answerSnippet: scrubError(res.text).slice(0, 140) });
    } catch (err) {
      return probeVerdict(provider, err);
    }
  }
  const key = apiKey ?? resolveProviderKey(provider);
  if (!key) return searchNoKey(provider);

  try {
    switch (provider) {
      case "openai": {
        const json = (await post(
          "https://api.openai.com/v1/responses",
          {
            authorization: `Bearer ${key}`,
          },
          {
            model: modelId,
            input: SEARCH_CHECK_PROMPT,
            tools: [{ type: "web_search", search_context_size: "low" }],
            tool_choice: "required",
            max_output_tokens: SEARCH_CHECK_MAX_TOKENS,
          },
        )) as { status?: string; output?: Array<{ type?: string; status?: string }> };
        const searched = (json.output ?? []).some(
          (item) => item.type === "web_search_call" && item.status === "completed",
        );
        return searched
          ? searchOk(provider)
          : searchNotPerformed(provider, { truncated: json.status === "incomplete" });
      }
      case "anthropic": {
        const body: Record<string, unknown> = {
          model: modelId,
          max_tokens: SEARCH_CHECK_MAX_TOKENS,
          messages: [{ role: "user", content: SEARCH_CHECK_PROMPT }],
          // max_uses 1: the probe needs one search. The forced tool_choice, on
          // the models that accept it, and the direct-caller form mirror the
          // run's request.
          tools: [{ ...anthropicSearchTool(modelId), max_uses: 1 }],
          ...(anthropicAcceptsForcedTools(modelId)
            ? { tool_choice: { ...ANTHROPIC_FORCED_SEARCH } }
            : {}),
        };
        const json = (await post(
          "https://api.anthropic.com/v1/messages",
          {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body,
        )) as {
          content?: Array<{ type: string; content?: unknown }>;
          stop_reason?: string;
          usage?: { server_tool_use?: { web_search_requests?: number } };
        };
        const failure = webSearchFailure(json.content);
        if (failure) return searchFailed(provider, failure);
        const searched =
          (json.content ?? []).some((block) => block.type === "web_search_tool_result") ||
          (json.usage?.server_tool_use?.web_search_requests ?? 0) > 0;
        return searched
          ? searchOk(provider)
          : searchNotPerformed(provider, { truncated: json.stop_reason === "max_tokens" });
      }
      case "google": {
        const json = (await post(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
          { "x-goog-api-key": key },
          {
            contents: [{ parts: [{ text: SEARCH_CHECK_PROMPT }] }],
            tools: [{ googleSearch: {} }],
            generationConfig: { maxOutputTokens: SEARCH_CHECK_MAX_TOKENS },
          },
        )) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            finishReason?: string;
            groundingMetadata?: { webSearchQueries?: string[] };
          }>;
        };
        const candidate = json.candidates?.[0];
        const searched = (candidate?.groundingMetadata?.webSearchQueries ?? []).length > 0;
        if (searched) return searchOk(provider);
        // A reply cut off at MAX_TOKENS by its own thinking differs from one
        // that answered from memory, and the snippet shows the user which.
        const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");
        return searchNotPerformed(provider, {
          truncated: candidate?.finishReason === "MAX_TOKENS",
          answerSnippet: text ? scrubError(text).slice(0, 140) : undefined,
        });
      }
    }
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : 0;
    const message = err instanceof Error ? err.message : String(err);
    return classifySearchFailure(provider, status, scrubError(message));
  }
}

/**
 * The catalogue's current mid-tier search-capable model for a provider: what
 * the diagnostics script probes when no model is named. Frontier models cost
 * more per search-check and extraction models cannot search at all.
 */
export function searchCheckModelId(provider: Provider): string | null {
  const candidates = CATALOGUE.filter(
    (model) => model.provider === provider && model.supports_web_search && !model.superseded,
  );
  return (candidates.find((model) => model.tier === "mid") ?? candidates[0])?.model_id ?? null;
}
