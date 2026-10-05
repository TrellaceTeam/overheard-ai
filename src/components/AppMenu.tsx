import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Menu, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AppLink } from "@/components/AppLink";
import { TrellaceCredit } from "@/components/TrellaceCredit";
import { TOUR_SELECTORS, useTour } from "@/components/TutorialTour";
import type { ProjectSummary } from "@/components/types";

/**
 * The navigation drawer: the project switcher, the way in to a new project, and
 * account settings. The current project's tabs are not repeated here because
 * the project shell shows them on every page.
 */
export function AppMenu({
  projects,
  activeProjectId,
  loading = false,
}: {
  projects: ProjectSummary[];
  /** Undefined outside a project route. The menu is mounted on every page. */
  activeProjectId?: string | undefined;
  loading?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

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
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            <TrellaceCredit />
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
