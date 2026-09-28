import { useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { commitEntries } from "./badge-input.logic";

interface BadgeInputProps {
  id?: string | undefined;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string | undefined;
  /** Cap on how many entries can be added, for example 3 for competitors. */
  maxItems?: number | undefined;
  /**
   * The uncommitted text in the box, reported on every keystroke.
   *
   * Without it, a parent that gates a button on `value` treats the field as
   * empty while the user can see what they typed. The wizard uses it so a
   * domain typed but not committed still counts.
   */
  onDraftChange?: ((draft: string) => void) | undefined;
  /**
   * What the reserved line under the field says while nothing is being typed.
   * The line is there either way, so a field's hint goes on it instead of on a
   * second line below. Without a hint the line stays blank.
   */
  hint?: ReactNode;
}

/**
 * A chip field for variants, domains and competitors. Each committed entry
 * becomes a removable badge, like recipients in an email client. Enter, comma
 * or blur commits the draft. The badge's x, or Backspace in an empty field,
 * removes an entry.
 */
export function BadgeInput({
  id,
  value,
  onChange,
  placeholder,
  maxItems,
  onDraftChange,
  hint,
}: BadgeInputProps) {
  const [draft, setDraft] = useState("");
  const limit = maxItems ?? Infinity;

  function setPending(next: string) {
    setDraft(next);
    onDraftChange?.(next);
  }

  function commit(raw: string) {
    setPending("");
    const next = commitEntries(value, raw, limit);
    // Only push an update when something was added (commit never removes), so
    // re-typing a duplicate or blurring an empty field is a no-op.
    if (next.length !== value.length) onChange(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <>
      <div
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
          "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        )}
      >
        {value.map((item) => (
          <Badge key={item} variant="secondary" className="gap-1">
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => onChange(value.filter((v) => v !== item))}
              className="grid size-6 shrink-0 place-items-center rounded-sm opacity-70 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={value.length === 0 ? placeholder : undefined}
          disabled={value.length >= limit}
          className="min-w-[8ch] flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>
      {/* A chip field is not a text field, so the Enter instruction appears
        while there is a draft and its line is kept when there is not. A
        collapsing line would move everything below it up at the moment the
        draft commits, which is when somebody is reaching for the button
        underneath. */}
      {draft.trim() === "" && hint ? (
        <p className="mt-1.5 min-h-4 text-xs text-muted-foreground">{hint}</p>
      ) : (
        <p
          className={cn(
            "mt-1.5 h-4 text-xs text-muted-foreground",
            draft.trim() === "" && "invisible",
          )}
        >
          Press Enter or comma to add it.
        </p>
      )}
    </>
  );
}
