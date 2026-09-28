import { stripCode } from "@/lib/error-text";
import { useState } from "react";
import { CalendarClock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RunNotificationSwitch } from "@/components/RunNotificationSwitch";
import type { Cadence, Schedule, ScheduleDraft } from "@/components/types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

function isCadence(value: string): value is Cadence {
  return (CADENCES as string[]).includes(value);
}

/**
 * The automatic-runs card in project settings: cadence, day, hour and
 * timezone, plus the promise the local scheduler can keep.
 *
 * The scheduler lives in this process and only fires while it is running, so
 * the card says so under the controls instead of letting a user find out by
 * missing a week.
 *
 * `day_of_month` is never exposed. Monthly writes the literal 1, so there is no
 * end-of-month case to get wrong.
 *
 * The demo project never runs on a schedule, so it gets no browser
 * notification switch.
 */
export function ScheduleCard({
  schedule,
  nextOccurrence,
  onSave,
  onDisable,
  onDraftChange,
  saving = false,
  isDemo = false,
}: {
  /** The stored row, or null when this project has never had a schedule. */
  schedule: Schedule | null;
  /**
   * When the draft below would next fire, already formatted. The route computes
   * it with the scheduler's nextOccurrence so the preview and the stored value
   * come from one implementation.
   */
  nextOccurrence: string | null;
  /** Save the draft and switch the schedule on. */
  onSave: (draft: ScheduleDraft) => void;
  /** Pause the schedule. The row is kept, so switching back on restores it. */
  onDisable: () => void;
  /** Every control change, so the route can keep the preview above in step. */
  onDraftChange?: ((draft: ScheduleDraft) => void) | undefined;
  saving?: boolean | undefined;
  isDemo?: boolean | undefined;
}) {
  const [cadence, setCadence] = useState<Cadence | null>(null);
  const [dow, setDow] = useState<number | null>(null);
  const [hour, setHour] = useState<number | null>(null);
  const [tz, setTz] = useState<string | null>(null);

  const effectiveCadence = cadence ?? schedule?.cadence ?? "weekly";
  const effectiveDow = dow ?? schedule?.day_of_week ?? 1;
  const effectiveHour = hour ?? schedule?.hour_utc ?? 8;
  const effectiveTz = tz ?? schedule?.timezone ?? detectTimezone();
  // A stored zone outside the list stays selectable rather than silently moving.
  const tzOptions = TIMEZONES.includes(effectiveTz) ? TIMEZONES : [effectiveTz, ...TIMEZONES];

  const draft = (patch: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
    cadence: effectiveCadence,
    dayOfWeek: effectiveCadence === "weekly" ? effectiveDow : null,
    dayOfMonth: effectiveCadence === "monthly" ? 1 : null,
    hourUtc: effectiveHour,
    timezone: effectiveTz,
    ...patch,
  });

  return (
    <div className="panel space-y-4 p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm">
          <CalendarClock className="size-4 text-primary" />
          Automatic runs
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-muted-foreground">
                  <Info className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                Each scheduled run uses the project as it is when the run starts: its prompts, the
                assistants chosen in the Runner, and the provider keys in your environment. Changes
                you make before then apply automatically.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
        <Switch
          aria-label="Automatic runs"
          checked={Boolean(schedule?.is_active)}
          disabled={saving}
          onCheckedChange={(checked) => (checked ? onSave(draft()) : onDisable())}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label>Cadence</Label>
          <Select
            value={effectiveCadence}
            onValueChange={(value) => {
              if (!isCadence(value)) return;
              setCadence(value);
              onDraftChange?.(draft({ cadence: value }));
            }}
          >
            <SelectTrigger className="w-36" aria-label="Cadence">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {effectiveCadence === "weekly" && (
          <div className="space-y-2">
            <Label>Day</Label>
            <Select
              value={String(effectiveDow)}
              onValueChange={(value) => {
                setDow(Number(value));
                onDraftChange?.(draft({ dayOfWeek: Number(value) }));
              }}
            >
              <SelectTrigger className="w-36" aria-label="Day">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map((day, index) => (
                  <SelectItem key={day} value={String(index)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-2">
          <Label>Hour</Label>
          <Select
            value={String(effectiveHour)}
            onValueChange={(value) => {
              setHour(Number(value));
              onDraftChange?.(draft({ hourUtc: Number(value) }));
            }}
          >
            <SelectTrigger className="w-28" aria-label="Hour">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((hour) => (
                <SelectItem key={hour} value={String(hour)}>
                  {String(hour).padStart(2, "0")}:00
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Timezone</Label>
          <Select
            value={effectiveTz}
            onValueChange={(value) => {
              setTz(value);
              onDraftChange?.(draft({ timezone: value }));
            }}
          >
            <SelectTrigger className="w-56" aria-label="Timezone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {tzOptions.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" onClick={() => onSave(draft())} disabled={saving}>
          Save schedule
        </Button>
      </div>

      {/* The preview is computed from the draft whether or not automatic runs
          are on. Off, it is labelled as a preview, so it does not promise a
          run on a schedule that does not exist. */}
      {nextOccurrence &&
        (schedule?.is_active ? (
          <p className="num text-xs text-muted-foreground">Next run {nextOccurrence}</p>
        ) : (
          <p className="num text-xs text-muted-foreground">
            Would next run {nextOccurrence} if you switch this on
          </p>
        ))}

      {schedule?.last_skip_reason && (
        <p className="num text-xs text-warn">
          Last skipped: {stripCode(schedule.last_skip_reason)}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Schedules only fire while Overheard AI is running on this machine. If the app is closed when
        a run was due, it runs once the next time you start it, not once for every slot that passed.
      </p>

      {!isDemo && (
        <div className="border-t border-border pt-4">
          <RunNotificationSwitch />
        </div>
      )}
    </div>
  );
}
