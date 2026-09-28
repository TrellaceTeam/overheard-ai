import { useState } from "react";
import { errorText } from "@/lib/error-text";
import { setupCheck } from "@/server/api/settings";
import type { KeyStatus, ProviderSlug, SetupCheckState } from "@/components/types";

/**
 * One provider's key row as the server reports it: `KeyStatus` minus the
 * verdict this hook adds. It is structural, so the routes pass their
 * ["key-status"] query data straight in and this file names the type without
 * importing it from the server.
 */
export type ProviderKeyRow = Omit<KeyStatus, "result">;

/**
 * The provider-keys check machine shared by the wizard, app Settings and
 * project Settings: the key rows the server read, the last verdict per
 * provider, and a `check` that walks a provider from checking to done.
 *
 * The key rows come from the caller's ["key-status"] query, not one this hook
 * owns, because the wizard reads more from that query than the statuses:
 * which providers have keys, and the availability state.
 */
export function useProviderChecks(rows: readonly ProviderKeyRow[] | undefined): {
  /** The key rows joined with each provider's latest check verdict. */
  statuses: KeyStatus[];
  /** Runs the server-side setup check for one provider. */
  check: (provider: ProviderSlug) => Promise<void>;
} {
  const [results, setResults] = useState<Record<string, SetupCheckState>>({});

  const statuses: KeyStatus[] = (rows ?? []).map((row) => ({
    provider: row.provider,
    configured: row.configured,
    source: row.source,
    problem: row.problem ?? null,
    result: results[row.provider] ?? { state: "untested" },
  }));

  async function check(provider: ProviderSlug): Promise<void> {
    setResults((current) => ({ ...current, [provider]: { state: "checking" } }));
    try {
      const report = await setupCheck({ data: { provider } });
      const row = report.rows[0];
      setResults((current) => ({
        ...current,
        [provider]: row
          ? {
              state: "done",
              status: row.result.status,
              message: row.result.message,
              hint: row.result.hint,
            }
          : { state: "done", status: "unknown", message: "The check returned no result." },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [provider]: {
          state: "done",
          status: "unknown",
          message: errorText(error, "Could not run the setup check"),
        },
      }));
    }
  }

  return { statuses, check };
}
