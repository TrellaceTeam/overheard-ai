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
import { listCliModels } from "../../worker/cli-provider";
import { ProviderError } from "../../worker/providers";

export type ProviderAvailability =
  /**
   * Catalogue model ids, as model_id strings, on and not on the list. `plan`
   * marks a list read through a subscription-mode command, not a key.
   */
  | { status: "ok"; available: string[]; missing: string[]; plan?: true }
  | { status: "no_key" }
  | { status: "mocked" }
  /** Subscription mode with no list to read, so every model is offered. */
  | { status: "cli" }
  | { status: "error"; message: string };

export type AvailabilityReport = Record<Provider, ProviderAvailability>;

/** A list changes rarely, and a re-check is one button away. */
const FRESH_MS = 10 * 60_000;
/** A failure is retried sooner, since it is often a passing network fault. */
const FAILED_FRESH_MS = 30_000;

interface Cached {
  /**
   * A one-way fingerprint of the key, so a changed key misses the cache, or
   * the command for a plan. Never the key.
   */
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
  print: string,
  force: boolean,
  list: () => Promise<string[]>,
): Promise<Pick<Cached, "ids" | "error">> {
  const now = Date.now();
  const held = cache().get(provider);
  if (!force && held && held.keyPrint === print && held.expiresAt > now) return held;
  try {
    const ids = await list();
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

  const force = options.force === true;
  const entries = await Promise.all(
    PROVIDERS.map(async (provider): Promise<[Provider, ProviderAvailability]> => {
      if (mockProvidersEnabled()) return [provider, { status: "mocked" }];
      const own = catalogue.filter((model) => model.provider === provider);
      const cli = providerCli(provider);
      if (cli) {
        const listed = await listFor(provider, `cli:${cli.command}`, force, async () => {
          const ids = await listCliModels(cli);
          if (ids === null) throw new Error("NO_MODEL_LIST");
          return ids;
        });
        return [
          provider,
          listed.ids === null ? { status: "cli" } : { ...split(own, listed.ids), plan: true },
        ];
      }
      const apiKey = resolveProviderKey(provider);
      if (!apiKey) return [provider, { status: "no_key" }];
      const listed = await listFor(provider, keyPrint(apiKey), force, () =>
        listKeyModels(provider, apiKey, options.fetchImpl),
      );
      if (listed.ids === null) {
        return [provider, { status: "error", message: listed.error ?? failureMessage(null) }];
      }
      return [provider, split(own, listed.ids)];
    }),
  );
  return Object.fromEntries(entries) as AvailabilityReport;
}

/** The provider's catalogue models, sorted onto and off a list. */
function split(
  own: ReadonlyArray<{ model_id: string }>,
  listed: readonly string[],
): { status: "ok"; available: string[]; missing: string[] } {
  const ids = new Set(listed);
  return {
    status: "ok",
    available: own.filter((m) => listedModel(m.model_id, ids)).map((m) => m.model_id),
    missing: own.filter((m) => !listedModel(m.model_id, ids)).map((m) => m.model_id),
  };
}

/** Forget every cached list. For tests. */
export function clearAvailabilityCache(): void {
  cache().clear();
}
