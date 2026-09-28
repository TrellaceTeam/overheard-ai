/** The reason every locked control on a demo page gives, in tooltips and notes. */
export const DEMO_READONLY_REASON = "The demo project is browse-only.";

/**
 * Says why a control on a demo page is greyed out. The demo banner in the
 * project shell says the data is invented. This says the control in front of
 * the user cannot run or change anything.
 */
export function DemoReadOnlyNote({ note }: { note?: string | undefined }) {
  return (
    <p className="type-meta" role="note">
      {note ?? "The demo project is browse-only: nothing here can run or change."}
    </p>
  );
}
