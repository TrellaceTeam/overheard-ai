/**
 * X-axis labels for a run trend.
 *
 * A trend point is a run, and runs are plotted against the day they started.
 * On day one somebody often runs several times in a row, so a date-only label
 * gives three ticks reading the same thing. When a day carries more than one
 * run the label carries the time as well, and only then, so the common case
 * stays short.
 */

function dayPart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** One label per timestamp, in the order given. */
export function trendLabels(timestamps: readonly string[]): string[] {
  const days = timestamps.map(dayPart);
  const perDay = new Map<string, number>();
  for (const day of days) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  return days.map((day, index) => {
    if ((perDay.get(day) ?? 0) < 2) return day;
    const time = timePart(timestamps[index] ?? "");
    return time === "" ? day : `${day} ${time}`;
  });
}
