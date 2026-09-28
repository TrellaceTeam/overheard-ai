import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ComparePoint, CompareSeries } from "@/components/types";

/**
 * The visibility-over-time line chart and the shared chart palette.
 *
 * A line needs two points to mean anything, so one completed run renders the
 * `empty` message instead of a chart with a single dot.
 *
 * Every series on every chart in the app is a rate between 0 and 100, so there
 * is one y axis. It is anchored at zero: a trend line is read for its height as
 * much as its slope, and a floating baseline turns three points of movement
 * into a cliff.
 */

/** Legend and tooltip share one swatch, so identity reads the same in both. */
function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-[1px]"
      style={{ backgroundColor: color }}
    />
  );
}

export function CompareTrend({
  data,
  series,
  empty = "Two completed runs are needed before a trend appears.",
}: {
  data: ComparePoint[];
  series: CompareSeries[];
  empty?: string | undefined;
}) {
  if (data.length < 2 || series.length === 0) {
    return (
      <div className="panel flex min-h-32 items-center p-5">
        <p className="type-meta max-w-prose">{empty}</p>
      </div>
    );
  }
  const values = data.flatMap((point) =>
    series.map((s) => Number(point[s.key])).filter((v) => Number.isFinite(v)),
  );
  const maxVal = values.length ? Math.max(...values) : 0;
  const upper = maxVal <= 0 ? 10 : Math.min(100, Math.ceil((maxVal * 1.15) / 5) * 5);
  const last = data[data.length - 1];

  return (
    <div className="panel space-y-4 p-5">
      {/* The legend is markup rather than recharts' own, so it sits above the
          plot in the app's type scale instead of below it in the library's. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <span key={s.key} className="type-meta flex items-center gap-1.5">
            <Swatch color={s.color} />
            <span className="text-foreground">{s.label}</span>
            {/* The value is the newest run's, while the all-runs figure lives in
                the hint above the grid, so the label says which is which. */}
            <span className="text-muted-foreground">· latest</span>
            {/* The current value beside the name: the reader's first question
                about a line is where it ended up, and hunting for the right
                pixel on the right-hand edge is a poor way to answer it. */}
            {last && Number.isFinite(Number(last[s.key])) && (
              <span className="num">{Number(last[s.key])}%</span>
            )}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--chart-grid)" }}
            tickMargin={8}
            minTickGap={16}
          />
          <YAxis
            domain={[0, upper]}
            width={40}
            tickFormatter={(value: number) => `${value}%`}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              padding: "8px 10px",
            }}
            labelStyle={{ color: "var(--foreground)", marginBottom: 4 }}
            itemStyle={{ padding: 0 }}
            formatter={(value, name) => [`${Number(value)}%`, String(name)]}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              // A 2px ring in the surface colour keeps two points that land on
              // the same value from merging into one blob.
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="type-meta">Share of the answers collected in each run.</p>
    </div>
  );
}

/**
 * The series ramp, as theme tokens, so a palette change moves every chart.
 *
 * Five slots, handed out in this order and never cycled. styles.css has the
 * lightness band and the colour-vision separation the five are stepped to
 * clear. Brands past the fifth share one neutral, so the sixth brand is never
 * painted as the first. The table underneath carries the numbers either way.
 */
export const SERIES_COLORS: string[] = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** The colour for the nth series. Beyond the ramp, one neutral for all of them. */
export function seriesColor(index: number): string {
  return SERIES_COLORS[index] ?? "var(--chart-other)";
}
