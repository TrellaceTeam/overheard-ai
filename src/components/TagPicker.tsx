import { useState } from "react";
import { Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { canonicalTag } from "@/lib/prompt-groups";
import { tagColorSlot } from "@/lib/tag-colors";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NEW = "__new__";

/**
 * The tag chip, static: the tag's name in its palette colour, for the group
 * headings and anywhere a tag is shown but not edited. The colour comes from
 * the token palette by data-tag-color, and lib/tag-colors picks the slot. The
 * name is always the text, so colour never carries the identity alone.
 */
export function TagChip({
  tag,
  className,
}: {
  tag: string | null;
  className?: string | undefined;
}) {
  return (
    <span className={cn("tag-chip", className)} data-tag-color={tagColorSlot(tag)}>
      <span className="tag-chip-label">{tag ?? "Untagged"}</span>
    </span>
  );
}

/**
 * Tag selection on the prompts screen: pick an existing project tag or type a
 * new one. There is no "No tag": every question carries a tag, and a row
 * without one shows the placeholder until it is given one.
 *
 * Two dressings, one behaviour. `variant="select"` is the boxed trigger the
 * wizard rows use. `variant="chip"` renders the trigger as the tag chip itself
 * with a chevron, so on a library card the chip is the control, named for
 * screen readers as "Tag: visibility. Change tag".
 */
export function TagPicker({
  value,
  tags,
  onChange,
  className,
  ariaLabel = "Tag",
  variant = "select",
}: {
  value: string | null;
  tags: string[];
  onChange: (tag: string) => void;
  className?: string | undefined;
  /** Screen-reader name. The wizard labels each row's picker by its question. */
  ariaLabel?: string | undefined;
  variant?: "select" | "chip" | undefined;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  if (creating) {
    const commit = () => {
      // Reuses an existing tag's spelling when the draft differs only in case
      // or surrounding space, so "Visibility" does not become a second group
      // beside "visibility". See canonicalTag.
      const next = canonicalTag(draft, tags);
      setCreating(false);
      setDraft("");
      if (next) onChange(next);
    };
    return (
      <div className={`flex items-center gap-1 ${className ?? ""}`}>
        <Input
          autoFocus
          className="h-9 w-40"
          placeholder="New tag"
          aria-label="New tag name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setCreating(false);
              setDraft("");
            }
          }}
        />
        <Button type="button" variant="ghost" size="sm" onClick={commit} aria-label="Save tag">
          <Check className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Cancel new tag"
          onClick={() => {
            setCreating(false);
            setDraft("");
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <Select
      value={value ?? ""}
      onValueChange={(next) => {
        if (next === NEW) {
          setCreating(true);
          return;
        }
        onChange(next);
      }}
    >
      {variant === "chip" ? (
        /* The chip is the trigger: the tag's own colour, its name, and the
           Select's chevron. Capped, so a long tag truncates here and reads in
           full in the opened list. */
        <SelectTrigger
          className={cn("tag-chip tag-chip-capped w-auto shadow-none", className)}
          data-tag-color={tagColorSlot(value)}
          aria-label={value ? `Tag: ${value}. Change tag` : ariaLabel}
        >
          <span className="tag-chip-label">
            <SelectValue placeholder="Pick a tag…" />
          </span>
        </SelectTrigger>
      ) : (
        <SelectTrigger className={`w-44 ${className ?? ""}`} aria-label={ariaLabel}>
          <SelectValue placeholder="Pick a tag…" />
        </SelectTrigger>
      )}
      <SelectContent>
        {tags.map((tag) => (
          <SelectItem key={tag} value={tag}>
            {tag}
          </SelectItem>
        ))}
        <SelectItem value={NEW}>+ New tag…</SelectItem>
      </SelectContent>
    </Select>
  );
}
