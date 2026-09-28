import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AvailabilityView } from "@/lib/assistant-menu";
import { modelAvailability } from "@/server/api/settings";

/**
 * Which catalogue models each key can use. Read once a key exists and kept
 * for a few minutes. `refresh` reads the providers' lists again past the
 * server's cache, and the Check button calls it.
 *
 * The query key carries the providers with a key, so a key added to .env is
 * listed as soon as the key status notices it.
 */
export function useModelAvailability(keyedProviders: readonly string[]): {
  availability: Readonly<Record<string, AvailabilityView | undefined>> | undefined;
  refresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const queryKey = ["model-availability", [...keyedProviders].sort().join(",")];
  const query = useQuery({
    queryKey,
    queryFn: () => modelAvailability({ data: {} }),
    enabled: keyedProviders.length > 0,
    staleTime: 5 * 60_000,
  });

  async function refresh(): Promise<void> {
    if (keyedProviders.length === 0) return;
    try {
      queryClient.setQueryData(queryKey, await modelAvailability({ data: { force: true } }));
    } catch {
      // The picker keeps the last list it had. A failed read is not a denial.
    }
  }

  return { availability: query.data, refresh };
}
