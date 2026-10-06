/**
 * Diagnostics: check that web search works for each configured provider key,
 * with the same probe the app's setup check uses.
 *
 *   npm run check:search                     # every provider with a key
 *   npm run check:search -- openai anthropic # only these providers
 *   npm run check:search -- anthropic:claude-opus-5-5   # a specific model
 *   OVERHEARD_MOCK_PROVIDERS=1 npm run check:search   # mock providers answer
 *
 * Keys are read from the environment and from ./.env, and never printed. Each
 * passing OpenAI or Anthropic probe costs about one cent (one web search).
 * Gemini probes are free inside the paid-tier allowance and fail outright on
 * the free tier, which this script also catches.
 *
 * The Anthropic probe mirrors the run's request shape: the search tool in the
 * direct-caller form, forced via tool_choice on the models that accept it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { searchCheck, searchCheckModelId } from "../src/server/worker/providers";
import { PROVIDERS, PROVIDER_KEY_ENV, providerCli } from "../src/server/worker/keys";
import { mockProvidersEnabled } from "../src/server/worker/mock-provider";
import type { Provider } from "../src/server/db/types";
import type { SearchCheckResult } from "../src/lib/setup-check";

function loadDotEnv(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, name = "", rawValue = ""] = match;
      if (process.env[name]) continue; // the real environment wins
      const value = rawValue.replace(/^["']|["']$/g, "");
      if (value) process.env[name] = value;
    }
  } catch {
    // No .env is fine. The environment alone may carry the keys.
  }
}

/**
 * Whether a probe is worth sending. Under OVERHEARD_MOCK_PROVIDERS=1
 * searchCheck reports "mocked" for every provider, so the probe path runs with
 * no keys and no network, which is how CI exercises it. Otherwise a provider
 * with no key is skipped.
 */
function hasKey(provider: Provider): boolean {
  if (mockProvidersEnabled() || providerCli(provider)) return true;
  return PROVIDER_KEY_ENV[provider].some((name) => (process.env[name] ?? "").trim() !== "");
}

interface Target {
  provider: Provider;
  modelId: string;
}

function parseTargets(argv: string[]): Target[] {
  const explicit: Target[] = [];
  const wanted: Provider[] = [];
  for (const arg of argv) {
    const [provider, model] = arg.split(":") as [string, string | undefined];
    if (!PROVIDERS.includes(provider as Provider)) {
      console.error(
        `Unknown provider "${arg}". Expected openai, anthropic or google, optionally as provider:model.`,
      );
      process.exit(2);
    }
    const p = provider as Provider;
    if (model) explicit.push({ provider: p, modelId: model });
    else wanted.push(p);
  }
  const providers = wanted.length > 0 ? wanted : [...PROVIDERS];
  for (const provider of providers) {
    if (explicit.some((t) => t.provider === provider)) continue;
    const modelId = searchCheckModelId(provider);
    if (modelId) explicit.push({ provider, modelId });
  }
  return explicit;
}

function line(label: string, res: SearchCheckResult): void {
  const mark = res.status === "ok" || res.status === "mocked" ? "PASS" : "FAIL";
  console.log(`\n[${mark}] ${label} → ${res.status}`);
  console.log(`  ${res.message}`);
  if (res.hint) console.log(`  Fix: ${res.hint}`);
  if (res.detail && res.status !== "ok")
    console.log(`  Provider said: ${res.detail.slice(0, 300)}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const targets = parseTargets(process.argv.slice(2));
  let failures = 0;

  for (const { provider, modelId } of targets) {
    if (!hasKey(provider)) {
      console.log(`\n[SKIP] ${provider} (${modelId}): no key in the environment or .env`);
      continue;
    }
    const res = await searchCheck(provider, modelId);
    line(`${provider} · ${modelId}`, res);
    if (res.status !== "ok" && res.status !== "mocked") failures += 1;
  }

  console.log(
    failures === 0
      ? "\nAll checked providers can search the web."
      : `\n${failures} check(s) failed. The "Fix" lines say where to change what.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
