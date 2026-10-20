/**
 * Who pays for a call, said the same way on every screen. A key bills the
 * provider at list prices. A plan in subscription mode bills nothing and
 * counts the call against the plan's usage limits, so its $0 needs saying, or
 * it reads as a broken estimate.
 *
 * `planProviders` is the set of providers asked through their command line
 * tool on this install, the key panel's "cli" rows. Everything else that is
 * called is called on a key.
 */
import { providerLabel } from "./failure-reasons";
import { isCliProvider, PROVIDER_CLI } from "./provider-keys";

/** "A", "A and B", "A, B and C". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function planName(provider: string): string {
  return isCliProvider(provider) ? PROVIDER_CLI[provider].plan : providerLabel(provider);
}

/** The plan a provider's calls count against, such as "Claude", or null on a key. */
export function planOf(provider: string, planProviders: ReadonlySet<string>): string | null {
  return planProviders.has(provider) ? planName(provider) : null;
}

/** "your Claude plan", "your Claude and ChatGPT plans". */
export function plansPhrase(plans: readonly string[]): string {
  return `your ${andList(plans)} ${plans.length === 1 ? "plan" : "plans"}`;
}

/** "your OpenAI key", "your OpenAI and Google keys". */
export function keysPhrase(keys: readonly string[]): string {
  return `your ${andList(keys)} ${keys.length === 1 ? "key" : "keys"}`;
}

/**
 * Who pays for calls to these providers, as the end of a sentence: "on your
 * own keys", "on your Claude plan", or "on your own keys and your Claude plan".
 * With no provider to name it keeps the keys wording, which is what the app
 * said before plans existed.
 */
export function payerPhrase(
  providers: Iterable<string>,
  planProviders: ReadonlySet<string>,
): string {
  const unique = [...new Set(providers)];
  const plans = unique.filter((provider) => planProviders.has(provider)).map(planName);
  if (plans.length === 0) return "on your own keys";
  const keyed = unique.some((provider) => !planProviders.has(provider));
  return keyed ? `on your own keys and ${plansPhrase(plans)}` : `on ${plansPhrase(plans)}`;
}

/**
 * What a run will cost and who pays. `keys` is every call on a key, priced at
 * list prices. `plans` is every call on a plan. `mixed` is both: the dollars
 * are the key calls alone, and `planCalls` counts the rest per plan.
 */
export type RunSpend =
  | { kind: "keys"; usd: number }
  | { kind: "plans"; plans: string[] }
  | {
      kind: "mixed";
      usd: number;
      /** Display names of the providers whose calls go on a key. */
      keys: string[];
      planCalls: Array<{ plan: string; calls: number }>;
    };

/**
 * The calls a run sends each provider, by the estimate's shape: each answer is
 * one call to its assistant and one to the extractor, and perception adds one
 * answer per assistant. With no extractor, the reading calls have no provider
 * to count against.
 */
export function callsByProvider(input: {
  totalIterations: number;
  assistants: readonly { provider: string }[];
  extractor: { provider: string } | null;
  includePerception: boolean;
}): Map<string, number> {
  const calls = new Map<string, number>();
  const add = (provider: string, n: number) => calls.set(provider, (calls.get(provider) ?? 0) + n);
  const answers = input.totalIterations + (input.includePerception ? 1 : 0);
  for (const assistant of input.assistants) {
    add(assistant.provider, answers);
    if (input.extractor) add(input.extractor.provider, answers);
  }
  return calls;
}

/** The run's spend, split by who pays. `usd` comes from prices already zeroed for plans. */
export function runSpend(
  usd: number,
  calls: ReadonlyMap<string, number>,
  planProviders: ReadonlySet<string>,
): RunSpend {
  const called = [...calls.entries()].filter(([, n]) => n > 0);
  const onPlans = called.filter(([provider]) => planProviders.has(provider));
  if (onPlans.length === 0) return { kind: "keys", usd };
  const onKeys = called.filter(([provider]) => !planProviders.has(provider));
  if (onKeys.length === 0) return { kind: "plans", plans: onPlans.map(([p]) => planName(p)) };
  return {
    kind: "mixed",
    usd,
    keys: onKeys.map(([provider]) => providerLabel(provider)),
    planCalls: onPlans.map(([provider, n]) => ({ plan: planName(provider), calls: n })),
  };
}

/** "18 calls on your Claude plan", "18 calls on your Claude plan and 12 on your ChatGPT plan". */
export function planCallsPhrase(planCalls: ReadonlyArray<{ plan: string; calls: number }>): string {
  return andList(
    planCalls.map(
      ({ plan, calls }, index) =>
        `${calls}${index === 0 ? ` ${calls === 1 ? "call" : "calls"}` : ""} on your ${plan} plan`,
    ),
  );
}
