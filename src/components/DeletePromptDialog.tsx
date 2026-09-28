import { Archive } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** The prompt the dialog asks about. Passing null keeps the dialog closed. */
export type PromptToDelete = {
  id: string;
  text: string;
  archived: boolean;
  /** Answers collected so far: a prompt with none has nothing else to lose. */
  answers: number;
};

/**
 * Confirms deleting a prompt and offers archiving, which keeps the data.
 * Deleting a prompt deletes its answers and re-scores the runs that asked it.
 * Archiving only hides it, so an archived prompt gets no "Archive instead".
 */
export function DeletePromptDialog({
  prompt,
  onCancel,
  onArchive,
  onDelete,
}: {
  prompt: PromptToDelete | null;
  onCancel: () => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <AlertDialog open={prompt !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this prompt?</AlertDialogTitle>
          <AlertDialogDescription>
            {prompt?.archived
              ? "Deleting it also deletes its answers. They stop counting in statistics, and the runs that asked it are re-scored without them."
              : prompt && prompt.answers === 0
                ? "It has no answers yet, so nothing else changes."
                : "Deleting it also deletes its answers. They stop counting in statistics, and the runs that asked it are re-scored without them. Archiving instead takes it out of the list, but keeps its results and they keep counting."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {prompt && <p className="line-clamp-3 text-sm text-muted-foreground">“{prompt.text}”</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {prompt && !prompt.archived && (
            <Button variant="outline" onClick={() => onArchive(prompt.id)}>
              <Archive className="size-4" /> Archive instead
            </Button>
          )}
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => prompt && onDelete(prompt.id)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
