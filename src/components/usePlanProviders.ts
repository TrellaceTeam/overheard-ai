import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { payerPhrase } from "@/lib/plan-spend";
import { keyStatus as fetchKeyStatus } from "@/server/api/settings";

/**
 * Which providers this install asks on a plan, from the same key status query
 * the key panel and the Runner read, and who pays for this install's calls as
 * a whole. A screen that knows which providers one call goes to passes them to
 * payerPhrase instead of using `payer`. `ready` is false until the status has
 * loaded, while `payer` still says "on your own keys".
 */
export function usePlanProviders(): {
  planProviders: ReadonlySet<string>;
  payer: string;
  ready: boolean;
} {
  const keys = useQuery({ queryKey: ["key-status"], queryFn: () => fetchKeyStatus() });
  return useMemo(() => {
    const rows = keys.data ?? [];
    const planProviders = new Set(
      rows.filter((row) => row.source === "cli").map((row) => String(row.provider)),
    );
    const called = rows.filter((row) => row.configured).map((row) => String(row.provider));
    return {
      planProviders,
      payer: payerPhrase(called, planProviders),
      ready: keys.data !== undefined,
    };
  }, [keys.data]);
}
