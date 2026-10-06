// Pure verdict logic for the setup check's web-search probe. No network, no
// server imports, so it is safe to use from the browser and unit-testable in
// node. The probe call itself runs server side (searchCheck in
// src/server/worker/providers.ts); a key value never reaches this module.
//
// Reason codes and the provider error shapes behind them come from the
// providers' own documentation (OpenAI error codes, Anthropic API errors and
// the web search tool page, Gemini API errors). Where a shape is not
// documented, the mapping is marked and needs confirming against a real key.

import { type CliProvider, keyEnvNames, PROVIDER_CLI } from "./provider-keys";
import type { Provider } from "@/server/db/types";

export type SearchCheckStatus =
  | "ok"
  | "mocked"
  | "invalid_key"
  | "no_credits"
  | "billing_not_enabled"
  | "search_disabled"
  | "model_unavailable"
  | "rate_limited"
  | "provider_unavailable"
  | "region_unsupported"
  | "search_failed"
  | "search_not_performed"
  | "no_key"
  | "unknown";

export interface SearchCheckResult {
  status: SearchCheckStatus;
  /** One sentence for the user. */
  message: string;
  /** Where to fix it, when the user can. */
  hint?: string | undefined;
  /** The provider's own (scrubbed) error text, for diagnosis. Never a key. */
  detail?: string | undefined;
}

const HINTS: Partial<Record<Provider, Record<string, string>>> = {
  openai: {
    invalid_key: "Check the key at platform.openai.com/settings/organization/api-keys.",
    no_credits:
      "Add credit or raise the spend limit at platform.openai.com/settings/organization/billing.",
    search_disabled:
      "Ask your OpenAI organization admin to allow the web search tool for this project (project settings → tools).",
    model_unavailable:
      "Pick a different model, or check which models this account can use at platform.openai.com/settings.",
    search_not_performed:
      "The check forces OpenAI to search, so this is rare. Run the check again; if it repeats, the web search tool may be blocked for this project.",
  },
  anthropic: {
    invalid_key: "Check the key at console.anthropic.com/settings/keys.",
    no_credits: "Add credit at console.anthropic.com/settings/plans.",
    search_disabled:
      "An organization admin has switched web search off. Turn it on in the Claude Console under Settings → Privacy.",
    model_unavailable:
      "Pick a different model, or check your workspace's model access in the Claude Console.",
    search_not_performed:
      "The model can decline to search. Run the check again; if it keeps happening, web search may be restricted for this account.",
  },
  google: {
    invalid_key: "Check the key at aistudio.google.com/apikey.",
    no_credits: "Add credit or check billing at aistudio.google.com/billing.",
    billing_not_enabled:
      "Gemini's free tier cannot search the web. Link a billing account: aistudio.google.com/projects, then Upgrade.",
    model_unavailable:
      "Pick a different model, or check which models are enabled for this project in Google AI Studio.",
    search_not_performed:
      "Gemini decides for itself whether to search. Run the check again; if it keeps failing, the Google Search tool may not be available to this project.",
  },
};

function result(
  provider: Provider,
  status: SearchCheckStatus,
  message: string,
  detail?: string,
): SearchCheckResult {
  const hint = HINTS[provider]?.[status];
  return hint ? { status, message, hint, detail } : { status, message, detail };
}

/**
 * Map a probe failure (HTTP status + already-scrubbed provider text) to a
 * verdict. Reads both status and message because the providers disagree: a
 * dead key is 401 on OpenAI and Anthropic but a 400 "API key not valid" on
 * Google; "no money" is 429 credit_balance_exhausted on OpenAI, a 400 "credit
 * balance is too low" on Anthropic and a 402 or a 400 failed_precondition on
 * Google. Defaults to a non-passing verdict when unsure.
 */
export function classifySearchFailure(
  provider: Provider,
  status: number,
  message: string,
): SearchCheckResult {
  const m = message.toLowerCase();
  const detail = message.length > 400 ? `${message.slice(0, 400)}…` : message;

  if (status === 0 || status >= 500 || status === 529) {
    return result(
      provider,
      "provider_unavailable",
      "The provider is overloaded or unreachable. Try again in a moment.",
      detail,
    );
  }

  switch (provider) {
    case "anthropic": {
      // Documented wording: a request with the tool fails 400
      // invalid_request_error "web search is not enabled" when an org admin
      // has switched it off in Console → Settings → Privacy.
      if (status === 400 && /web ?search is not enabled|web_search.*not enabled/.test(m)) {
        return result(
          provider,
          "search_disabled",
          "Web search is switched off for this Anthropic organization.",
          detail,
        );
      }
      if (status === 400 && /credit balance is too low/.test(m)) {
        return result(
          provider,
          "no_credits",
          "The key works, but the account's credit balance is too low.",
          detail,
        );
      }
      if (status === 401)
        return result(provider, "invalid_key", "That Anthropic key was rejected.", detail);
      if (status === 403) {
        return /region|country|location/.test(m)
          ? result(
              provider,
              "region_unsupported",
              "Anthropic is not available in this region.",
              detail,
            )
          : result(
              provider,
              "invalid_key",
              "That Anthropic key does not have permission for this.",
              detail,
            );
      }
      if (status === 404)
        return result(
          provider,
          "model_unavailable",
          "This account cannot use that Anthropic model.",
          detail,
        );
      if (status === 429)
        return result(
          provider,
          "rate_limited",
          "Anthropic is rate-limiting right now. Try again in a moment.",
          detail,
        );
      break;
    }
    case "openai": {
      if (status === 401)
        return result(provider, "invalid_key", "That OpenAI key was rejected.", detail);
      if (status === 403) {
        return /country|region|territory/.test(m)
          ? result(
              provider,
              "region_unsupported",
              "OpenAI is not available in this country or region.",
              detail,
            )
          : result(
              provider,
              "invalid_key",
              "That OpenAI key does not have permission for this.",
              detail,
            );
      }
      if (status === 404 && /model/.test(m)) {
        return result(
          provider,
          "model_unavailable",
          "This account cannot use that OpenAI model.",
          detail,
        );
      }
      if (status === 429) {
        if (/credit_balance_exhausted|insufficient_quota|exceeded your current quota/.test(m)) {
          return result(
            provider,
            "no_credits",
            "The key works, but the organization has no credit left.",
            detail,
          );
        }
        if (/spend_limit_exceeded|usage_limit_exceeded/.test(m)) {
          return result(
            provider,
            "no_credits",
            "A spend or usage limit is reached for this organization or project.",
            detail,
          );
        }
        return result(
          provider,
          "rate_limited",
          "OpenAI is rate-limiting right now. Try again in a moment.",
          detail,
        );
      }
      // NOT documented by OpenAI (error-codes guide has no entry). Heuristic:
      // a 400 naming the tool or a hosted-tool permission is most likely the
      // org/project tool policy. To confirm with a real key.
      if (status === 400 && /web_?search|hosted tool|tool.*(not allowed|disabled|denied)/.test(m)) {
        return result(
          provider,
          "search_disabled",
          "Web search appears to be blocked for this OpenAI project.",
          detail,
        );
      }
      break;
    }
    case "google": {
      if (status === 400) {
        if (/api key not valid|api_key_invalid|invalid_api_key/.test(m)) {
          return result(provider, "invalid_key", "That Google key was rejected.", detail);
        }
        // Documented: grounding on a project without billing is a 400
        // failed_precondition ("for example, disabled billing").
        if (/billing|failed_precondition|precondition/.test(m)) {
          return result(
            provider,
            "billing_not_enabled",
            "This Google project cannot search the web, because billing is not enabled and the free tier has no search.",
            detail,
          );
        }
        if (/location|region|not supported/.test(m)) {
          return result(
            provider,
            "region_unsupported",
            "The Gemini API is not available in this region.",
            detail,
          );
        }
        break;
      }
      if (status === 401)
        return result(provider, "invalid_key", "That Google key was rejected.", detail);
      if (status === 402)
        return result(
          provider,
          "no_credits",
          "The key works, but the billing account's credit is depleted.",
          detail,
        );
      if (status === 403) {
        return result(
          provider,
          "invalid_key",
          /leaked/.test(m)
            ? "Google blocked this key because it was reported as leaked. Create a new one."
            : "That Google key does not have permission for this.",
          detail,
        );
      }
      if (status === 404)
        return result(
          provider,
          "model_unavailable",
          "This account cannot use that Gemini model.",
          detail,
        );
      if (status === 429)
        return result(
          provider,
          "rate_limited",
          "Google is rate-limiting or the quota is used up. Try again later.",
          detail,
        );
      break;
    }
  }

  return result(provider, "unknown", "The check failed in a way we could not classify.", detail);
}

/** 200 OK, but the response carries no evidence that a search ran. */
export function searchNotPerformed(
  provider: Provider,
  evidence: { truncated?: boolean | undefined; answerSnippet?: string | undefined } = {},
): SearchCheckResult {
  // A thinking model that spends its whole output budget on reasoning is cut
  // off before any grounding data exists (seen on Gemini). That is a
  // different situation from a model that chose to answer from memory, and
  // the user is told which one they hit.
  const message = evidence.truncated
    ? "The assistant's reply was cut off by its output-token limit before a search completed."
    : "The assistant answered without searching the web. It may not support search, or search may be restricted for this account.";
  const detailParts: string[] = [];
  if (evidence.truncated) detailParts.push("finish reason: output-token limit");
  if (evidence.answerSnippet) detailParts.push(`reply began: ${evidence.answerSnippet}`);
  return result(
    provider,
    "search_not_performed",
    message,
    detailParts.length > 0 ? detailParts.join(" · ") : undefined,
  );
}

/** 200 OK, and the provider reported the search itself failing. */
export function searchFailed(provider: Provider, code: string): SearchCheckResult {
  return result(
    provider,
    "search_failed",
    `The provider's web search failed: ${code}.`,
    `error_code: ${code}`,
  );
}

export function searchOk(provider: Provider): SearchCheckResult {
  return result(provider, "ok", "Web search works with this key and model.");
}

/** Subscription mode: the search ran through the provider's command, on the user's plan. */
export function planSearchOk(provider: CliProvider): SearchCheckResult {
  const cli = PROVIDER_CLI[provider];
  return {
    status: "ok",
    message: `Web search works through ${cli.command} on your ${cli.plan} plan.`,
  };
}

/** Subscription mode: the command could not be started, or is not signed in. */
export function cliNotReady(provider: CliProvider, detail: string): SearchCheckResult {
  const cli = PROVIDER_CLI[provider];
  return {
    status: "invalid_key",
    message: `The ${cli.command} command could not answer with your ${cli.plan} plan.`,
    hint: `Check ${cli.tool} is installed, then run ${cli.signIn} in a terminal and check again.`,
    detail,
  };
}

/** Subscription mode: the user's plan is at its usage limit. */
export function planLimited(provider: CliProvider, detail: string): SearchCheckResult {
  return {
    status: "rate_limited",
    message: `Your ${PROVIDER_CLI[provider].plan} plan is at its usage limit.`,
    hint: "Plans allow a set amount of use in each window of a few hours. Check again once it resets.",
    detail,
  };
}

/** The extractor answers a plain call: no search involved, so no search claim. */
export function extractorOk(): SearchCheckResult {
  return { status: "ok", message: "This model answered a short test call." };
}

/** A provider with no search-capable model in the catalog cannot be probed. */
export function noSearchCapableModel(provider: Provider): SearchCheckResult {
  return {
    status: "model_unavailable",
    message: `No search-capable ${provider} model is in the catalog, so nothing was checked.`,
  };
}

export function searchMocked(): SearchCheckResult {
  return {
    status: "mocked",
    message: "Mock providers are on, so nothing was checked and no key was used.",
  };
}

export function searchNoKey(provider: Provider): SearchCheckResult {
  return result(
    provider,
    "no_key",
    `No ${provider} key is configured, so nothing was checked. Add ${keyEnvNames(provider)} to your .env file and check again.`,
  );
}

/**
 * Whether a whole setup-check report passes: every row ok, or mocked under the
 * offline seam, where there is nothing to check and a blocked screen would be
 * a dead end. Anything else, including a row we could not classify, keeps the
 * gate shut, and so does an empty report, where nothing was checked at all.
 */
export function allRowsPassed(rows: readonly { result: { status: SearchCheckStatus } }[]): boolean {
  return (
    rows.length > 0 &&
    rows.every((row) => row.result.status === "ok" || row.result.status === "mocked")
  );
}
