// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NOTIFY_OPT_IN_KEY } from "@/lib/scheduled-run-notices";
import { ScheduleCard, detectTimezone } from "./ScheduleCard";
import { installDomStubs } from "./test-helpers";
import type { Schedule } from "./types";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeAll(installDomStubs);

const schedule: Schedule = {
  id: "s1",
  cadence: "weekly",
  day_of_week: 3,
  day_of_month: null,
  hour_utc: 9,
  timezone: "Europe/London",
  is_active: true,
  next_run_at: "2026-09-23T08:00:00.000Z",
  last_run_at: null,
  last_skip_reason: null,
};

describe("ScheduleCard", () => {
  it("says out loud that the app has to be running", () => {
    render(
      <ScheduleCard schedule={null} nextOccurrence={null} onSave={() => {}} onDisable={() => {}} />,
    );
    expect(screen.getByText(/only fire while Overheard AI is running/)).toBeDefined();
    expect(screen.getByText(/it runs once the next time you start it/)).toBeDefined();
  });

  it("falls back to weekly, Monday, 08:00 when there is no row", () => {
    render(
      <ScheduleCard schedule={null} nextOccurrence={null} onSave={() => {}} onDisable={() => {}} />,
    );
    expect(screen.getByLabelText("Cadence").textContent).toContain("Weekly");
    expect(screen.getByLabelText("Day").textContent).toContain("Monday");
    expect(screen.getByLabelText("Hour").textContent).toContain("08:00");
  });

  it("seeds the controls from the stored row", () => {
    render(
      <ScheduleCard
        schedule={schedule}
        nextOccurrence="23 Sep 2026, 09:00"
        onSave={() => {}}
        onDisable={() => {}}
      />,
    );
    expect(screen.getByLabelText("Day").textContent).toContain("Wednesday");
    expect(screen.getByLabelText("Hour").textContent).toContain("09:00");
    expect(screen.getByText(/Next run 23 Sep 2026, 09:00/)).toBeDefined();
  });

  it("does not promise a run while automatic runs are off", () => {
    // A brand new project has no schedule row and the switch is off, so a
    // "Next run" line would promise a run that never happens.
    render(
      <ScheduleCard
        schedule={null}
        nextOccurrence="28 Sep 2026, 08:00"
        onSave={() => {}}
        onDisable={() => {}}
      />,
    );
    expect(screen.queryByText(/^next run/)).toBeNull();
    expect(
      screen.getByText(/Would next run 28 Sep 2026, 08:00 if you switch this on/),
    ).toBeDefined();
  });

  it("calls a paused schedule a preview too", () => {
    render(
      <ScheduleCard
        schedule={{ ...schedule, is_active: false }}
        nextOccurrence="23 Sep 2026, 09:00"
        onSave={() => {}}
        onDisable={() => {}}
      />,
    );
    expect(screen.getByText(/Would next run/)).toBeDefined();
  });

  it("says assistants, like every other surface", () => {
    render(
      <ScheduleCard schedule={null} nextOccurrence={null} onSave={() => {}} onDisable={() => {}} />,
    );
    expect(screen.queryByText(/monitored AIs/)).toBeNull();
  });

  it("hands the draft back on save, with day_of_month left alone for weekly", () => {
    const onSave = vi.fn();
    render(
      <ScheduleCard
        schedule={schedule}
        nextOccurrence={null}
        onSave={onSave}
        onDisable={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(onSave).toHaveBeenCalledWith({
      cadence: "weekly",
      dayOfWeek: 3,
      dayOfMonth: null,
      hourUtc: 9,
      timezone: "Europe/London",
    });
  });

  it("pauses rather than saving when the switch goes off", () => {
    const onDisable = vi.fn();
    const onSave = vi.fn();
    render(
      <ScheduleCard
        schedule={schedule}
        nextOccurrence={null}
        onSave={onSave}
        onDisable={onDisable}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Automatic runs" }));
    expect(onDisable).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the last skip reason when the scheduler passed a slot over", () => {
    render(
      <ScheduleCard
        schedule={{
          ...schedule,
          last_skip_reason: "the previous run for this project was still running.",
        }}
        nextOccurrence={null}
        onSave={() => {}}
        onDisable={() => {}}
      />,
    );
    expect(screen.getByText(/Last skipped: the previous run/)).toBeDefined();
  });
});

describe("ScheduleCard, the browser notification switch", () => {
  const NAME = "Browser notification when a scheduled run finishes";

  /** The browser's Notification API as far as the switch uses it: a permission and a prompt. */
  function stubNotifications(permission: NotificationPermission, answer = permission) {
    const requestPermission = vi.fn(async () => answer);
    vi.stubGlobal("Notification", { permission, requestPermission });
    return requestPermission;
  }

  function renderCard(isDemo = false) {
    render(
      <ScheduleCard
        schedule={schedule}
        nextOccurrence={null}
        onSave={() => {}}
        onDisable={() => {}}
        isDemo={isDemo}
      />,
    );
    return screen.queryByRole("switch", { name: NAME }) as HTMLButtonElement | null;
  }

  it("asks the browser for permission when switched on, and remembers the answer", async () => {
    const requestPermission = stubNotifications("default", "granted");
    const toggle = renderCard()!;

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(localStorage.getItem(NOTIFY_OPT_IN_KEY)).toBe("1");
    expect(screen.getByText(/On for every project in this browser/)).toBeDefined();
  });

  it("stays off when the user refuses the browser's prompt", async () => {
    stubNotifications("default", "denied");
    const toggle = renderCard()!;

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByText(/This browser blocks notifications from Overheard AI/)).toBeDefined(),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(NOTIFY_OPT_IN_KEY)).toBeNull();
  });

  it("says plainly when notifications are blocked, and asks nothing", () => {
    // A browser that has refused answers every request with the same refusal,
    // and shows no prompt, so asking again would only look broken.
    const requestPermission = stubNotifications("denied");
    localStorage.setItem(NOTIFY_OPT_IN_KEY, "1");
    const toggle = renderCard()!;

    expect(
      screen.getByText(
        "This browser blocks notifications from Overheard AI. To use this, allow them in the browser's site settings, then reload this page.",
      ),
    ).toBeDefined();
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("says plainly when the browser has no notifications at all", () => {
    // jsdom has no Notification API, which stands in for a browser without one.
    const toggle = renderCard()!;
    expect(screen.getByText("This browser cannot show notifications.")).toBeDefined();
    expect(toggle.disabled).toBe(true);
  });

  it("switches off without asking the browser anything", () => {
    const requestPermission = stubNotifications("granted");
    localStorage.setItem(NOTIFY_OPT_IN_KEY, "1");
    const toggle = renderCard()!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(NOTIFY_OPT_IN_KEY)).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("is not offered on the demo project, which never runs on a schedule", () => {
    stubNotifications("default");
    expect(renderCard(true)).toBeNull();
  });
});

describe("detectTimezone", () => {
  it("returns an IANA zone, or UTC when the runtime cannot say", () => {
    expect(typeof detectTimezone()).toBe("string");
    expect(detectTimezone().length).toBeGreaterThan(0);
  });
});
