import { Lock } from "lucide-react";

/** The line on each section the tutorial fills and locks. */
export function LockLine() {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Lock className="size-3 shrink-0" />
      Filled by the tutorial
    </p>
  );
}
