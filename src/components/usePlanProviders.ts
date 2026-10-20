import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { payerPhrase } from "@/lib/plan-spend";
import { keyStatus as fetchKeyStatus } from "@/server/api/settings";

/**
 * Which providers this install asks on a plan, from the same key status query
 * the key panel and the Runner read, and who pays for this install's calls
 * when a screen does not know which providers they go to: `payer` for several
 * calls, `payerForOneCall` for one, and `keysBilled` when any of them can bill
 * a key. A screen that knows the providers passes them to payerPhrase instead.
 * `ready` is false until the status has loaded or failed, and the phrases say
 * "on your own keys" until then. `enabled` false fetches nothing.
 */
export function usePlanProviders({ enabled = true }: { enabled?: boolean } = {}): {
  planProviders: ReadonlySet<string>;
  payer: string;
  payerForOneCall: string;
  keysBilled: boolean;
  ready: boolean;
} {
  const keys = useQuery({ queryKey: ["key-status"], queryFn: () => fetchKeyStatus(), enabled });
  return useMemo(() => {
    const rows = keys.data ?? [];
    const planProviders = new Set(
      rows.filter((row) => row.source === "cli").map((row) => String(row.provider)),
    );
    const called = rows.filter((row) => row.configured).map((row) => String(row.provider));
    return {
      planProviders,
      payer: payerPhrase(called, planProviders),
      payerForOneCall: payerPhrase(called, planProviders, "or"),
      keysBilled: called.length === 0 || called.some((provider) => !planProviders.has(provider)),
      ready: keys.data !== undefined || keys.isError,
    };
  }, [keys.data, keys.isError]);
}
