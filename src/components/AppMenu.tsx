import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Menu, Plus, Power, Settings } from "lucide-react";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AppLink } from "@/components/AppLink";
import { TrellaceCredit } from "@/components/TrellaceCredit";
import { TOUR_SELECTORS, useTour } from "@/components/TutorialTour";
import type { ProjectSummary } from "@/components/types";
import { errorText } from "@/lib/error-text";

/**
 * The navigation drawer: the project switcher, the way in to a new project,
 * account settings and Quit. The current project's tabs are not repeated here
 * because the project shell shows them on every page.
 *
 * Quit is here because an Overheard AI the icon started has no console, so
 * the app is the one place left to stop it.
 */
export function AppMenu({
  projects,
  activeProjectId,
  loading = false,
  onQuit,
}: {
  projects: ProjectSummary[];
  /** Undefined outside a project route. The menu is mounted on every page. */
  activeProjectId?: string | undefined;
  loading?: boolean | undefined;
  /** Stops the app. The shell owns the server call. */
  onQuit: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [stopped, setStopped] = useState(false);

  async function quit() {
    setQuitting(true);
    try {
      await onQuit();
      setConfirmingQuit(false);
      setStopped(true);
    } catch (error) {
      toast.error(errorText(error, "Could not quit Overheard AI"));
    } finally {
      setQuitting(false);
    }
  }

  // The tour's last popup rings the New project entry inside the drawer, so
  // the drawer opens for it and closes when the step moves on. A manual close
  // in between stays manual: the stage flag did not change, so nothing reopens.
  const { menuStage, close: closeTour } = useTour();
  const openedByTour = useRef(false);
  useEffect(() => {
    if (menuStage) {
      setOpen(true);
      openedByTour.current = true;
    } else if (openedByTour.current) {
      setOpen(false);
      openedByTour.current = false;
    }
  }, [menuStage]);

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open menu">
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-80 flex-col gap-0 p-0">
          <SheetHeader className="border-b border-border px-5 py-4 text-left">
            <SheetTitle className="text-sm font-semibold">Projects</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {loading && (
              <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </p>
            )}
            {!loading && projects.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">No projects yet.</p>
            )}
            <nav className="space-y-1">
              {projects.map((project) => {
                const active = project.id === activeProjectId;
                return (
                  <AppLink
                    key={project.id}
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    onClick={close}
                    className={`flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent ${
                      active ? "bg-accent font-medium text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <span className="truncate">{project.name}</span>
                    {active && <Check className="size-4 shrink-0 text-primary" />}
                  </AppLink>
                );
              })}
            </nav>

            {/* The tour's last popup spotlights this entry as the door out. */}
            <AppLink
              to="/start"
              onClick={() => {
                close();
                // Ends the tour now. Leaving the demo route would end it too, but
                // only once the route change lands.
                closeTour();
              }}
              data-tour={TOUR_SELECTORS.newProject}
              className="mt-2 flex items-center gap-2 rounded-md px-2 py-2 text-sm text-primary transition-colors hover:bg-accent"
            >
              <Plus className="size-4" />
              New project
            </AppLink>
          </div>

          <div className="space-y-1 border-t border-border px-3 py-3">
            <AppLink
              to="/settings"
              onClick={close}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Settings className="size-4" />
              Account settings
            </AppLink>
            <button
              type="button"
              onClick={() => {
                close();
                setConfirmingQuit(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Power className="size-4" />
              Quit Overheard AI
            </button>
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              <TrellaceCredit />
            </p>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmingQuit} onOpenChange={(o) => !o && setConfirmingQuit(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quit Overheard AI?</AlertDialogTitle>
            <AlertDialogDescription>
              Runs and schedules stop until you open it again. A run in progress picks up where it
              left off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={quitting}>Keep running</AlertDialogCancel>
            <AlertDialogAction
              disabled={quitting}
              onClick={(e) => {
                e.preventDefault();
                void quit();
              }}
            >
              {quitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Quit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {stopped && (
        <div
          role="status"
          className="fixed inset-0 z-50 grid place-items-center bg-background p-6 text-center"
        >
          <div className="max-w-sm space-y-2">
            <p className="text-lg font-semibold">Overheard AI has stopped</p>
            <p className="text-sm text-muted-foreground">
              You can close this tab. Open Overheard AI again whenever you need it.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
