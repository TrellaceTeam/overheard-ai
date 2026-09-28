export type MetricTone = "default" | "signal" | "warn";

type Props = {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: MetricTone | undefined;
  /**
   * The rate behind `value`, 0 to 1, for the rail. Null or undefined draws an
   * empty rail, and "n/a" in `value` tells it apart from a measured zero.
   */
  ratio?: number | null | undefined;
  /**
   * "plain" drops the panel around the card, for grids that already sit inside
   * a bordered panel, where a second border makes a box inside a box.
   */
  variant?: "card" | "plain" | undefined;
};

/**
 * One metric readout: a label, a big tabular number, a rail showing that number
 * as a part of a hundred, and an optional hint.
 *
 * The rail is the only ornament in the system and it carries information: a
 * rate is a share of the answers collected, and "38%" beside "94%" reads as two
 * numbers until you draw them. Callers feed it the same rate `value` is
 * formatted from.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone = "default",
  ratio,
  variant = "card",
}: Props) {
  const toneClass =
    tone === "signal" ? "text-primary" : tone === "warn" ? "text-warn" : "text-foreground";
  const filled =
    ratio === null || ratio === undefined ? null : Math.max(0, Math.min(100, ratio * 100));

  return (
    <div className={variant === "plain" ? "flex flex-col gap-3" : "panel flex flex-col gap-3 p-5"}>
      <p className="type-label">{label}</p>
      <div className={`flex flex-col gap-2.5 ${toneClass}`}>
        <p className="type-metric">{value}</p>
        <div className="meter" aria-hidden="true">
          <span className="meter-fill" style={{ width: `${filled ?? 0}%` }} />
        </div>
      </div>
      {hint && <p className="type-meta">{hint}</p>}
    </div>
  );
}

/**
 * A 0-to-1 rate as a whole percent, or "n/a" when missing. Every metric
 * surface formats through it, so a rate rounds the same way everywhere. The
 * missing value is a word, not a dash, because it also appears mid-sentence.
 */
export function pct(value: number | null | undefined) {
  if (value === null || value === undefined) return "n/a";
  return `${Math.round(Number(value) * 100)}%`;
}
