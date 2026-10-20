// @vitest-environment jsdom
/**
 * Who pays, as the screens that do not know a call's provider read it from the
 * key status: the phrases for several calls and for one, whether a key is
 * billed, and what happens while the status is missing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  keyStatus: vi.fn(async (): Promise<unknown> => []),
}));
vi.mock("@/server/api/settings", () => ({ keyStatus: mocks.keyStatus }));

import { usePlanProviders } from "./usePlanProviders";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPayers() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => usePlanProviders(), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
}

describe("usePlanProviders", () => {
  it("names the plan and bills no key when every provider is on one", async () => {
    mocks.keyStatus.mockResolvedValueOnce([
      { provider: "anthropic", configured: true, source: "cli" },
      { provider: "google", configured: false, source: "none" },
    ]);
    const { result } = renderPayers();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.payer).toBe("on your Claude plan");
    expect(result.current.payerForOneCall).toBe("on your Claude plan");
    expect(result.current.keysBilled).toBe(false);
  });

  it("says or for one call on an install with both a key and a plan", async () => {
    mocks.keyStatus.mockResolvedValueOnce([
      { provider: "openai", configured: true, source: "env" },
      { provider: "anthropic", configured: true, source: "cli" },
    ]);
    const { result } = renderPayers();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.payer).toBe("on your own keys and your Claude plan");
    expect(result.current.payerForOneCall).toBe("on your own keys or your Claude plan");
    expect(result.current.keysBilled).toBe(true);
  });

  it("falls back to the keys wording, and is ready, when the status cannot be read", async () => {
    mocks.keyStatus.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderPayers();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.payer).toBe("on your own keys");
    expect(result.current.keysBilled).toBe(true);
  });
});
