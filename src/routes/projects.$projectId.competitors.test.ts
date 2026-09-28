// @vitest-environment jsdom
/**
 * The competitors screen's own decisions: which entered domains are refused and
 * how the accepted ones are normalised before they reach the database, how one
 * brand's trend is scored, and that the screen says how it counts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { competitorTrend, reviewDomains, Route } from "./projects.$projectId.competitors";
import type { MetricRow } from "@/lib/metrics";

const competitorMocks = vi.hoisted(() => ({
  createCompetitor: vi.fn(
    async (): Promise<{
      id: string;
      name: string;
      existingRole: "discovered" | "competitor" | null;
      rescored: { changed: number; runs: number } | null;
    }> => ({
      id: "new-1",
      name: "Fabrikam Labs",
      existingRole: null,
      rescored: null,
    }),
  ),
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: competitorMocks.toast }));

// The screen reads through its server functions, which is the boundary a
// browser test stands in for. The reads never settle, so the screen stays as it
// first renders and nothing updates once a test has finished with it. The one
// write these tests exercise, createCompetitor, is a spy.
vi.mock("@/server/api/brands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/api/brands")>()),
  listBrandsFull: () => new Promise(() => {}),
  createCompetitor: competitorMocks.createCompetitor,
}));
vi.mock("@/server/api/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/api/metrics")>()),
  listProjectMetrics: () => new Promise(() => {}),
}));

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  competitorMocks.createCompetitor.mockClear();
  competitorMocks.toast.success.mockClear();
  competitorMocks.toast.warning.mockClear();
  competitorMocks.toast.error.mockClear();
});

/** The screen rendered with its router params stubbed, as the other renders do. */
function renderScreen() {
  vi.spyOn(Route, "useParams").mockReturnValue({ projectId: "p1" });
  const Screen = Route.options.component;
  if (!Screen) throw new Error("the route has no component");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(Screen)));
}

describe("reviewDomains", () => {
  it("accepts and normalises plain domains", () => {
    expect(
      reviewDomains(["  Northwind.example.com ", "https://contoso.example.com/pricing"]),
    ).toEqual({ bad: [], cleaned: ["northwind.example.com", "contoso.example.com"] });
  });

  it("de-duplicates once normalised", () => {
    const result = reviewDomains(["acme.example.com", "www.acme.example.com"]);
    expect(result.cleaned).toEqual(["acme.example.com"]);
  });

  it("names the bad entries rather than dropping them", () => {
    const result = reviewDomains(["globex.example.com", "not a domain at all"]);
    expect(result.bad).toEqual(["not a domain at all"]);
    // Nothing is stored while one entry is refused, so a save cannot half land.
    expect(result.cleaned).toEqual([]);
  });

  it("ignores blank entries", () => {
    expect(reviewDomains(["", "   ", "fabrikam.example.com"])).toEqual({
      bad: [],
      cleaned: ["fabrikam.example.com"],
    });
  });
});

describe("route metadata", () => {
  it("names Overheard AI", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Competitors - Overheard AI"]);
  });
});

/** Type a name into the add form and press Add. */
function addByName(name: string) {
  fireEvent.change(screen.getByLabelText("Add a competitor"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
}

describe("the screen", () => {
  it("says how its statistics are counted, as the dashboard does", () => {
    renderScreen();
    expect(screen.getByRole("button", { name: "How is this counted?" })).toBeTruthy();
  });

  it("adds a competitor with no domain, one rule for domains everywhere", async () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText("Add a competitor"), {
      target: { value: "Northwind Metrics" },
    });
    // The name alone enables the button, and the domain field says it is optional.
    const add = screen.getByRole("button", { name: /^Add$/ });
    expect((add as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText("Primary domain (optional)")).toBeTruthy();
    fireEvent.click(add);
    await waitFor(() =>
      expect(competitorMocks.createCompetitor).toHaveBeenCalledWith({
        data: { projectId: "p1", name: "Northwind Metrics", domain: "" },
      }),
    );
    // The form clears for the next competitor.
    await waitFor(() =>
      expect((screen.getByLabelText("Add a competitor") as HTMLInputElement).value).toBe(""),
    );
  });

  it("refuses a filled-in domain that does not look like one before reaching the server", () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText("Add a competitor"), {
      target: { value: "Northwind Metrics" },
    });
    fireEvent.change(screen.getByLabelText("Primary domain (optional)"), {
      target: { value: "northwind" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(competitorMocks.createCompetitor).not.toHaveBeenCalled();
  });

  it("speaks when the name is already tracked, and nothing is added", async () => {
    competitorMocks.createCompetitor.mockResolvedValueOnce({
      id: "b5",
      name: "Northwind Metrics",
      existingRole: "competitor",
      rescored: null,
    });
    renderScreen();
    addByName("Northwind Metrics");
    await waitFor(() =>
      expect(competitorMocks.toast.warning).toHaveBeenCalledWith(
        "You already track this competitor",
      ),
    );
    expect(competitorMocks.toast.success).not.toHaveBeenCalled();
  });

  it("says a discovered name was promoted rather than quietly de-duplicated", async () => {
    // Typed lower-case. The sentence names the brand as the server stores it,
    // which is how the card shows it.
    competitorMocks.createCompetitor.mockResolvedValueOnce({
      id: "b6",
      name: "Contoso Insights",
      existingRole: "discovered",
      rescored: null,
    });
    renderScreen();
    addByName("contoso insights");
    await waitFor(() =>
      expect(competitorMocks.toast.success).toHaveBeenCalledWith(
        "Contoso Insights was already in your discovered list. It is tracked now",
      ),
    );
    expect(competitorMocks.toast.warning).not.toHaveBeenCalled();
  });

  it("adds the re-score line when the promotion brought a domain that corrected citations", async () => {
    competitorMocks.createCompetitor.mockResolvedValueOnce({
      id: "b6",
      name: "Contoso Insights",
      existingRole: "discovered",
      rescored: { changed: 2, runs: 1 },
    });
    renderScreen();
    addByName("Contoso Insights");
    await waitFor(() =>
      expect(competitorMocks.toast.success).toHaveBeenCalledWith(
        "2 citations corrected across 1 run",
      ),
    );
    expect(competitorMocks.toast.success).toHaveBeenCalledWith(
      "Contoso Insights was already in your discovered list. It is tracked now",
    );
  });

  it("stays quiet for a brand-new competitor", async () => {
    renderScreen();
    addByName("Fabrikam Labs");
    await waitFor(() => expect(competitorMocks.createCompetitor).toHaveBeenCalled());
    expect(competitorMocks.toast.warning).not.toHaveBeenCalled();
    expect(competitorMocks.toast.success).not.toHaveBeenCalled();
  });
});

/** A run_metrics row with the fields these tests do not care about filled in. */
function row(partial: Partial<MetricRow> = {}): MetricRow {
  return {
    id: `${partial.run_id ?? "run-1"}-${partial.brand_id ?? "b"}-${partial.prompt_id ?? "p"}`,
    run_id: "run-1",
    brand_id: "northwind",
    model_id: "model-1",
    prompt_id: "prompt-a",
    answers: 10,
    mentions: 0,
    ranked: 0,
    citations: 0,
    top_pick_share: null,
    top3_rate: null,
    created_at: "2026-09-22T09:00:00.000Z",
    ...partial,
  };
}

describe("competitorTrend", () => {
  it("scores a brand absent from one prompt below 100%", () => {
    // Two prompts, ten answers each. Northwind is named in five of prompt A's
    // ten and never in prompt B's, so the run is 5/20 and not 5/10. The brand
    // has no row at all for prompt B, which is why its own rows cannot be the
    // denominator.
    const rows = [row({ prompt_id: "prompt-a", mentions: 5 })];
    const allRows = [
      ...rows,
      row({ brand_id: "you", prompt_id: "prompt-a", mentions: 9 }),
      row({ brand_id: "you", prompt_id: "prompt-b", mentions: 8 }),
    ];
    expect(competitorTrend(rows, allRows)[0]?.mention).toBe(25);
  });

  it("agrees with the card above it when the brand was seen everywhere", () => {
    const rows = [
      row({ prompt_id: "prompt-a", mentions: 5 }),
      row({ prompt_id: "prompt-b", mentions: 3 }),
    ];
    expect(competitorTrend(rows, rows)[0]?.mention).toBe(40);
  });

  it("orders the points oldest first, one per run", () => {
    const rows = [
      row({ run_id: "run-2", mentions: 2, created_at: "2026-09-23T09:00:00.000Z" }),
      row({ run_id: "run-1", mentions: 5, created_at: "2026-09-22T09:00:00.000Z" }),
    ];
    const points = competitorTrend(rows, rows);
    expect(points.map((point) => point.mention)).toEqual([50, 20]);
  });

  it("returns nothing for a brand with no rows", () => {
    expect(competitorTrend([], [row()])).toEqual([]);
  });
});
