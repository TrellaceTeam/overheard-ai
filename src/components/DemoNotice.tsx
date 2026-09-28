import { FlaskConical } from "lucide-react";

/**
 * The permanent notice on every demo project page.
 *
 * Only the demo shows real company names (ADR 0006), and every number under
 * them is invented by the generator. A reader who mistakes the demo for
 * measurements would take fiction about real companies out into the world, so
 * this banner sits above the tabs on every page of the project, not on the
 * dashboard alone. MockProvidersNotice describes the environment. This one
 * describes the data, and it never goes away.
 */
export function DemoNotice() {
  return (
    <div
      className="panel mb-5 flex items-start gap-3 border-warn/40 p-4"
      data-tour="demo-notice"
      role="note"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-warn">Demo project: invented data</p>
        <p className="text-sm text-muted-foreground">
          Every answer, number and summary in this project was generated to show what six months of
          history looks like. None of it was measured, and none of it is real data about the
          companies named.
        </p>
      </div>
    </div>
  );
}
