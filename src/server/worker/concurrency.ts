/**
 * Per-provider in-flight caps: the environment variable, then the value saved
 * in Account settings, then the default.
 *
 * The defaults live with the claim they protect (logic/claim-tasks.ts). The
 * resolution lives here, because reading process.env is a worker concern and
 * the logic layer stays pure. A variable that is not a positive integer is
 * ignored, so a typo in .env falls back to the saved value or the default
 * instead of stopping the worker.
 */
import type { Provider } from "../db/types";
import { DEFAULT_PROVIDER_CAPS } from "../logic/claim-tasks";
import { isInflightCap } from "@/lib/inflight-caps";

export const INFLIGHT_CAP_ENV: Record<Provider, string> = {
  openai: "OVERHEARD_MAX_INFLIGHT_OPENAI",
  anthropic: "OVERHEARD_MAX_INFLIGHT_ANTHROPIC",
  google: "OVERHEARD_MAX_INFLIGHT_GOOGLE",
};

/** The caps saved in Account settings. Null means none is saved. */
export type StoredCaps = Record<Provider, number | null>;

type Env = Partial<Record<string, string | undefined>>;

/** The provider's OVERHEARD_MAX_INFLIGHT_* value, or null when it is unset or invalid. */
export function envCap(provider: Provider, env: Env = process.env): number | null {
  const raw = env[INFLIGHT_CAP_ENV[provider]];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The caps a claim applies. The variable is not held to the saved value's
 * upper bound: a cap above the batch size behaves as the batch size, so a
 * large value in .env does no harm.
 */
export function effectiveCaps(
  stored: StoredCaps,
  env: Env = process.env,
): Record<Provider, number> {
  const caps: Record<Provider, number> = { ...DEFAULT_PROVIDER_CAPS };
  for (const provider of Object.keys(INFLIGHT_CAP_ENV) as Provider[]) {
    const saved = stored[provider];
    const fromEnv = envCap(provider, env);
    if (fromEnv !== null) caps[provider] = fromEnv;
    else if (saved !== null && isInflightCap(saved)) caps[provider] = saved;
  }
  return caps;
}
