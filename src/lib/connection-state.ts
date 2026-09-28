/**
 * Whether the app should say out loud that its own server has gone away.
 *
 * This is an ordinary event for a tool that runs on your machine: the terminal
 * gets closed, the laptop sleeps, the process is stopped. React Query keeps the
 * last successful data on screen when a refetch fails, which is the right
 * default while a single call blips and the wrong one once nothing can be
 * reached, because a dashboard then presents last hour's numbers as current.
 *
 * Two queries failing is the signal rather than one. One server function that
 * throws is a bug on that screen; every query failing at once is the process
 * being gone, and only the second deserves a banner over the whole app.
 */
export type QuerySnapshot = {
  /** The query settled in an error state. */
  errored: boolean;
  /** Consecutive failed fetches, which React Query counts for us. */
  failureCount: number;
};

/** How many independent queries must be failing before we say so. */
export const MIN_FAILING_QUERIES = 2;

export function connectionLost(
  queries: readonly QuerySnapshot[],
  minQueries: number = MIN_FAILING_QUERIES,
): boolean {
  const failing = queries.filter((query) => query.errored && query.failureCount > 0);
  return failing.length >= minQueries;
}
