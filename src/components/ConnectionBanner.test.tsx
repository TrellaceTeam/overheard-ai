// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionBanner } from "./ConnectionBanner";

afterEach(cleanup);

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <ConnectionBanner />
    </QueryClientProvider>,
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function settle(queryClient: QueryClient, keys: string[][], fail: boolean) {
  await act(async () => {
    await Promise.all(
      keys.map((queryKey) =>
        queryClient
          .fetchQuery({
            queryKey,
            queryFn: () =>
              fail ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve(1),
          })
          .catch(() => undefined),
      ),
    );
    // The banner hears about cache changes on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ConnectionBanner", () => {
  it("says nothing while the server is answering", async () => {
    const queryClient = client();
    const { container } = mount(queryClient);
    await settle(queryClient, [["a"], ["b"]], false);
    expect(container.firstChild).toBeNull();
  });

  it("says nothing for a single failing query, which is one screen's bug", async () => {
    const queryClient = client();
    const { container } = mount(queryClient);
    await settle(queryClient, [["a"]], true);
    await settle(queryClient, [["b"]], false);
    expect(container.firstChild).toBeNull();
  });

  it("says so once the whole backend has gone away", async () => {
    // Otherwise the dashboard keeps presenting the last numbers it loaded as
    // current, with nothing on screen to say otherwise.
    const queryClient = client();
    mount(queryClient);
    await settle(queryClient, [["a"], ["b"]], true);
    expect(screen.getByRole("status").textContent).toContain("cannot reach its own server");
  });
});
