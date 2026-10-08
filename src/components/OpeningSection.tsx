import { MousePointerClick } from "lucide-react";
import { Switch } from "@/components/ui/switch";

const HINTS = {
  on: "Rebuilds only the code already in this folder, for example after you run git pull. It never checks for or downloads updates.",
  off: "The icon starts the last build as it is. After you change or update the code, run npm run build yourself.",
};

/**
 * How the Overheard AI icon opens the app, and the one choice it offers:
 * whether to rebuild first when the code in the app's folder is newer than
 * the last build. server/index.mjs reads the saved value before the app loads.
 */
export function OpeningSection({
  on,
  readFailed,
  saving,
  onChange,
}: {
  /** Null while the setting is loading. */
  on: boolean | null;
  readFailed: boolean;
  saving: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="type-section">Opening Overheard AI</h2>
      <div className="panel space-y-3 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <MousePointerClick className="size-4 text-primary" />
          One click from the icon
        </p>
        <p className="text-sm text-muted-foreground">
          The Overheard AI icon opens this app in your browser, and starts it first when it is not
          running. To add the icon to your Start menu and desktop, or to Applications on a Mac, run{" "}
          <code className="num">npm run shortcut</code> once in the app's folder. Quit in the menu
          stops the app.
        </p>
        {readFailed ? (
          <p className="text-sm text-muted-foreground">
            We could not read the rebuild setting just now. Reload to try again.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="rebuild-on-open" className="text-sm">
                Rebuild after the code changes
              </label>
              <Switch
                id="rebuild-on-open"
                checked={on !== false}
                disabled={on === null || saving}
                onCheckedChange={onChange}
              />
            </div>
            <p className="text-xs text-muted-foreground">{on === false ? HINTS.off : HINTS.on}</p>
          </div>
        )}
      </div>
    </section>
  );
}
