import { Check, X } from "lucide-react";
import { allRowsPassed } from "@/lib/setup-check";
import type { SetupCheckReport } from "@/server/api/settings";

/**
 * Renders one setup-check report: when it ran, whether the whole thing passed,
 * and one line per model with the verdict, the reason and, when there is one,
 * where to fix it. The screens decide when a check runs.
 *
 * A row shows the provider's model id next to the display name because the
 * check probes the exact model a run will call, and the reader should be able
 * to see that.
 */
export function SetupCheckRows({ report }: { report: SetupCheckReport }) {
  const passed = allRowsPassed(report.rows);
  return (
    <div className="space-y-2">
      <p className="num text-xs text-muted-foreground">
        Checked at {formatCheckedAt(report.checkedAt)} ·{" "}
        {passed ? "every model passed" : "some models did not pass"}
      </p>
      <ul className="space-y-2">
        {report.rows.map((row) => {
          const ok = row.result.status === "ok" || row.result.status === "mocked";
          return (
            <li key={`${row.kind}-${row.modelId}`} className="text-sm">
              <span
                className={`inline-flex items-center gap-1 ${ok ? "text-primary" : "text-warn"}`}
              >
                {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                {row.displayName}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {row.kind === "extractor" ? "extractor" : "assistant"} · {row.modelId}
              </span>
              <p className="text-xs text-muted-foreground">{row.result.message}</p>
              {row.result.hint && (
                <p className="text-xs text-muted-foreground">{row.result.hint}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
