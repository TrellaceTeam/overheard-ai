import { AlertTriangle } from "lucide-react";

/**
 * Says the numbers on screen are not measurements.
 *
 * OVERHEARD_MOCK_PROVIDERS makes every provider return canned text, which the
 * demo path and the test suite run on. Every screen downstream looks like a
 * real one: a citation rate, a perception band, a competitor table. So the
 * banner shows wherever a mock run can be started or read, not on the settings
 * screen alone.
 */
export function MockProvidersNotice() {
  return (
    <div className="panel flex items-start gap-3 border-warn/40 p-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-warn">Mock providers are on</p>
        <p className="text-sm text-muted-foreground">
          OVERHEARD_MOCK_PROVIDERS is set, so no assistant is being asked anything. Every answer and
          every score on every screen is canned test data. Unset it and restart to measure anything
          real.
        </p>
      </div>
    </div>
  );
}
