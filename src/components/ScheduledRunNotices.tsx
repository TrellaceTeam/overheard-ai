import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  claimUnseen,
  type FinishedScheduledRun,
  mayClaim,
  NOTICE_LOCK,
  NOTICE_POLL_MS,
  NOTIFY_OPT_IN_KEY,
  notificationOptIn,
  notificationPermission,
  readSeen,
  runNotice,
} from "@/lib/scheduled-run-notices";
import { listFinishedScheduledRuns } from "@/server/api/runs";

/** Announced once, so it stays up longer than a toast that answers a click. */
const NOTICE_DURATION_MS = 15_000;

/**
 * Says so when a scheduled run finishes: a toast with a way to the run, and,
 * when the user asked for it on the schedule card, a browser notification
 * while this tab is out of view. It renders nothing of its own.
 *
 * It lives in the shell because a run can finish while any page is open. Every
 * open tab polls, and each run is claimed by one of them (lib/scheduled-run-notices).
 */
export function ScheduledRunNotices() {
  const navigate = useNavigate();

  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["finished-scheduled-runs"],
    // The timestamp is read when the request goes out, not put in the key, so
    // one cache entry serves every poll.
    queryFn: () =>
      listFinishedScheduledRuns({ data: { since: readSeen(localStorage, new Date()) } }),
    refetchInterval: NOTICE_POLL_MS,
    // A tab out of view keeps asking, because it is the one that can raise the
    // browser notification.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // Once per fetch rather than once per change of data: a hidden tab leaves a
  // run for later, and the refetch that comes with its return usually brings
  // back the same list.
  useEffect(() => {
    if (dataUpdatedAt === 0 || !data || data.length === 0) return;
    const hidden = document.visibilityState === "hidden";
    const browserNotification = hidden && browserNotificationWanted();
    if (!mayClaim(hidden, browserNotification)) return;

    const openRun = (run: FinishedScheduledRun) =>
      void navigate({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId: run.projectId, runId: run.runId },
      });

    void claim(data).then((runs) => {
      for (const run of runs) announce(run, browserNotification, openRun);
    });
  }, [data, dataUpdatedAt, navigate]);

  return null;
}

function browserNotificationWanted(): boolean {
  const optedIn = localStorage.getItem(NOTIFY_OPT_IN_KEY) === "1";
  return notificationOptIn(notificationPermission(), optedIn) === "on";
}

/**
 * Claims under a Web Lock where the browser has them, so two tabs polling at
 * the same moment cannot both take a run. Without one, the claim is a single
 * synchronous read and write of localStorage, which leaves a second tab only
 * a narrow window, and a duplicate browser notification folds into the first
 * through its tag.
 */
function claim(runs: readonly FinishedScheduledRun[]): Promise<FinishedScheduledRun[]> {
  const take = () => claimUnseen(localStorage, runs, new Date());
  const locks: LockManager | undefined = navigator.locks;
  if (!locks) return Promise.resolve(take());
  return locks.request(NOTICE_LOCK, take);
}

function announce(
  run: FinishedScheduledRun,
  browserNotification: boolean,
  openRun: (run: FinishedScheduledRun) => void,
): void {
  const notice = runNotice(run);
  const show =
    notice.tone === "success"
      ? toast.success
      : notice.tone === "partial"
        ? toast.warning
        : toast.error;
  show(notice.title, {
    // One toast per run in this tab, even if two fetches overlap.
    id: `scheduled-run-${run.runId}`,
    description: notice.description,
    duration: NOTICE_DURATION_MS,
    action: { label: "Open run", onClick: () => openRun(run) },
  });

  if (!browserNotification) return;
  try {
    const notification = new Notification(notice.title, {
      body: notice.description,
      tag: `overheard-run-${run.runId}`,
    });
    notification.onclick = () => {
      window.focus();
      openRun(run);
      notification.close();
    };
  } catch {
    // Chrome on Android refuses the constructor and wants a service worker.
    // The toast above is already waiting in the tab.
  }
}
