import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { demoShowcaseRunId } from "@/lib/demo-ids";
import { errorText } from "@/lib/error-text";
import { isTutorialMode } from "@/lib/launch";
import { restoreDemoProject } from "@/server/api/demo";
import { setTutorial, tutorialState as fetchTutorialState } from "@/server/api/tutorial";

/**
 * The tutorial: one popup tour, from the first setup field to the last door.
 *
 * Mounted at the app root so it survives every screen it walks across (the
 * locked setup screen, the demo's showcase run, the demo's dashboard) as one
 * step list with one stored index. It has two phases.
 *
 * The setup phase guides. No dim layer, no blur, no click blocking and no way
 * to close: the spotlight ring highlights, the wizard stays fully usable, and
 * the way out is forward or Skip.
 *
 * The results phase is looser: a light blur, clicking outside closes, and
 * closing leaves you where you are. The last popup opens the menu drawer and
 * rings New project inside it, with three doors out: Back, Explore demo
 * project, Create new project.
 *
 * Skip is the same verb in both phases: a fast-forward, never an exit. It
 * jumps to the last popup, building the demo on the way when the setup half
 * has not built it yet.
 *
 * Nothing advances by itself. Steps change on Next and Back, on the wizard's
 * own buttons during setup, and never on a timer.
 */

/** The project routes a results step can send somebody to. Real paths. */
export type TourPath =
  | "/projects/$projectId"
  | "/projects/$projectId/runs/$runId"
  | "/projects/$projectId/prompts"
  | "/projects/$projectId/competitors"
  | "/projects/$projectId/settings";

/** The path that needs a run id beside the project id. */
export const TOUR_RUN_PATH = "/projects/$projectId/runs/$runId";

type Step = {
  selector: string;
  /** Where this step lives. Undefined means stay on whatever page we are on. */
  to?: TourPath;
  title: string;
  body: string;
};

/**
 * The data-tour values the screens carry, in one place so a screen does not
 * have to read the step list to find its own.
 */
export const TOUR_SELECTORS = {
  wizardBrand: "wizard-brand",
  wizardPrompts: "wizard-prompts",
  wizardDoors: "wizard-doors",
  wizardKeys: "wizard-keys",
  wizardCreate: "wizard-create",
  runStatus: "run-status",
  runSpend: "run-spend",
  runAnswers: "run-answers",
  tabDashboard: "tab-dashboard",
  perception: "perception",
  metrics: "metrics",
  trend: "trend",
  tabPrompts: "tab-prompts",
  tabCompetitors: "tab-competitors",
  tabSettings: "tab-settings",
  newProject: "new-project",
} as const;

const STEPS: Step[] = [
  /* ---------------------------------------------------- the setup phase */
  {
    selector: `[data-tour="${TOUR_SELECTORS.wizardBrand}"]`,
    title: "The brand block",
    body: "Your brand goes here. Name variants and a domain are how the app recognizes it in answers and links. Competitors are the brands you measure yourself against. The tutorial filled all of this in with a real brand.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.wizardPrompts}"]`,
    title: "Starter prompts",
    body: "Starter prompts, written from the brand and category, each with a tag. On your own project, edit them to sound like your real buyers. The perception prompt below them asks what assistants already know about the brand; its answers never count in statistics.",
  },
  {
    // Rings the line alone: the tutorial never shows the generate button, and
    // the tour never presses it.
    selector: `[data-tour="${TOUR_SELECTORS.wizardDoors}"]`,
    title: "Keep, edit or generate",
    body: "These questions are a starting point. Keep them, edit them by hand, or generate a set tailored to your brand.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.wizardKeys}"]`,
    title: "Your keys",
    body: "These are your real provider keys, read from the environment. The demo needs none; your own project needs at least one that works.",
  },
  {
    // The popup's Next presses this button. The body says so, because a popup
    // that silently duplicates the button under it reads as a lie.
    selector: `[data-tour="${TOUR_SELECTORS.wizardCreate}"]`,
    title: "Build the demo",
    body: "The highlighted button opens the demo project: 26 weeks of invented history, no provider calls, no spend. Next does the same.",
  },
  /* -------------------------------------------------- the results phase */
  {
    selector: `[data-tour="${TOUR_SELECTORS.runStatus}"]`,
    to: TOUR_RUN_PATH,
    title: "A run, finished",
    body: "On your own project this panel fills in live while the answers arrive, and the run keeps going when you leave the page. This one is the demo's newest week.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.runSpend}"]`,
    to: TOUR_RUN_PATH,
    title: "What a run costs",
    body: "Provider list rates, on your own keys. The demo calls no provider, so this stays at zero.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.runAnswers}"]`,
    to: TOUR_RUN_PATH,
    title: "Every answer is kept",
    body: "Raw results: what each assistant wrote, and what was pulled from it. Results: the same run, scored.",
  },
  {
    // The hand-off is shown, not done silently: the reader watches the tour
    // point at the tab the next step lives behind, so the page change on the
    // next Next makes sense.
    selector: `[data-tour="${TOUR_SELECTORS.tabDashboard}"]`,
    to: TOUR_RUN_PATH,
    title: "It all adds up here",
    body: "Every run adds up on the dashboard. The next step opens six months of it.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.perception}"]`,
    to: "/projects/$projectId",
    title: "What they say about you",
    body: "What the assistants said when asked what they know about your brand, merged into one summary.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.metrics}"]`,
    to: "/projects/$projectId",
    title: "How often they say it",
    body: "Mention rate is the share of answers that named you. Top 3 rate is the share that put you in the first three. Citation rate is the share that linked one of your domains.",
  },
  {
    // The step's job is to point at a movement the reader can see and say what
    // movements mean.
    selector: `[data-tour="${TOUR_SELECTORS.trend}"]`,
    to: "/projects/$projectId",
    title: "When something changes, you can see it",
    body: "Every point is one run. Around the middle of this history something changed, for example a press mention or a website update, and the line jumps. Watching for movements like that is the point of the dashboard.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.tabPrompts}"]`,
    to: "/projects/$projectId/prompts",
    title: "The prompts we ask",
    body: "The Runner at the top decides which assistants the next run asks and what it costs. Below it are your prompts, grouped by tag, with how many answers each has produced.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.tabCompetitors}"]`,
    to: "/projects/$projectId/competitors",
    title: "Who you were up against",
    body: "Every brand the assistants named alongside you. The demo's three competitors are already tracked; on your own project, newly found brands appear here to track.",
  },
  {
    selector: `[data-tour="${TOUR_SELECTORS.tabSettings}"]`,
    to: "/projects/$projectId/settings",
    title: "Where the project is shaped",
    body: "Your brand and its variants, the perception prompt, the schedule and the extractor are all behind this tab.",
  },
  {
    // The New project entry inside the opened drawer, not the menu button:
    // the provider tells AppMenu to open the drawer while this step is up, so
    // the real door is on screen and rings under its own spotlight.
    selector: `[data-tour="${TOUR_SELECTORS.newProject}"]`,
    title: "Your turn",
    body: "That is the whole loop, on simulated data. Keep poking around the demo, or set up your own brand. The screens are the same, and the keys are yours.",
  },
];

/** The setup phase: the five steps over the locked wizard. */
const SETUP_STEPS = 5;
/** Index of the last setup step (the wizard's final button). */
export const LAST_SETUP_STEP = SETUP_STEPS - 1;
/** Index of the first results step (the showcase run's status panel). */
export const FIRST_RESULTS_STEP = SETUP_STEPS;
export const TOTAL_STEPS = STEPS.length;
/** Index of the last popup (the drawer's New project). */
export const LAST_STEP = TOTAL_STEPS - 1;

type Rect = { top: number; left: number; width: number; height: number };

/** Where the pending flag lives, per demo project. `pending`, `done`, absent. */
export function tourKey(projectId: string): string {
  return `overheard:tour:${projectId}`;
}

/**
 * Where the id of the run the results phase opens on lives.
 *
 * Written beside the pending flag by the flow that arms the tour, from the
 * server's answer, so the tour opens on a run that exists even when a demo's
 * showcase run does not carry the deterministic id. The generator's id is the
 * fallback for an armed tour that lost the flag.
 */
export function tourRunKey(projectId: string): string {
  return `overheard:tour:${projectId}:run`;
}

/**
 * The stored step index, for both phases.
 *
 * Global, not per project, because the tour starts before any project exists
 * and the setup half must survive leaving and reloading midway.
 */
export const TOUR_STEP_KEY = "overheard:tour:step";

/** The stored step, clamped into the list. Anything unreadable starts at 0. */
export function readStep(raw: string | null, steps: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= steps) return 0;
  return parsed;
}

export interface TourApi {
  /** Which half of the tour is up, or null when no tour is showing. */
  phase: "setup" | "results" | null;
  index: number;
  /** A Skip is mid-flight building the demo. */
  busy: boolean;
  /** True while the last popup is up: AppMenu opens the drawer for it. */
  menuStage: boolean;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  /** End the tour where the reader stands. Results phase only. */
  close: () => void;
  /** The setup phase's Skip: build the demo if needed, jump to the last popup. */
  skipToLastPopup: () => Promise<void>;
  /** The wizard's create flow hands over here: arm results at the first step. */
  armResults: (projectId: string, runId: string) => void;
}

/**
 * The no-tour default. Screens render fine outside the provider, as in tests:
 * the wizard falls back to its own step state, and AppMenu never hears about a
 * drawer stage.
 */
const NO_TOUR: TourApi = {
  phase: null,
  index: 0,
  busy: false,
  menuStage: false,
  next: () => undefined,
  back: () => undefined,
  goTo: () => undefined,
  close: () => undefined,
  skipToLastPopup: async () => undefined,
  armResults: () => undefined,
};

const TourContext = createContext<TourApi>(NO_TOUR);

export function useTour(): TourApi {
  return useContext(TourContext);
}

export interface TourProviderProps {
  children?: ReactNode | undefined;
  /** The router's navigate, injected so the provider stays testable. */
  navigate: (opts: { to: string; params?: Record<string, string> }) => void;
  /** The current pathname. The provider watches it for the leaving rule. */
  pathname: string;
  /** The project route's id, when there is one. */
  activeProjectId?: string | undefined;
}

export function TourProvider({ children, navigate, pathname, activeProjectId }: TourProviderProps) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<"setup" | "results" | null>(null);
  const [index, setIndex] = useState(0);
  const [demoId, setDemoId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  // The results phase only closes on leaving once it has arrived: arming from
  // the wizard happens on /start, one navigation before the demo route, and a
  // watcher that fired on that gap would kill the tour it just armed.
  const seenDemo = useRef(false);
  // The same gap, for resolution: routes load lazily, so between arming and
  // the demo route rendering there is a moment where the pathname still says
  // /start. While an arm is in flight, resolution holds still instead of
  // concluding no tour is up.
  const pendingArm = useRef<string | null>(null);

  const tutorial = useQuery({ queryKey: ["tutorial-state"], queryFn: () => fetchTutorialState() });

  // Storage reads happen in effects: the routes are server-rendered and
  // localStorage is not there on the server.
  useEffect(() => {
    setReady(true);
  }, []);

  // Which half of the tour is up, resolved from where we are, the tutorial's
  // state and the stored index. Setup wins on the setup screen while the
  // tutorial is running. Results win on a demo route with a pending flag.
  useEffect(() => {
    if (!ready) return;
    if (pendingArm.current !== null) {
      if (activeProjectId !== pendingArm.current) return;
      pendingArm.current = null;
    }
    const stored = readStep(localStorage.getItem(TOUR_STEP_KEY), TOTAL_STEPS);
    if (pathname === "/start" && isTutorialMode(tutorial.data)) {
      setPhase("setup");
      setDemoId(null);
      setRunId(null);
      // A stored index from a finished run is stale here: the setup half
      // restarts from its first field.
      setIndex(stored <= LAST_SETUP_STEP ? stored : 0);
      return;
    }
    if (
      activeProjectId !== undefined &&
      localStorage.getItem(tourKey(activeProjectId)) === "pending" &&
      stored >= FIRST_RESULTS_STEP
    ) {
      setPhase("results");
      setDemoId(activeProjectId);
      setRunId(localStorage.getItem(tourRunKey(activeProjectId)));
      setIndex(stored);
      return;
    }
    setPhase(null);
  }, [ready, pathname, activeProjectId, tutorial.data]);

  const close = (): void => {
    pendingArm.current = null;
    if (demoId !== null) {
      try {
        localStorage.setItem(tourKey(demoId), "done");
      } catch {
        // Storage switched off: the tour still ends, it just cannot remember.
      }
    }
    try {
      localStorage.removeItem(TOUR_STEP_KEY);
    } catch {
      // Same.
    }
    seenDemo.current = false;
    setPhase(null);
    setIndex(0);
    setDemoId(null);
    setRunId(null);
  };

  // Navigating off a demo route during the results closes the tour. The setup
  // half does the opposite: leaving hides it and it resumes where it stood.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close is rebuilt every render and reads only demoId, which is listed.
  useEffect(() => {
    if (phase !== "results" || demoId === null) {
      seenDemo.current = false;
      return;
    }
    if (pathname.startsWith(`/projects/${demoId}`)) {
      seenDemo.current = true;
      return;
    }
    if (seenDemo.current) close();
  }, [pathname, phase, demoId]);

  const step = phase !== null ? STEPS[index] : undefined;

  // The spotlight follows its element: poll while the step is up, so page
  // fades, drawer animations and late mounts all land the ring where it
  // belongs. The first time a step's target turns up, the page scrolls it
  // into view unless it already sits comfortably on screen. A step the reader
  // has to find by scrolling is a step they miss. Tall targets (the wizard's
  // sections) align under the sticky header, and targets that fit are
  // centered.
  const scrolledFor = useRef<Step | null>(null);
  useEffect(() => {
    if (phase === null || !step) return;
    let frame = 0;
    const tick = () => {
      const el = document.querySelector(step.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        if (scrolledFor.current !== step) {
          scrolledFor.current = step;
          const HEADER_CLEARANCE = 72; // the sticky header's 56px, plus air
          const comfortable = r.top >= HEADER_CLEARANCE - 8 && r.bottom <= window.innerHeight - 16;
          if (!comfortable) {
            const tall = r.height > window.innerHeight - (HEADER_CLEARANCE + 72);
            if (tall && el instanceof HTMLElement) {
              el.style.scrollMarginTop = `${HEADER_CLEARANCE}px`;
              el.scrollIntoView?.({ behavior: "smooth", block: "start" });
            } else {
              el.scrollIntoView?.({ behavior: "smooth", block: "center" });
            }
          }
        }
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else {
        setRect(null);
      }
      frame = window.setTimeout(tick, 200);
    };
    tick();
    return () => window.clearTimeout(frame);
  }, [phase, step]);

  function persist(nextIndex: number): void {
    try {
      localStorage.setItem(TOUR_STEP_KEY, String(nextIndex));
    } catch {
      // Without storage the tour still works, it just will not resume.
    }
  }

  function goToStep(nextIndex: number): void {
    const target = STEPS[nextIndex];
    if (!target) {
      close();
      return;
    }
    persist(nextIndex);
    setIndex(nextIndex);
    if (phase === "results" && demoId !== null && target.to) {
      if (target.to === TOUR_RUN_PATH) {
        navigate({
          to: target.to,
          params: { projectId: demoId, runId: runId ?? demoShowcaseRunId() },
        });
      } else {
        navigate({ to: target.to, params: { projectId: demoId } });
      }
    }
  }

  function next(): void {
    if (phase === "setup") {
      if (index === LAST_SETUP_STEP) {
        // The create step's Next runs the wizard's own create flow, the same
        // one its button runs: press the button. Disabled while busy, so a
        // double press is a no-op rather than a second demo.
        document
          .querySelector<HTMLButtonElement>(`[data-tour="${TOUR_SELECTORS.wizardCreate}"]`)
          ?.click();
        return;
      }
      goToStep(index + 1);
      return;
    }
    goToStep(index + 1);
  }

  function back(): void {
    // Never back into the setup half: those steps point at a wizard that is
    // not on screen any more.
    if (index > FIRST_RESULTS_STEP) goToStep(index - 1);
  }

  /**
   * Remembers the demo, its run and the step to open on, and stands the
   * results phase up in memory. Both create flows use it. They differ only in
   * the step they arm and who navigates afterwards.
   */
  function arm(projectId: string, runIdToOpen: string, step: number): void {
    try {
      localStorage.setItem(tourKey(projectId), "pending");
      localStorage.setItem(tourRunKey(projectId), runIdToOpen);
      localStorage.setItem(TOUR_STEP_KEY, String(step));
    } catch {
      // A browser with storage switched off loses the resume and nothing else.
    }
    seenDemo.current = false;
    pendingArm.current = projectId;
    setDemoId(projectId);
    setRunId(runIdToOpen);
    setIndex(step);
    setPhase("results");
  }

  async function skipToLastPopup(): Promise<void> {
    setBusy(true);
    try {
      const { projectId, showcaseRunId } = await restoreDemoProject();
      await setTutorial({ data: { state: "done" } });
      // Write the cache through rather than invalidating: an invalidate leaves
      // the setup screen reading a stale "not done" for a frame and flashing
      // the popup back on.
      queryClient.setQueryData(["tutorial-state"], "done");
      void queryClient.invalidateQueries({ queryKey: ["demo-state"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["most-recent-project"] });
      arm(projectId, showcaseRunId, LAST_STEP);
      navigate({ to: "/projects/$projectId", params: { projectId } });
    } catch (error) {
      toast.error(errorText(error, "Could not create the demo project"));
    } finally {
      setBusy(false);
    }
  }

  function armResults(projectId: string, runIdToOpen: string): void {
    arm(projectId, runIdToOpen, FIRST_RESULTS_STEP);
  }

  const api: TourApi = {
    phase,
    index,
    busy,
    menuStage: phase === "results" && index === LAST_STEP,
    next,
    back,
    goTo: goToStep,
    close,
    skipToLastPopup,
    armResults,
  };

  return (
    <TourContext.Provider value={api}>
      {children}
      {phase !== null && step && (
        <TourPopup
          phase={phase}
          index={index}
          step={step}
          rect={rect}
          busy={busy}
          api={api}
          explore={
            // The door only exists while a demo is known, which every results
            // step guarantees. The setup phase renders no last popup to carry it.
            demoId === null
              ? null
              : () => {
                  close();
                  navigate({ to: "/projects/$projectId", params: { projectId: demoId } });
                }
          }
          onCreateProject={() => {
            close();
            navigate({ to: "/start" });
          }}
        />
      )}
    </TourContext.Provider>
  );
}

function TourPopup({
  phase,
  index,
  step,
  rect,
  busy,
  api,
  explore,
  onCreateProject,
}: {
  phase: "setup" | "results";
  index: number;
  step: Step;
  rect: Rect | null;
  busy: boolean;
  api: TourApi;
  /** Explore demo project: close, and land on the demo's dashboard. */
  explore: (() => void) | null;
  /** Create new project: close, and open the setup screen in normal mode. */
  onCreateProject: () => void;
}) {
  const isSetup = phase === "setup";
  const isLast = !isSetup && index === LAST_STEP;

  // Escape ends the results tour, the keyboard's way of clicking outside it.
  useEffect(() => {
    if (isSetup) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") api.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSetup, api]);

  // Over the results the card sits below what it rings. Over the setup screen
  // it sits beside it instead, on the right where there is room and on the
  // left where there is not: the wizard is reading material, and a card under
  // the spotlight lands on the fields below it and hides them on anything but
  // a tall screen. The ring carries the "look here" and the card stays out of
  // the text.
  const cardTop = rect ? Math.min(rect.top + rect.height + 12, window.innerHeight - 200) : 120;
  const cardLeft = rect ? Math.max(16, Math.min(rect.left, window.innerWidth - 340)) : 16;
  const CARD_WIDTH = 320;
  const CARD_GAP = 16;
  let cardStyle: { top: number | string; left?: number; right?: number; pointerEvents: "auto" };
  if (!isSetup || !rect) {
    cardStyle = { top: cardTop, left: cardLeft, pointerEvents: "auto" };
  } else {
    const besideTop = Math.max(
      16,
      Math.min(rect.top + rect.height / 2 - 110, window.innerHeight - 236),
    );
    const rightOf = rect.left + rect.width + CARD_GAP;
    const leftOf = rect.left - CARD_GAP - CARD_WIDTH;
    if (rightOf + CARD_WIDTH <= window.innerWidth - 16) {
      cardStyle = { top: besideTop, left: rightOf, pointerEvents: "auto" };
    } else if (leftOf >= 16) {
      cardStyle = { top: besideTop, left: leftOf, pointerEvents: "auto" };
    } else {
      cardStyle = { top: cardTop, left: cardLeft, pointerEvents: "auto" };
    }
  }

  // Focal-point backdrop, results phase only: a single dimmed, gently blurred
  // layer with an evenodd hole cut around the highlighted element, so the
  // target stays sharp and bright while the rest of the page recedes, and one
  // layer does both jobs. The setup phase renders no backdrop at all, so the
  // wizard underneath stays fully usable. On the last step the container sits
  // above the menu drawer (z-50) so the popup is readable while the drawer is
  // open. The hole keeps the New project entry clickable through it.
  const pad = 8;
  const hole = rect
    ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ` +
      `${rect.left - pad}px ${rect.top - pad}px, ` +
      `${rect.left - pad}px ${rect.top + rect.height + pad}px, ` +
      `${rect.left + rect.width + pad}px ${rect.top + rect.height + pad}px, ` +
      `${rect.left + rect.width + pad}px ${rect.top - pad}px, ` +
      `${rect.left - pad}px ${rect.top - pad}px)`
    : undefined;

  return (
    <div
      className={`pointer-events-none fixed inset-0 ${isLast ? "z-[55]" : "z-50"}`}
      data-phase={phase}
    >
      {!isSetup && (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-background/40 backdrop-blur-[0.5px]"
          style={{
            pointerEvents: "auto",
            ...(hole ? { clipPath: hole } : undefined),
          }}
          onClick={api.close}
        />
      )}
      {rect && (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-primary"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div className="panel-raised absolute w-[320px] space-y-2.5 p-5 shadow-lg" style={cardStyle}>
        <p className="num type-label text-primary">
          Step {index + 1} of {TOTAL_STEPS}
        </p>
        <h4 className="type-section">{step.title}</h4>
        <p className="type-meta">{step.body}</p>
        {isLast ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={api.back}>
              Back
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={explore === null}
              onClick={() => explore?.()}
            >
              Explore demo project
            </Button>
            <Button size="sm" onClick={onCreateProject}>
              Create new project
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              className="py-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              disabled={busy}
              onClick={() => (isSetup ? void api.skipToLastPopup() : api.goTo(LAST_STEP))}
            >
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> Building the demo…
                </span>
              ) : (
                "Skip ahead"
              )}
            </button>
            <div className="flex gap-2">
              {!isSetup && index > FIRST_RESULTS_STEP && (
                <Button size="sm" variant="outline" onClick={api.back}>
                  Back
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={api.next}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
