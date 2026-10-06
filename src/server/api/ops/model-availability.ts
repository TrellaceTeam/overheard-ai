/**
 * Which catalogue models each provider key can use. A key can lack access to
 * a model the catalogue offers, for example a newer model on an account tier
 * that has not been granted it, and a run on that model would fail on every
 * call.
 *
 * Only catalogue models are reported. A model the provider lists but the
 * catalogue lacks is not offered, because nothing has checked that it
 * searches and answers in the shape a run expects.
 */
import { createHash } from "node:crypto";
import type { Driver } from "../../db/driver";
import type { Provider } from "../../db/types";
import { PROVIDERS, providerCli, resolveProviderKey } from "../../worker/keys";
import { mockProvidersEnabled } from "../../worker/mock-provider";
import { listedModel, listKeyModels } from "../../worker/model-list";
import { ProviderError } from "../../worker/providers";

export type ProviderAvailability =
  /** Catalogue model ids, as model_id strings, on and not on the key's list. */
  | { status: "ok"; available: string[]; missing: string[] }
  | { status: "no_key" }
  | { status: "mocked" }
  /** Subscription mode. A plan has no model list to read, so every model is offered. */
  | { status: "cli" }
  | { status: "error"; message: string };

export type AvailabilityReport = Record<Provider, ProviderAvailability>;

/** A list changes rarely, and a re-check is one button away. */
const FRESH_MS = 10 * 60_000;
/** A failure is retried sooner, since it is often a passing network fault. */
const FAILED_FRESH_MS = 30_000;

interface Cached {
  /** A one-way fingerprint, so a changed key misses the cache. Never the key. */
  keyPrint: string;
  expiresAt: number;
  ids: string[] | null;
  error: string | null;
}

const CACHE_KEY = Symbol.for("overheard.modelAvailability");
type CacheGlobal = typeof globalThis & { [CACHE_KEY]?: Map<Provider, Cached> };

function cache(): Map<Provider, Cached> {
  const holder = globalThis as CacheGlobal;
  holder[CACHE_KEY] ??= new Map();
  return holder[CACHE_KEY];
}

function keyPrint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function failureMessage(error: unknown): string {
  if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
    return "The provider refused this key, so its models could not be listed.";
  }
  return "The provider's model list could not be read just now. Check again in a moment.";
}

async function listFor(
  provider: Provider,
  apiKey: string,
  force: boolean,
  fetchImpl: typeof fetch | undefined,
): Promise<Pick<Cached, "ids" | "error">> {
  const now = Date.now();
  const print = keyPrint(apiKey);
  const held = cache().get(provider);
  if (!force && held && held.keyPrint === print && held.expiresAt > now) return held;
  try {
    const ids = await listKeyModels(provider, apiKey, fetchImpl);
    const entry = { keyPrint: print, expiresAt: now + FRESH_MS, ids, error: null };
    cache().set(provider, entry);
    return entry;
  } catch (error) {
    const entry = {
      keyPrint: print,
      expiresAt: now + FAILED_FRESH_MS,
      ids: null,
      error: failureMessage(error),
    };
    cache().set(provider, entry);
    return entry;
  }
}

/**
 * The report for every provider. `force` skips the cache, which is what the
 * Check button asks for.
 */
export async function modelAvailability(
  db: Driver,
  options: { force?: boolean | undefined; fetchImpl?: typeof fetch | undefined } = {},
): Promise<AvailabilityReport> {
  const catalogue = db
    .prepare("SELECT provider, model_id FROM models WHERE is_active = 1")
    .all<{ provider: Provider; model_id: string }>();

  const entries = await Promise.all(
    PROVIDERS.map(async (provider): Promise<[Provider, ProviderAvailability]> => {
      if (mockProvidersEnabled()) return [provider, { status: "mocked" }];
      if (providerCli(provider)) return [provider, { status: "cli" }];
      const apiKey = resolveProviderKey(provider);
      if (!apiKey) return [provider, { status: "no_key" }];
      const listed = await listFor(provider, apiKey, options.force === true, options.fetchImpl);
      if (listed.ids === null) {
        return [provider, { status: "error", message: listed.error ?? failureMessage(null) }];
      }
      const ids = new Set(listed.ids);
      const own = catalogue.filter((model) => model.provider === provider);
      return [
        provider,
        {
          status: "ok",
          available: own.filter((m) => listedModel(m.model_id, ids)).map((m) => m.model_id),
          missing: own.filter((m) => !listedModel(m.model_id, ids)).map((m) => m.model_id),
        },
      ];
    }),
  );
  return Object.fromEntries(entries) as AvailabilityReport;
}

/** Forget every cached list. For tests. */
export function clearAvailabilityCache(): void {
  cache().clear();
}
