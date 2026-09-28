import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  NOTIFY_OPT_IN_KEY,
  type NotificationOptIn,
  notificationOptIn,
  notificationPermission,
} from "@/lib/scheduled-run-notices";

const LABEL = "Browser notification when a scheduled run finishes";

const HINTS: Record<NotificationOptIn, string> = {
  off: "For every project, in this browser. It needs an Overheard AI tab open, and appears when that tab is out of view.",
  on: "On for every project in this browser. It needs an Overheard AI tab open, and appears when that tab is out of view.",
  unsupported: "This browser cannot show notifications.",
  denied:
    "This browser blocks notifications from Overheard AI. To use this, allow them in the browser's site settings, then reload this page.",
};

/**
 * The opt-in for a browser notification when a scheduled run finishes, on top
 * of the notice inside the app. It belongs to this browser rather than to the
 * project, so it is stored in localStorage and covers every project.
 *
 * Turning it on asks the browser for permission. A browser that has refused
 * answers every later request with the same refusal, so the switch says so and
 * stays off instead of asking again.
 */
export function RunNotificationSwitch() {
  // Undefined until mounted: the server render has no Notification API and
  // no localStorage to read.
  const [permission, setPermission] = useState<NotificationPermission | null | undefined>();
  const [optedIn, setOptedIn] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setPermission(notificationPermission());
    setOptedIn(localStorage.getItem(NOTIFY_OPT_IN_KEY) === "1");
  }, []);

  if (permission === undefined) return null;
  const state = notificationOptIn(permission, optedIn);

  async function change(on: boolean) {
    if (!on) {
      localStorage.removeItem(NOTIFY_OPT_IN_KEY);
      setOptedIn(false);
      return;
    }
    if (typeof Notification === "undefined") return;
    setAsking(true);
    try {
      const answer =
        Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setPermission(answer);
      if (answer === "granted") {
        localStorage.setItem(NOTIFY_OPT_IN_KEY, "1");
        setOptedIn(true);
      }
    } catch {
      setPermission(notificationPermission());
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm">
          <BellRing className="size-4 text-primary" />
          {LABEL}
        </span>
        <Switch
          aria-label={LABEL}
          checked={state === "on"}
          disabled={asking || state === "unsupported" || state === "denied"}
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
      <p className="text-xs text-muted-foreground">{HINTS[state]}</p>
    </div>
  );
}
