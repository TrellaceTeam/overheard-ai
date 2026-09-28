import type { RunTone } from "@/lib/run-outcome";

/**
 * How a run state looks, everywhere one is shown.
 *
 * The words come from lib/run-outcome, which decides what a queued or partial
 * run should say to a person. This file decides only the colour, for the run
 * list, the run screen and the per-answer state alike, so a finished run looks
 * the same in all three.
 *
 * Colour never carries the state on its own. A pill is a dot and a word, and
 * the word is the same string a screen reader gets.
 */
const TONE_TEXT: Record<RunTone, string> = {
  waiting: "text-status-queued",
  running: "text-status-running",
  success: "text-status-complete",
  partial: "text-status-partial",
  failed: "text-status-failed",
  cancelled: "text-status-cancelled",
};

const TONE_DOT: Record<RunTone, string> = {
  waiting: "bg-status-queued",
  running: "bg-status-running",
  success: "bg-status-complete",
  partial: "bg-status-partial",
  failed: "bg-status-failed",
  cancelled: "bg-status-cancelled",
};

/** The text colour for a run state, for the places that show a word and no pill. */
export function statusToneClass(tone: RunTone): string {
  return TONE_TEXT[tone];
}

export function StatusDot({ tone }: { tone: RunTone }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${
        // The app's only unprompted motion, kept for the one state that is
        // still happening. Reduced motion switches it off (styles.css).
        tone === "running" ? "animate-pulse" : ""
      }`}
    />
  );
}

export function StatusPill({
  tone,
  label,
  className = "",
}: {
  tone: RunTone;
  label: string;
  className?: string | undefined;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs ${TONE_TEXT[tone]} ${className}`}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}
