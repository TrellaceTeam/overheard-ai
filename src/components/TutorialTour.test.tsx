// @vitest-environment jsdom
/**
 * The tutorial tour's own decisions, in both phases: what arms each half, how
 * it advances, where Skip goes, what the last popup offers, and when leaving
 * closes it. The wizard's half of the sync lives in start.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { demoShowcaseRunId } from "@/lib/demo-ids";
import { installDomStubs } from "./test-helpers";
import {
  FIRST_RESULTS_STEP,
  LAST_SETUP_STEP,
  LAST_STEP,
  TOTAL_STEPS,
  TOUR_RUN_PATH,
  TOUR_SELECTORS,
  TOUR_STEP_KEY,
  TourProvider,
  readStep,
  tourKey,
  tourRunKey,
} from "./TutorialTour";

const mocks = vi.hoisted(() => ({
  tutorial: "done" as string,
  restoreDemoProject: vi.fn(async () => ({ projectId: "demo-1", showcaseRunId: "run-showcase" })),
  setTutorial: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("@/server/api/tutorial", () => ({
  tutorialState: async () => mocks.tutorial,
  setTutorial: mocks.setTutorial,
}));
vi.mock("@/server/api/demo", () => ({
  restoreDemoProject: mocks.restoreDemoProject,
}));
vi.mock("@/components/AppLink", async () => {
  const helpers = await import("./test-helpers");
  return { AppLink: helpers.StubLink };
});

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);
beforeAll(installDomStubs);

beforeEach(() => {
  localStorage.clear();
  mocks.tutorial = "done";
  mocks.restoreDemoProject.mockClear();
  mocks.setTutorial.mockClear();
});

interface TourRenderOptions {
  pathname?: string;
  projectId?: string;
  children?: ReactNode;
}

function renderTour(options: TourRenderOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = vi.fn();
  const tree = (props: TourRenderOptions) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        TourProvider,
        {
          navigate: (opts: { to: string; params?: Record<string, string> }) => navigate(opts),
          pathname: props.pathname ?? "/projects/demo-1/runs/run-showcase",
          ...(props.projectId === undefined ? {} : { activeProjectId: props.projectId }),
        },
        props.children ?? null,
      ),
    );
  const view = render(tree(options));
  return {
    ...view,
    navigate,
    rerenderWith: (props: TourRenderOptions) => view.rerender(tree(props)),
  };
}

/** The setup screen, in tutorial mode, at an optional stored step. */
function renderSetup(storedStep?: number, children?: ReactNode) {
  mocks.tutorial = "in_setup";
  if (storedStep !== undefined) localStorage.setItem(TOUR_STEP_KEY, String(storedStep));
  return renderTour({ pathname: "/start", children });
}

/** An armed results phase on the demo's showcase run. */
function armResults(step = FIRST_RESULTS_STEP, runId = "run-showcase") {
  localStorage.setItem(tourKey("demo-1"), "pending");
  localStorage.setItem(tourRunKey("demo-1"), runId);
  localStorage.setItem(TOUR_STEP_KEY, String(step));
}

function renderResults(step = FIRST_RESULTS_STEP, runId = "run-showcase", children?: ReactNode) {
  armResults(step, runId);
  return renderTour({
    pathname: `/projects/demo-1/runs/${runId}`,
    projectId: "demo-1",
    children,
  });
}

const RESULTS_TITLES = [
  "A run, finished",
  "What a run costs",
  "Every answer is kept",
  "It all adds up here",
  "What they say about you",
  "How often they say it",
  "When something changes, you can see it",
  "The prompts we ask",
  "Who you were up against",
  "Where the project is shaped",
  "Your turn",
];

describe("readStep", () => {
  it("starts at the beginning for anything it cannot use", () => {
    for (const raw of [null, "", "two", "-1", "6", "1.5"]) {
      expect(readStep(raw, 6)).toBe(0);
    }
  });

  it("takes a step that is in the list", () => {
    expect(readStep("3", 6)).toBe(3);
  });
});

describe("TOUR_SELECTORS", () => {
  it("names every attribute a screen has to carry", () => {
    expect(Object.values(TOUR_SELECTORS)).toEqual([
      "wizard-brand",
      "wizard-prompts",
      "wizard-doors",
      "wizard-keys",
      "wizard-create",
      "run-status",
      "run-spend",
      "run-answers",
      "tab-dashboard",
      "perception",
      "metrics",
      "trend",
      "tab-prompts",
      "tab-competitors",
      "tab-settings",
      "new-project",
    ]);
  });

  it("is one tour of five setup steps and eleven results steps", () => {
    expect(TOTAL_STEPS).toBe(16);
    expect(FIRST_RESULTS_STEP).toBe(5);
    expect(LAST_SETUP_STEP).toBe(4);
    expect(LAST_STEP).toBe(15);
  });
});

describe("the setup phase", () => {
  it("opens on the brand block, with no backdrop and no way to close", async () => {
    renderSetup();
    expect(await screen.findByText("The brand block")).toBeDefined();
    expect(screen.getByText(`Step 1 of ${TOTAL_STEPS}`)).toBeDefined();
    // No dim, no blur: nothing between the popup and a fully usable wizard.
    expect(document.querySelector('[class*="backdrop-blur"]')).toBeNull();
    // Forward or Skip, and Skip is labelled as the tour's, not an exit.
    expect(screen.getByText("Skip ahead")).toBeDefined();
    expect(screen.queryByText("Skip")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("walks brand, questions, the three doors, keys, create, storing the step as it goes", async () => {
    renderSetup();
    await screen.findByText("The brand block");
    const titles = ["Starter prompts", "Keep, edit or generate", "Your keys", "Build the demo"];
    for (const [index, title] of titles.entries()) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText(title)).toBeDefined();
      expect(localStorage.getItem(TOUR_STEP_KEY)).toBe(String(index + 1));
    }
    expect(screen.getByText(`Step 5 of ${TOTAL_STEPS}`)).toBeDefined();
  });

  it("explains the three doors in its own words on the prompts screen", async () => {
    renderSetup(2);
    expect(await screen.findByText("Keep, edit or generate")).toBeDefined();
    expect(
      screen.getByText(
        "These questions are a starting point. Keep them, edit them by hand, or generate a set tailored to your brand.",
      ),
    ).toBeDefined();
  });

  it("resumes at its stored step, and treats a results step as stale", async () => {
    renderSetup(3);
    expect(await screen.findByText("Your keys")).toBeDefined();

    cleanup();
    localStorage.clear();
    renderSetup(LAST_STEP);
    expect(await screen.findByText("The brand block")).toBeDefined();
  });

  it("stays hidden away from the setup screen while the tutorial runs", () => {
    mocks.tutorial = "in_setup";
    localStorage.setItem(TOUR_STEP_KEY, "1");
    renderTour({ pathname: "/" });
    expect(screen.queryByText("The questions buyers ask")).toBeNull();
  });

  it("presses the wizard's final button from the create step's Next", async () => {
    const create = vi.fn();
    renderSetup(
      LAST_SETUP_STEP,
      createElement(
        "button",
        { type: "button", "data-tour": TOUR_SELECTORS.wizardCreate, onClick: create },
        "Open the demo project",
      ),
    );
    await screen.findByText("Build the demo");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("fast-forwards on Skip: builds the demo, arms the last popup, lands on the dashboard", async () => {
    const view = renderSetup(0);
    await screen.findByText("The brand block");
    fireEvent.click(screen.getByText("Skip ahead"));

    await waitFor(() => expect(mocks.restoreDemoProject).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.setTutorial).toHaveBeenCalledWith({ data: { state: "done" } }),
    );
    expect(view.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId",
      params: { projectId: "demo-1" },
    });
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("pending");
    expect(localStorage.getItem(tourRunKey("demo-1"))).toBe("run-showcase");
    expect(localStorage.getItem(TOUR_STEP_KEY)).toBe(String(LAST_STEP));

    // Once the navigation lands, the last popup is what is waiting.
    view.rerenderWith({ pathname: "/projects/demo-1", projectId: "demo-1" });
    await waitFor(() => expect(screen.getByText("Your turn")).toBeDefined());
  });
});

describe("the results phase", () => {
  it("opens on the showcase run's status panel when armed", () => {
    renderResults();
    expect(screen.getByText("A run, finished")).toBeDefined();
    expect(screen.getByText(`Step ${FIRST_RESULTS_STEP + 1} of ${TOTAL_STEPS}`)).toBeDefined();
    expect(document.querySelector('[class*="backdrop-blur"]')).not.toBeNull();
  });

  it("walks spend, answers, the dashboard hand-off, the dashboard, the tabs, and the menu", () => {
    renderResults();
    expect(screen.getByText(RESULTS_TITLES[0]!)).toBeDefined();
    for (const title of RESULTS_TITLES.slice(1)) {
      fireEvent.click(screen.queryByRole("button", { name: "Next" })!);
      expect(screen.getByText(title)).toBeDefined();
    }
  });

  it("takes the run steps to the run the arming flow named", () => {
    const { navigate } = renderResults(FIRST_RESULTS_STEP, "legacy-run-id");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigate).toHaveBeenLastCalledWith({
      to: TOUR_RUN_PATH,
      params: { projectId: "demo-1", runId: "legacy-run-id" },
    });
  });

  it("falls back to the generator's showcase run id when no run was named", () => {
    armResults(FIRST_RESULTS_STEP);
    localStorage.removeItem(tourRunKey("demo-1"));
    const { navigate } = renderTour({
      pathname: "/projects/demo-1/runs/whatever",
      projectId: "demo-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigate).toHaveBeenLastCalledWith({
      to: TOUR_RUN_PATH,
      params: { projectId: "demo-1", runId: demoShowcaseRunId() },
    });
  });

  it("offers no Back into the setup half, and Back between results steps", () => {
    const { navigate } = renderResults();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("A run, finished")).toBeDefined();
    expect(navigate).toHaveBeenLastCalledWith({
      to: TOUR_RUN_PATH,
      params: { projectId: "demo-1", runId: "run-showcase" },
    });
  });

  it("Skip is the same fast-forward here: it jumps to the last popup", () => {
    renderResults();
    fireEvent.click(screen.getByText("Skip ahead"));
    expect(screen.getByText("Your turn")).toBeDefined();
    expect(screen.getByText(`Step ${LAST_STEP + 1} of ${TOTAL_STEPS}`)).toBeDefined();
    expect(localStorage.getItem(TOUR_STEP_KEY)).toBe(String(LAST_STEP));
    // A fast-forward is not an exit: the tour stays pending until a door or
    // an outside click ends it.
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("pending");
  });

  it("closes on a click outside the popup", () => {
    renderResults();
    const backdrop = document.querySelector('[class*="backdrop-blur"]')!;
    fireEvent.click(backdrop);
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("done");
    expect(screen.queryByText("A run, finished")).toBeNull();
  });

  it("waits for a demo route: an armed tour shows nothing elsewhere", () => {
    armResults();
    renderTour({ pathname: "/settings" });
    expect(screen.queryByText("A run, finished")).toBeNull();
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("pending");
  });

  it("closes when the reader navigates off the demo's routes", async () => {
    const view = renderResults();
    expect(screen.getByText("A run, finished")).toBeDefined();
    view.rerenderWith({ pathname: "/" });
    await waitFor(() => expect(localStorage.getItem(tourKey("demo-1"))).toBe("done"));
    expect(screen.queryByText("A run, finished")).toBeNull();
  });
});

describe("the last popup", () => {
  function renderLast(children?: ReactNode) {
    return renderTour({
      pathname: "/projects/demo-1",
      projectId: "demo-1",
      children,
    });
  }

  beforeEach(() => {
    armResults(LAST_STEP);
  });

  it("offers the three doors and no Skip", () => {
    renderLast();
    expect(screen.getByText("Your turn")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Explore demo project" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Create new project" })).toBeDefined();
    expect(screen.queryByText("Skip")).toBeNull();
    expect(screen.queryByText("Skip ahead")).toBeNull();
  });

  it("Back returns to the project settings step", () => {
    const { navigate } = renderLast();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Where the project is shaped")).toBeDefined();
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/projects/$projectId/settings",
      params: { projectId: "demo-1" },
    });
  });

  it("Explore demo project closes the tour on the demo's dashboard", () => {
    const { navigate } = renderLast();
    fireEvent.click(screen.getByRole("button", { name: "Explore demo project" }));
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("done");
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId",
      params: { projectId: "demo-1" },
    });
  });

  it("Create new project closes the tour and opens the setup screen", () => {
    const { navigate } = renderLast();
    fireEvent.click(screen.getByRole("button", { name: "Create new project" }));
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("done");
    expect(navigate).toHaveBeenCalledWith({ to: "/start" });
  });

  it("opens the menu drawer and rings the New project entry inside it", async () => {
    const { AppMenu } = await import("./AppMenu");
    renderLast(
      createElement(AppMenu, {
        projects: [{ id: "demo-1", name: "Acme Analytics" }],
        activeProjectId: "demo-1",
        onQuit: vi.fn(),
      }),
    );
    // The drawer opened by itself: the entry is on screen without a click on
    // the menu button, and it carries the hook the spotlight selects on.
    const entry = await screen.findByText("New project");
    expect(entry.getAttribute("data-tour")).toBe(TOUR_SELECTORS.newProject);
  });

  it("the drawer's New project works as the second door and closes the tour", async () => {
    const { AppMenu } = await import("./AppMenu");
    renderLast(
      createElement(AppMenu, {
        projects: [{ id: "demo-1", name: "Acme Analytics" }],
        activeProjectId: "demo-1",
        onQuit: vi.fn(),
      }),
    );
    fireEvent.click(await screen.findByText("New project"));
    expect(localStorage.getItem(tourKey("demo-1"))).toBe("done");
    expect(screen.queryByText("Your turn")).toBeNull();
  });
});
