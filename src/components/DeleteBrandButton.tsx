import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
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

/**
 * The confirmation in front of deleting a brand.
 *
 * Deleting a brand removes its metric rows from every past run and re-scores
 * those runs as if it had never been tracked. None of that is recoverable, and
 * the trash icon sits next to Track in a list of a dozen names.
 *
 * Untrack is offered ahead of Delete wherever it applies, because it is what
 * someone clearing up a list nearly always means: the brand stops appearing in
 * comparisons and keeps its history.
 */
export function DeleteBrandButton({
  brandName,
  tracked = false,
  onDelete,
  onUntrack,
  deleting = false,
  locked = null,
}: {
  brandName: string;
  /** True for a tracked competitor, which is the case where Untrack applies. */
  tracked?: boolean | undefined;
  onDelete: () => void;
  /** Demote to discovered instead. Omitted when the brand is already there. */
  onUntrack?: (() => void) | undefined;
  deleting?: boolean | undefined;
  /** When set, deleting is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={`Delete ${brandName}`}
        title={locked ?? `Delete ${brandName}`}
        disabled={locked !== null}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </button>

      <AlertDialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
        {/* Three buttons whose labels carry the brand name need more room
            than the default card: wide enough for one row on desktop, and
            the footer still wraps for names longer than the card. */}
        <AlertDialogContent className="sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {brandName} permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases every measurement of {brandName} in every run so far, and recalculates
              your own rates without those answers. This cannot be undone.
              {tracked
                ? " Untracking keeps all of it and only stops the brand appearing in comparisons."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep {brandName}</AlertDialogCancel>
            {tracked && onUntrack && (
              <AlertDialogAction
                disabled={deleting}
                onClick={(event) => {
                  event.preventDefault();
                  setOpen(false);
                  onUntrack();
                }}
              >
                Untrack instead
              </AlertDialogAction>
            )}
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                setOpen(false);
                onDelete();
              }}
            >
              {deleting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
