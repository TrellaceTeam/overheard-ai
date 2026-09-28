import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The demo project's section on the App Settings screen: restore the demo
 * after a delete, or run the tutorial again.
 *
 * Restore stays disabled until `exists` is a definite false. Restoring is for a
 * missing demo, and the database's unique index refuses a second one.
 */
export function DemoProjectSection({
  exists,
  busy,
  onRestore,
  onRunTutorial,
}: {
  /** Null while the demo state is loading. */
  exists: boolean | null;
  /** A restore is in flight. */
  busy: boolean;
  onRestore: () => void;
  /** Starts the tutorial again: it reuses the demo if it exists, recreates it if not. */
  onRunTutorial: () => void;
}) {
  const disabled = busy || exists !== false;
  return (
    <section className="space-y-3" data-tour="demo-restore">
      <h2 className="type-section">Demo project</h2>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4 text-primary" />
            Six months of invented results to browse
          </p>
          <p className="text-sm text-muted-foreground">
            {exists === null
              ? "Checking whether the demo project is in your list…"
              : exists
                ? "The demo project is already in your project list. Delete it from its own settings if you want it gone."
                : "Recreates the demo project and its six months of invented history."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onRunTutorial}>
            Run tutorial again
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={onRestore}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy ? "Restoring…" : "Restore demo project"}
          </Button>
        </div>
      </div>
    </section>
  );
}
