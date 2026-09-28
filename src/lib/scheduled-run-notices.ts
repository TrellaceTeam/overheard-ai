/**
 * The notice a browser tab gives when a scheduled run finishes: which runs are
 * new to this browser, what each notice says, and whether a browser
 * notification may go with it.
 *
 * There is no daemon and no push. Every open tab polls the server, and the
 * browser remembers the latest finish it has announced as a timestamp in
 * localStorage. A run is new when it finished after that timestamp, so a run
 * that finished while no tab was open is announced by the next tab that opens,
 * and once.
 */
import { runOutcome } from "./run-outcome";

/** The latest finish this browser has announced, as an ISO instant. */
export const NOTICE_SEEN_KEY = "overheard:scheduled-runs-seen";

/** "1" when the user asked for a browser notification as well as the in-app notice. */
export const NOTIFY_OPT_IN_KEY = "overheard:scheduled-run-notifications";

/** The Web Locks name that lets one tab at a time claim runs, so each is announced once. */
export const NOTICE_LOCK = "overheard:scheduled-run-notices";

/**
 * How often each tab asks. Browsers slow the timers of a tab out of view, often
 * to once a minute, so a hidden tab can ask less often than this.
 */
export const NOTICE_POLL_MS = 30_000;

/** A scheduled run that reached a finished state. Counts are provider calls, as stored. */
export interface FinishedScheduledRun {
  runId: string;
  projectId: string;
  projectName: string;
  status: "completed" | "partial" | "failed";
  plannedCalls: number;
  completedCalls: number;
  failedCalls: number;
  finishedAt: string;
}

/** The part of Storage these rules touch, so a test can pass a plain object. */
export type NoticeStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The seen timestamp, written first when there is none. A first visit starts
 * from now, so a browser meeting the app for the first time is not handed
 * every run it has ever finished. A stored value in the future, which only a
 * clock set back can produce, is brought back to now, or every run until then
 * would pass unannounced.
 */
export function readSeen(storage: NoticeStorage, now: Date): string {
  const stored = storage.getItem(NOTICE_SEEN_KEY);
  const at = stored === null ? Number.NaN : Date.parse(stored);
  if (Number.isNaN(at) || at > now.getTime()) {
    const fresh = now.toISOString();
    storage.setItem(NOTICE_SEEN_KEY, fresh);
    return fresh;
  }
  return new Date(at).toISOString();
}

/** The runs that finished after `seen`, each once, oldest first so the newest notice lands on top. */
export function unseenRuns(
  runs: readonly FinishedScheduledRun[],
  seen: string,
): FinishedScheduledRun[] {
  const after = Date.parse(seen);
  const ids = new Set<string>();
  return runs
    .filter((run) => {
      const at = Date.parse(run.finishedAt);
      if (Number.isNaN(at) || at <= after || ids.has(run.runId)) return false;
      ids.add(run.runId);
      return true;
    })
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
}

/** The seen timestamp after announcing `runs`. It never moves back. */
export function advanceSeen(seen: string, runs: readonly FinishedScheduledRun[]): string {
  let latest = Date.parse(seen);
  for (const run of runs) {
    const at = Date.parse(run.finishedAt);
    if (!Number.isNaN(at) && at > latest) latest = at;
  }
  return new Date(latest).toISOString();
}

/**
 * Takes the runs this browser has not announced yet and marks them announced,
 * in one step. It reads the stored timestamp afresh, so a second tab calling
 * it with the same poll result gets nothing, provided the calls do not
 * overlap: the caller holds NOTICE_LOCK around it where the browser has Web
 * Locks.
 */
export function claimUnseen(
  storage: NoticeStorage,
  runs: readonly FinishedScheduledRun[],
  now: Date,
): FinishedScheduledRun[] {
  const seen = readSeen(storage, now);
  const fresh = unseenRuns(runs, seen);
  if (fresh.length > 0) storage.setItem(NOTICE_SEEN_KEY, advanceSeen(seen, fresh));
  return fresh;
}

/**
 * Whether this tab should claim runs now. A tab out of view claims only when
 * it can raise a browser notification: a notice nobody can see would use up
 * the one announcement, so otherwise it leaves the run for the next tab in
 * view, or for this one when it comes back into view.
 */
export function mayClaim(hidden: boolean, browserNotification: boolean): boolean {
  return !hidden || browserNotification;
}

/** The page's Notification permission, or null when the browser has no Notification API. */
export function notificationPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

/** What the browser notification control can offer. */
export type NotificationOptIn = "unsupported" | "denied" | "on" | "off";

/**
 * `permission` is null when the browser has no Notification API. Once denied,
 * a browser answers every later request with the same denial and shows no
 * prompt, so a denial is final here until the user changes it in the browser.
 */
export function notificationOptIn(
  permission: NotificationPermission | null,
  optedIn: boolean,
): NotificationOptIn {
  if (permission === null) return "unsupported";
  if (permission === "denied") return "denied";
  return optedIn && permission === "granted" ? "on" : "off";
}

export type NoticeTone = "success" | "partial" | "failed";

export interface RunNotice {
  tone: NoticeTone;
  title: string;
  description: string;
}

const TITLES: Record<NoticeTone, string> = {
  success: "Scheduled run complete",
  partial: "Scheduled run finished with failures",
  failed: "Scheduled run failed",
};

/**
 * The words of one notice. The counts are runOutcome's, the run page's own
 * sentence, with its closing period dropped because a toast has none.
 */
export function runNotice(run: FinishedScheduledRun): RunNotice {
  const outcome = runOutcome(run.status, run.completedCalls, run.failedCalls, run.plannedCalls);
  const tone: NoticeTone =
    outcome.tone === "success" || outcome.tone === "partial" ? outcome.tone : "failed";
  return {
    tone,
    title: `${TITLES[tone]}: ${run.projectName}`,
    description: outcome.detail.replace(/\.$/, ""),
  };
}
