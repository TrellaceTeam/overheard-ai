// @vitest-environment jsdom
/**
 * The shell's notice that a scheduled run finished: that it asks from the
 * right timestamp, announces each run once with a way to it, leaves a run for
 * a tab in view, and raises a browser notification only when asked to.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import {
  type FinishedScheduledRun,
  NOTICE_LOCK,
  NOTICE_SEEN_KEY,
  NOTIFY_OPT_IN_KEY,
} from "@/lib/scheduled-run-notices";

const noticeMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  listFinishedScheduledRuns: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: noticeMocks.toast }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => noticeMocks.navigate,
}));
// The server's own filter is tested on a real database in ops/runs.test.ts.
// This stand-in returns the same runs whatever it is asked, so the browser's
// seen timestamp has to do its part.
vi.mock("@/server/api/runs", () => ({
  listFinishedScheduledRuns: noticeMocks.listFinishedScheduledRuns,
}));

import { ScheduledRunNotices } from "./ScheduledRunNotices";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(navigator, "locks");
  noticeMocks.navigate.mockClear();
  noticeMocks.listFinishedScheduledRuns.mockReset();
  noticeMocks.toast.success.mockClear();
  noticeMocks.toast.warning.mockClear();
  noticeMocks.toast.error.mockClear();
});

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function partialRun(): FinishedScheduledRun {
  return {
    runId: "r1",
    projectId: "p1",
    projectName: "Acme Analytics",
    status: "partial",
    plannedCalls: 20,
    completedCalls: 14,
    failedCalls: 6,
    finishedAt: ago(HOUR),
  };
}

/** One open tab: its own query client, the browser's shared localStorage. */
function openTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(ScheduledRunNotices)));
  return client;
}

function serve(runs: FinishedScheduledRun[]) {
  noticeMocks.listFinishedScheduledRuns.mockImplementation(async () => runs);
}

function hideTab() {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
}

/** Lets the fetch, the effect and the claim that follows it settle. */
async function settle(client: QueryClient) {
  await waitFor(() =>
    expect(client.getQueryState(["finished-scheduled-runs"])?.status).toBe("success"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ScheduledRunNotices", () => {
  it("starts a browser's first visit from now, so nothing older is announced", async () => {
    serve([partialRun()]);
    const before = Date.now();
    await settle(openTab());

    const seen = localStorage.getItem(NOTICE_SEEN_KEY);
    expect(Date.parse(seen ?? "")).toBeGreaterThanOrEqual(before);
    expect(noticeMocks.listFinishedScheduledRuns).toHaveBeenCalledWith({ data: { since: seen } });
    expect(noticeMocks.toast.warning).not.toHaveBeenCalled();
  });

  it("announces a run that finished since the last notice, worded from its outcome", async () => {
    localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
    const run = partialRun();
    serve([run]);
    await settle(openTab());

    expect(noticeMocks.toast.warning).toHaveBeenCalledWith(
      "Scheduled run finished with failures: Acme Analytics",
      expect.objectContaining({ description: "7 of 10 answers collected. 3 failed" }),
    );
    expect(localStorage.getItem(NOTICE_SEEN_KEY)).toBe(run.finishedAt);
  });

  it("opens the run from the notice", async () => {
    localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
    serve([partialRun()]);
    await settle(openTab());

    const options = noticeMocks.toast.warning.mock.calls[0]?.[1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Open run");
    options.action.onClick();
    expect(noticeMocks.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/runs/$runId",
      params: { projectId: "p1", runId: "r1" },
    });
  });

  it("announces a run once, however often the tab asks again", async () => {
    localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
    serve([partialRun()]);
    const client = openTab();
    await settle(client);
    await client.refetchQueries({ queryKey: ["finished-scheduled-runs"] });
    await settle(client);

    expect(noticeMocks.toast.warning).toHaveBeenCalledOnce();
  });

  it("announces a run once across two open tabs", async () => {
    localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
    serve([partialRun()]);
    const first = openTab();
    const second = openTab();
    await settle(first);
    await settle(second);

    expect(noticeMocks.toast.warning).toHaveBeenCalledOnce();
  });

  it("claims under the Web Lock where the browser has one", async () => {
    const request = vi.fn((_name: string, take: () => unknown) => Promise.resolve(take()));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
    serve([partialRun()]);
    await settle(openTab());

    expect(request).toHaveBeenCalledWith(NOTICE_LOCK, expect.any(Function));
    expect(noticeMocks.toast.warning).toHaveBeenCalledOnce();
  });

  it("leaves the run for a tab in view when this tab is hidden and has no notification to raise", async () => {
    const seen = ago(2 * HOUR);
    localStorage.setItem(NOTICE_SEEN_KEY, seen);
    hideTab();
    serve([partialRun()]);
    await settle(openTab());

    expect(noticeMocks.toast.warning).not.toHaveBeenCalled();
    expect(localStorage.getItem(NOTICE_SEEN_KEY)).toBe(seen);
  });

  describe("with the browser notification switched on", () => {
    function stubNotifications() {
      class StubNotification {
        static permission: NotificationPermission = "granted";
        onclick: (() => void) | null = null;
        title: string;
        options: NotificationOptions;
        constructor(title: string, options: NotificationOptions) {
          this.title = title;
          this.options = options;
          raised.push(this);
        }
        close(): void {}
      }
      const raised: StubNotification[] = [];
      vi.stubGlobal("Notification", StubNotification);
      localStorage.setItem(NOTIFY_OPT_IN_KEY, "1");
      return raised;
    }

    it("raises one from a hidden tab, and opens the run when it is clicked", async () => {
      const raised = stubNotifications();
      localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
      hideTab();
      serve([partialRun()]);
      await settle(openTab());

      expect(raised).toHaveLength(1);
      expect(raised[0]?.title).toBe("Scheduled run finished with failures: Acme Analytics");
      expect(raised[0]?.options.body).toBe("7 of 10 answers collected. 3 failed");
      // The toast waits in the tab for the user's return.
      expect(noticeMocks.toast.warning).toHaveBeenCalledOnce();

      raised[0]?.onclick?.();
      expect(noticeMocks.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId: "p1", runId: "r1" },
      });
    });

    it("raises none from a tab in view, where the toast is enough", async () => {
      const raised = stubNotifications();
      localStorage.setItem(NOTICE_SEEN_KEY, ago(2 * HOUR));
      serve([partialRun()]);
      await settle(openTab());

      expect(raised).toHaveLength(0);
      expect(noticeMocks.toast.warning).toHaveBeenCalledOnce();
    });
  });
});
