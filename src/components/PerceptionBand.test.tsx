// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PerceptionBand, isStale, perceptionRunNotice } from "./PerceptionBand";
import type { NamedSummary, PerceptionRunNotice, PerceptionSummary } from "./types";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

// The band links into project settings. Swapping the router link for a plain
// anchor keeps the test free of a RouterProvider it has nothing to say about.
vi.mock("@/components/AppLink", async () => {
  const helpers = await import("./test-helpers");
  return { AppLink: helpers.StubLink };
});

const base: PerceptionSummary = {
  model_id: null,
  question_text: "What do you know about Acme Analytics?",
  knows_brand: true,
  what_it_does: "Sells a web analytics suite.",
  typical_customers: "",
  well_regarded_for: "",
  downsides: "",
  source_answers: 3,
  updated_at: "2026-09-20T10:00:00.000Z",
};

type BandProps = Parameters<typeof PerceptionBand>[0];

function band(props: Partial<BandProps> = {}) {
  return render(
    <PerceptionBand
      projectId="p1"
      aggregate={base}
      perModel={[]}
      scopeIsEverything
      anySummaries
      currentQuestion="What do you know about Acme Analytics?"
      perceptionOff={false}
      onAskAgain={() => {}}
      asking={false}
      {...props}
    />,
  );
}

describe("PerceptionBand", () => {
  it("renders the merged row when every summarised assistant is in scope", () => {
    band({ perModel: [{ ...base, model_id: "m1", name: "Claude" }] });
    expect(screen.getByText("What it does")).toBeDefined();
    expect(screen.getByText("Sells a web analytics suite.")).toBeDefined();
    expect(screen.getByText(/Merged from 3 assistants/)).toBeDefined();
  });

  it("omits the headings the answer did not cover", () => {
    band({ perModel: [{ ...base, model_id: "m1", name: "Claude" }] });
    expect(screen.queryByText("Downsides")).toBeNull();
  });

  it("offers Ask now before anything has been asked", () => {
    const onAskAgain = vi.fn();
    band({ aggregate: null, anySummaries: false, onAskAgain });
    expect(screen.getByText(/Nothing asked yet/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Ask now/ }));
    expect(onAskAgain).toHaveBeenCalledOnce();
  });

  it("says no perception prompt is set rather than rendering an empty box", () => {
    band({ perceptionOff: true });
    expect(
      screen.getByText(/No perception prompt is set, so nothing is being asked/),
    ).toBeDefined();
  });

  it("shows per-assistant cards when the filter narrows the scope", () => {
    const perModel: NamedSummary[] = [
      { ...base, model_id: "m1", name: "Claude" },
      { ...base, model_id: "m2", name: "OpenAI", knows_brand: false },
    ];
    band({ scopeIsEverything: false, perModel });
    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.getByText("This assistant said it does not recognize your brand.")).toBeDefined();
  });

  it("flags a summary that answered an earlier version of the prompt", () => {
    band({
      perModel: [{ ...base, model_id: "m1", name: "Claude" }],
      currentQuestion: "What do you know about Northwind Metrics?",
    });
    expect(screen.getByText("answered an earlier version of your prompt")).toBeDefined();
  });

  it("flags the assistant whose card answered an earlier version of the prompt", () => {
    band({
      scopeIsEverything: false,
      perModel: [{ ...base, model_id: "m1", name: "Claude" }],
      currentQuestion: "What do you know about Northwind Metrics?",
    });
    expect(screen.getByText("earlier version of your prompt")).toBeDefined();
  });

  it("links to project settings to edit the prompt", () => {
    band();
    expect(screen.getByRole("link", { name: "Edit the prompt" })).toBeDefined();
  });
});

describe("isStale", () => {
  it("is unknown, and therefore false, when either side is missing", () => {
    expect(isStale(null, "a question")).toBe(false);
    expect(isStale("a question", null)).toBe(false);
  });

  it("ignores surrounding whitespace", () => {
    expect(isStale(" same ", "same")).toBe(false);
    expect(isStale("one", "another")).toBe(true);
  });
});

describe("PerceptionBand locked (demo project)", () => {
  it("disables Ask again and says why", () => {
    band({ locked: "The demo project is browse-only." });
    const ask = screen.getByRole("button", { name: /Ask again/ });
    expect(ask.hasAttribute("disabled")).toBe(true);
    expect(ask.getAttribute("title")).toBe("The demo project is browse-only.");
  });
});

describe("the newest perception run", () => {
  const run = (over: Partial<PerceptionRunNotice> = {}): PerceptionRunNotice => ({
    runId: "pr1",
    status: "completed",
    totalTasks: 3,
    doneTasks: 3,
    failedTasks: 0,
    pendingTasks: 0,
    failedReasons: [],
    createdAt: "2026-09-20T10:00:00.000Z",
    ...over,
  });

  it("says nothing about a run that finished clean", () => {
    band({ lastRun: run() });
    expect(screen.queryByText(/perception check/)).toBeNull();
    expect(screen.queryByText(/Asking each assistant/)).toBeNull();
  });

  it("reports a stumble with the count and the dominant reason", () => {
    band({
      lastRun: run({
        status: "partial",
        doneTasks: 2,
        failedTasks: 1,
        failedReasons: [{ code: null, error: "HTTP 429 rate limit reached" }],
      }),
    });
    expect(screen.getByText(/did not finish, and 1 of 3 answers failed/)).toBeDefined();
    expect(screen.getByText(/The provider rate-limited this call/)).toBeDefined();
  });

  it("is blunter when nothing came back at all", () => {
    band({
      lastRun: run({
        status: "failed",
        totalTasks: 2,
        doneTasks: 0,
        failedTasks: 2,
        failedReasons: [{ code: null, error: "TIMEOUT: no answer within 240000 ms" }],
      }),
    });
    expect(screen.getByText(/None of the 2 answers came back/)).toBeDefined();
    expect(screen.getByText(/The assistant took too long to answer/)).toBeDefined();
  });

  it("retries the failed answers from the notice, and links to the run", () => {
    const onRetryRun = vi.fn();
    band({
      lastRun: run({
        status: "partial",
        doneTasks: 2,
        failedTasks: 1,
        failedReasons: [{ code: null, error: "HTTP 429 x" }],
      }),
      onRetryRun,
    });
    fireEvent.click(screen.getByRole("button", { name: /Retry the failed answers/ }));
    expect(onRetryRun).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "See this run" })).toBeDefined();
  });

  it("says the check is being asked while its run is in flight, instead of 'Nothing asked yet'", () => {
    band({
      aggregate: null,
      anySummaries: false,
      lastRun: run({ status: "running", doneTasks: 1, pendingTasks: 2 }),
    });
    expect(screen.getByText(/Asking each assistant what it knows about you/)).toBeDefined();
    expect(screen.queryByText(/Nothing asked yet/)).toBeNull();
  });

  it("keeps the stumble notice from being contradicted by 'Nothing asked yet'", () => {
    band({
      aggregate: null,
      anySummaries: false,
      lastRun: run({
        status: "failed",
        doneTasks: 0,
        failedTasks: 3,
        failedReasons: [{ code: null, error: "HTTP 500 x" }],
      }),
    });
    expect(screen.queryByText(/Nothing asked yet/)).toBeNull();
    expect(screen.getByText(/The perception check failed/)).toBeDefined();
  });

  it("stays quiet about a run the user stopped: that is not a stumble", () => {
    band({
      aggregate: null,
      anySummaries: false,
      lastRun: run({
        status: "cancelled",
        doneTasks: 0,
        failedTasks: 3,
        failedReasons: [{ code: null, error: "Cancelled by user" }],
      }),
    });
    expect(screen.queryByText(/perception check/)).toBeNull();
    // With nothing asked and nothing to report, the empty state stands.
    expect(screen.getByText(/Nothing asked yet/)).toBeDefined();
  });

  it("locks the notice's retry on the demo project, with the reason", () => {
    band({
      lastRun: run({
        status: "partial",
        doneTasks: 2,
        failedTasks: 1,
        failedReasons: [{ code: null, error: "HTTP 429 x" }],
      }),
      locked: "The demo project is browse-only.",
    });
    const retry = screen.getByRole("button", { name: /Retry the failed answers/ });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.getAttribute("title")).toBe("The demo project is browse-only.");
  });
});

describe("perceptionRunNotice", () => {
  it("is null with no run, and null for a clean or stopped one", () => {
    expect(perceptionRunNotice(null)).toBeNull();
    expect(perceptionRunNotice(undefined)).toBeNull();
    expect(
      perceptionRunNotice({
        runId: "r",
        status: "completed",
        totalTasks: 1,
        doneTasks: 1,
        failedTasks: 0,
        pendingTasks: 0,
        failedReasons: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("reads queued and running as asking, whatever the counters say", () => {
    for (const status of ["queued", "running"]) {
      expect(
        perceptionRunNotice({
          runId: "r",
          status,
          totalTasks: 2,
          doneTasks: 0,
          failedTasks: 0,
          pendingTasks: 2,
          failedReasons: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        })?.kind,
      ).toBe("asking");
    }
  });

  it("reads outstanding tasks as asking even under a terminal status, so the failure copy never overstates", () => {
    // A crash can leave a run marked terminal with work still outstanding.
    // "None of the 3 answers came back" over two queued tasks would be false.
    // The recovery sweep settles the rows and the notice follows them.
    expect(
      perceptionRunNotice({
        runId: "r",
        status: "failed",
        totalTasks: 3,
        doneTasks: 0,
        failedTasks: 1,
        pendingTasks: 2,
        failedReasons: [{ code: null, error: "HTTP 500: upstream" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      })?.kind,
    ).toBe("asking");
  });
});
