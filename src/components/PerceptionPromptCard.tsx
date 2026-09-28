import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The perception prompt card on the second step of setup: the prompt each
 * assistant is asked on the first run about what it already knows of the brand.
 *
 * It arrives pre-filled with the template, brand resolved, so what is on screen
 * is what will be asked. The wizard owns the text and whether it was edited,
 * because it needs both: an untouched prompt is stored as the template with its
 * {brand} token, an edited one as written, and a blank one disables the button
 * that creates the project. The card offers the reset only once there is an
 * edit to undo.
 */
export function PerceptionPromptCard({
  value,
  edited,
  onChange,
  onReset,
}: {
  /** The prompt as shown, with {brand} resolved while it is untouched. */
  value: string;
  /** Whether the user has changed the pre-filled text. */
  edited: boolean;
  onChange: (value: string) => void;
  /** Puts the template back, brand resolved. */
  onReset: () => void;
}) {
  const blank = value.trim() === "";

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-section">Perception prompt</h2>
          <p className="type-meta">
            Each assistant answers it on your first run, which shows what AI already knows about
            your brand.
          </p>
        </div>
        {edited && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto shrink-0 p-0"
            onClick={onReset}
          >
            Reset to template
          </Button>
        )}
      </div>
      {/* Sized to its text: the template runs to three paragraphs, and all of
          it should be readable before it is sent, without a scrollbar. */}
      <Textarea
        aria-label="Perception prompt"
        value={value}
        className="autosize resize-none text-sm leading-relaxed"
        onChange={(e) => onChange(e.target.value)}
      />
      {blank && (
        <p className="text-xs text-warn">
          The perception prompt cannot be blank. Enter a prompt or reset to the template.
        </p>
      )}
    </div>
  );
}
