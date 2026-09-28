import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pct } from "@/components/MetricCard";
import { seriesColor } from "@/components/CompareTrend";
import type { BrandAgg } from "@/components/types";
import type { Agg } from "@/lib/metrics";

type MetricDef = { key: keyof Agg; label: string };

/**
 * The three headline rates the dashboard cards show. All are rates, so one
 * axis and one formatter serve every metric.
 */
const METRICS: MetricDef[] = [
  { key: "mention_rate", label: "Mention rate" },
  { key: "top3_rate", label: "Top 3 rate" },
  { key: "citation_rate", label: "Citation rate" },
];

const numeric = (agg: Agg, def: MetricDef): number => {
  const v = agg[def.key];
  if (v === null || v === undefined) return 0;
  return Number(v) * 100;
};

/**
 * A brand name short enough to sit under a bar.
 *
 * Three to five bars share a card a third of the page wide, so a full name is
 * either angled to the point of being unreadable or overlaps its neighbour.
 * The tooltip carries the name in full.
 */
const axisName = (name: string): string => (name.length > 13 ? `${name.slice(0, 12)}…` : name);

/** One brand's value in the head-to-head card: a name, a rate and its rail. */
function Row({
  name,
  value,
  ratio,
  color,
  emphasis = false,
}: {
  name: string;
  value: string;
  ratio: number;
  color: string;
  emphasis?: boolean | undefined;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`type-meta truncate ${emphasis ? "text-foreground" : ""}`}>{name}</span>
        <span className="num shrink-0 text-lg font-semibold">{value}</span>
      </div>
      <div className="meter mt-2">
        <span
          className="meter-fill"
          style={{ width: `${Math.max(0, Math.min(100, ratio))}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/**
 * The head-to-head comparison. One competitor gets a card per metric with both
 * brands on it. Several get one small bar chart per metric, your brand included.
 */
export function CompareMetricGrid({
  target,
  competitors,
  empty = "Select competitors to compare against your brand.",
}: {
  target: BrandAgg;
  competitors: BrandAgg[];
  empty?: string | undefined;
}) {
  if (competitors.length === 0) {
    return (
      <div className="panel flex min-h-24 items-center p-5">
        <p className="type-meta max-w-prose">{empty}</p>
      </div>
    );
  }

  // One competitor, so both values fit on a card and are worth labelling.
  const only = competitors.length === 1 ? competitors[0] : undefined;
  if (only) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {METRICS.map((def) => {
          const mine = numeric(target.agg, def);
          const theirs = numeric(only.agg, def);
          return (
            <div key={def.key} className="panel flex flex-col gap-3 p-5">
              <p className="type-label">{def.label}</p>
              {/* Two rows, not one line with a "vs" in the middle: the pair is
                  read as a comparison, and a comparison wants the two numbers
                  and the two rails on the same left edge. */}
              <div className="space-y-2.5">
                <Row
                  name={target.name}
                  value={pct(target.agg[def.key])}
                  ratio={mine}
                  color={seriesColor(0)}
                  emphasis
                />
                <Row
                  name={only.name}
                  value={pct(only.agg[def.key])}
                  ratio={theirs}
                  color={seriesColor(1)}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Several competitors, so one bar chart per metric with your brand in it.
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {METRICS.map((def) => {
        const points = [
          { name: axisName(target.name), value: numeric(target.agg, def), fill: seriesColor(0) },
          ...competitors.map((c, i) => ({
            name: axisName(c.name),
            value: numeric(c.agg, def),
            fill: seriesColor(i + 1),
          })),
        ];
        const maxVal = Math.max(0, ...points.map((p) => p.value));
        const upper = maxVal <= 0 ? 10 : Math.min(100, Math.ceil((maxVal * 1.15) / 5) * 5);
        const domain: [number, number] = [0, upper];
        return (
          <div key={def.key} className="panel space-y-3 p-5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="type-label">{def.label}</p>
              <p className="num type-meta">
                <span className="text-foreground">{pct(target.agg[def.key])}</span> for{" "}
                {target.name}
              </p>
            </div>
            <ResponsiveContainer width="100%" height={168}>
              <BarChart
                data={points}
                margin={{ top: 16, right: 4, bottom: 0, left: -20 }}
                barCategoryGap="22%"
              >
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--chart-grid)" }}
                  interval={0}
                  height={28}
                  tickMargin={8}
                />
                <YAxis
                  type="number"
                  domain={domain}
                  allowDecimals={false}
                  tickFormatter={(value: number) => `${value}%`}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  cursor={{ fill: "var(--accent)", opacity: 0.4 }}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    padding: "8px 10px",
                  }}
                  labelStyle={{ color: "var(--foreground)", marginBottom: 4 }}
                  formatter={(value) => [`${Math.round(Number(value))}%`, def.label]}
                />
                <Bar
                  dataKey="value"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
                  isAnimationActive={false}
                >
                  {points.map((p) => (
                    <Cell key={p.name} fill={p.fill} />
                  ))}
                  {/* Direct labels, so identity and value never rest on colour
                      alone and the chart is readable in a screenshot. */}
                  <LabelList
                    dataKey="value"
                    position="top"
                    offset={6}
                    fontSize={11}
                    fill="var(--muted-foreground)"
                    formatter={(value) => `${Math.round(Number(value))}%`}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}
