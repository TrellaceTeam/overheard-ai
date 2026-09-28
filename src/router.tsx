import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * Owns the router and the QueryClient the screens share.
 *
 * The client is created here, not at module scope, because getRouter runs once
 * per server render, and a module-level cache would be shared between
 * requests. Two retries with exponential backoff capped at five seconds mean
 * one blip never leaves a screen showing "nothing here" or a denial.
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: 2, retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000) },
    },
  });

  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
