import { useEffect, useState } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";
import { connectionLost } from "@/lib/connection-state";

/**
 * A banner saying the app cannot reach its own server.
 *
 * Closing the terminal stops the server. React Query keeps the last successful
 * data on screen, so without this banner every number stays put and nothing
 * says the figures have stopped refreshing.
 *
 * It lives in the shell because it is true of every screen at once. It reads
 * the query cache directly because the failing queries belong to whichever
 * route is mounted.
 */
export function ConnectionBanner() {
  const queryClient = useQueryClient();
  const [lost, setLost] = useState(false);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const read = () =>
      setLost(
        connectionLost(
          cache.getAll().map((query) => ({
            errored: query.state.status === "error",
            failureCount: query.state.fetchFailureCount,
          })),
        ),
      );
    read();
    // The cache notifies synchronously when useQuery adds a query, which happens
    // while another component renders. batchCalls moves the update to the next tick.
    return cache.subscribe(notifyManager.batchCalls(read));
  }, [queryClient]);

  if (!lost) return null;

  return (
    <div
      role="status"
      className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-center text-xs text-warn"
    >
      <CloudOff className="mr-1.5 inline size-3.5 align-text-bottom" />
      Overheard AI cannot reach its own server, so anything on screen is the last thing it loaded,
      not what is in your database now. Start the app again, then reload this page.
    </div>
  );
}
