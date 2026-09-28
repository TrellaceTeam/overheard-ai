import { useEffect, useRef, useState } from "react";
import { Trash2, Loader2 } from "lucide-react";
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
 * A two-step confirmation for deleting a run. The route runs the delete and
 * reports success back through `deleted`.
 */
export function DeleteRunButton({
  label,
  onDelete,
  deleting = false,
  deleted = false,
  onDeleted,
  locked = null,
}: {
  /** How the run is described in the dialogs, usually its start time. */
  label: string;
  /** Runs the delete. The route owns the server call and the toast. */
  onDelete: () => void;
  deleting?: boolean | undefined;
  /** True once the delete has succeeded. Drives the hand-back below. */
  deleted?: boolean | undefined;
  /** Called after the dialogs have closed and their exit animation has run. */
  onDeleted: () => void;
  /** When set, deleting is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const notified = useRef(false);

  // Close both dialogs the moment the delete lands, so the exit animation
  // starts before the parent is told the row is gone.
  useEffect(() => {
    if (deleted) setStep(0);
  }, [deleted]);

  // Radix keeps the dialog portal mounted through its close animation. If the
  // parent drops this row in the meantime, React tries to remove nodes Radix
  // has already detached, which crashes the tree. So only tell the parent once
  // the dialogs are closed and their exit animation has had time to finish.
  useEffect(() => {
    if (!deleted || step !== 0 || notified.current) return;
    notified.current = true;
    const timer = setTimeout(() => onDeleted(), 350);
    return () => clearTimeout(timer);
  }, [deleted, step, onDeleted]);

  return (
    <>
      <button
        type="button"
        aria-label={`Delete run from ${label}`}
        title={locked ?? "Delete run"}
        disabled={locked !== null}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setStep(1);
        }}
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <AlertDialog open={step === 1} onOpenChange={(o) => !o && setStep(0)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases the run from {label}, with its answers, extractions and every metric it
              contributed. The dashboard and competitor numbers are recalculated without it. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep run</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setStep(2);
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={step === 2} onOpenChange={(o) => !o && setStep(0)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete it for good?</AlertDialogTitle>
            <AlertDialogDescription>
              Only a backup of the database file can bring this run back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                onDelete();
              }}
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
