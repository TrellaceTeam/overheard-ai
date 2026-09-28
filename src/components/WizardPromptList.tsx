import { Plus, X } from "lucide-react";
import { LockLine } from "@/components/LockLine";
import { TagPicker } from "@/components/TagPicker";
import { TOUR_SELECTORS } from "@/components/TutorialTour";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WizardForm } from "@/components/useWizardForm";
import { clampIterations, MAX_WIZARD_ITERATIONS, MIN_WIZARD_ITERATIONS } from "@/lib/onboarding";

/** Step two's question list: each prompt with its iterations and tag, editable in place. */
export function WizardPromptList({
  form,
  locked,
  busy = false,
}: {
  form: WizardForm;
  /** The tutorial filled the list and locks it. */
  locked: boolean;
  /**
   * A generated set is on its way to replace the list. An edit made meanwhile
   * would be replaced with it, so the list holds still until it lands.
   */
  busy?: boolean | undefined;
}) {
  const { untaggedNumbers, blankNumbers } = form;
  return (
    <fieldset
      disabled={locked || busy}
      className="space-y-3"
      data-tour={TOUR_SELECTORS.wizardPrompts}
    >
      {locked && <LockLine />}
      {form.prompts.map((prompt, index) => (
        <div
          key={prompt.key}
          className="flex items-start gap-3 rounded-md border border-input bg-background px-3 py-2.5 transition-colors focus-within:border-ring"
        >
          <Textarea
            aria-label={`Prompt ${index + 1}`}
            value={prompt.text}
            rows={1}
            className="autosize min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:ring-0"
            onChange={(e) => form.editPrompt(prompt.key, { text: e.target.value })}
          />
          <label
            className="num flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title="How many times this prompt is asked, per assistant, on each run"
          >
            Iterations
            <Input
              type="number"
              min={MIN_WIZARD_ITERATIONS}
              max={MAX_WIZARD_ITERATIONS}
              aria-label={`Iterations for prompt ${index + 1}`}
              value={prompt.iterations}
              onChange={(e) =>
                form.editPrompt(prompt.key, { iterations: clampIterations(e.target.value) })
              }
              className="h-7 w-14 border-input px-1 text-center text-xs shadow-none"
            />
          </label>
          <TagPicker
            value={prompt.tag}
            tags={form.tagChoices}
            ariaLabel={`Tag for prompt ${index + 1}`}
            className="shrink-0"
            onChange={(tag) => form.editPrompt(prompt.key, { tag })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Remove prompt ${index + 1}`}
            onClick={() => form.removePrompt(prompt.key)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-center border-dashed"
        onClick={form.addPrompt}
      >
        <Plus className="mr-1.5 size-3.5" />
        Add your own prompt
      </Button>
      {untaggedNumbers.length > 0 && (
        <p className="text-xs text-warn">
          {untaggedNumbers.length === 1
            ? `Prompt ${untaggedNumbers[0]} has no tag.`
            : `Prompts ${untaggedNumbers.join(", ")} have no tags.`}{" "}
          Every prompt needs one. Tags are how the Prompts tab groups them. Pick visibility or
          comparison, or create your own.
        </p>
      )}
      {blankNumbers.length > 0 && (
        <p className="text-xs text-warn">
          {blankNumbers.length === 1
            ? `Prompt ${blankNumbers[0]} is empty and will not be saved. Fill it in or remove it.`
            : `${blankNumbers.length} prompts are empty and will not be saved. Fill them in or remove them.`}
        </p>
      )}
    </fieldset>
  );
}
