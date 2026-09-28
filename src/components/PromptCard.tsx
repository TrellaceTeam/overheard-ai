import type { ReactNode } from "react";
import { Archive, Lock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEMO_READONLY_REASON } from "@/components/DemoReadOnlyNote";
import { TagChip, TagPicker } from "@/components/TagPicker";
import { answerCountLabel } from "@/lib/prompt-groups";

export interface PromptCardPrompt {
  id: string;
  text: string;
  is_active: number;
  iterations: number;
  category: string | null;
}

/**
 * One library card on the Prompts tab: the question on the left and its
 * controls on the right from 900px up, stacked under it below that. The
 * question never truncates, because it is the thing being measured.
 *
 * The tag is a coloured chip and the chip is the picker. Its colour is a stable
 * hash of its name (lib/tag-colors), so a tag wears the same colour in every
 * project and every fresh database. The name is always the chip's text, so the
 * colour never carries the identity alone. On the demo project the chip renders
 * static, outside the dimmed fieldset, at full contrast. Locked means
 * read-only, and a tag value nobody can read is lost, not locked.
 *
 * A question that has answers cannot have its text edited, because that would
 * silently change what every past run measured. Clone is the way out: the same
 * wording, switched off, so the next run does not ask both.
 */
export function PromptCard({
  prompt,
  answers,
  isDemo,
  identical,
  tags,
  maxChars,
  onPatch,
  onClone,
  onArchive,
  onDelete,
  resultsFold,
}: {
  prompt: PromptCardPrompt;
  /** How many answers this prompt has collected, archived rows included. */
  answers: number;
  isDemo: boolean;
  /** The switch-on hint: its text still matches another prompt in the project. */
  identical: boolean;
  tags: string[];
  /** The library's text ceiling, the route's PROMPT_MAX_CHARS. */
  maxChars: number;
  onPatch: (
    id: string,
    data: { text?: string; isActive?: boolean; iterations?: number; category?: string | null },
  ) => void;
  onClone: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  /** The results-summary fold, when this prompt has answers. */
  resultsFold: ReactNode;
}) {
  const on = prompt.is_active === 1;
  const locked = answers > 0 || isDemo;
  return (
    <div className="panel p-4">
      <div className="flex flex-col gap-3 min-[900px]:flex-row min-[900px]:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={on ? "default" : "secondary"}>{on ? "On" : "Off"}</Badge>
            {/* The switch sits beside the badge it explains: state and the
                control that changes it are one glance, not a row apart. On the
                demo it is dead but not dimmed. The note under the question
                carries the reason. */}
            <Switch
              aria-label="On"
              checked={on}
              disabled={isDemo}
              title={isDemo ? DEMO_READONLY_REASON : undefined}
              onCheckedChange={(checked) => onPatch(prompt.id, { isActive: checked })}
            />
            {identical && (
              <span className="text-xs text-muted-foreground">
                Edit before turning on: it is identical to another prompt
              </span>
            )}
          </div>

          <Textarea
            rows={2}
            maxLength={maxChars}
            aria-label="Prompt text"
            defaultValue={prompt.text}
            readOnly={locked}
            className={
              locked
                ? "autosize cursor-not-allowed resize-none border-transparent bg-muted/40 text-card-foreground"
                : "autosize"
            }
            onBlur={(e) => {
              if (e.target.value !== prompt.text) {
                onPatch(prompt.id, { text: e.target.value });
              }
            }}
          />
          {locked && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" />
              {isDemo ? (
                DEMO_READONLY_REASON
              ) : (
                <>
                  Locked because it has answers, so past runs stay comparable.
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => onClone(prompt.id)}
                  >
                    Clone to edit
                  </button>
                </>
              )}
            </p>
          )}
          {resultsFold}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span className="num text-xs text-muted-foreground">{answerCountLabel(answers)}</span>
          {/* The demo's chip: the same chip, full contrast, no control in it. */}
          {isDemo && <TagChip tag={prompt.category} />}
          <fieldset
            disabled={isDemo}
            className="m-0 flex flex-wrap items-center gap-3 border-0 p-0 disabled:opacity-60"
          >
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Iterations
              <Input
                type="number"
                min={1}
                max={20}
                aria-label="Iterations"
                className="num h-8 w-20"
                defaultValue={prompt.iterations}
                onBlur={(e) => onPatch(prompt.id, { iterations: Number(e.target.value) })}
              />
            </label>
            {!isDemo && (
              <TagPicker
                variant="chip"
                value={prompt.category}
                tags={tags}
                onChange={(next) => onPatch(prompt.id, { category: next })}
              />
            )}
            {/* Quiet until it is wanted. A red Delete in every row would put the
                page's irreversible action in the loudest colour in the palette,
                once per row. Archive comes first: hiding a prompt keeps its
                history, deleting it does not. */}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onArchive(prompt.id)}
            >
              <Archive className="size-4" /> Archive
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onDelete(prompt.id)}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          </fieldset>
        </div>
      </div>
    </div>
  );
}
