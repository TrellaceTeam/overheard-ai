import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/error-text";
import { firstLaunchDestination, isTutorialState } from "@/lib/launch";
import { mostRecentProject } from "@/server/api/projects";
import { tutorialState } from "@/server/api/tutorial";

/**
 * Owns the front door. It routes rather than renders: the tutorial until it is
 * done, then the most recently updated project, then the wizard when there is
 * none.
 *
 * The tutorial state comes from app_state. Migration 0003 marks it done on a
 * database that already had projects, so returning users never land in it.
 *
 * Without the error branch, a database that will not open leaves this page on
 * "Opening your projects…" for good, with nothing to press.
 */
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [{ title: "Overheard AI" }],
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["most-recent-project"],
    queryFn: () => mostRecentProject(),
  });
  const tutorial = useQuery({ queryKey: ["tutorial-state"], queryFn: () => tutorialState() });

  useEffect(() => {
    // Wait for both reads: navigating on the projects query alone would skip
    // an interrupted tutorial whenever that query happened to win the race.
    if (isPending || !data || tutorial.isPending) return;
    // An unreadable tutorial state reads as done: a failed query must not trap
    // a returning user at the front door (isTutorialState guards the cast).
    const destination = firstLaunchDestination({
      tutorialState: isTutorialState(tutorial.data) ? tutorial.data : "done",
      mostRecentProjectId: data.projectId,
    });
    if (destination.to === "project") {
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: destination.projectId },
        replace: true,
      });
      return;
    }
    // Both the tutorial and New project live on /start; the screen itself
    // knows which mode it is in from the same tutorial state.
    void navigate({ to: "/start", replace: true });
  }, [data, isPending, tutorial.data, tutorial.isPending, navigate]);

  if (isError) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-lg font-semibold">We could not open your database</h1>
        <p className="text-sm text-muted-foreground">
          {errorText(error, "Something went wrong reading your projects.")}
        </p>
        <p className="text-xs text-muted-foreground">
          Only one Overheard AI process can hold a database file at a time. If another copy is
          running, close it and try again.
        </p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </main>
    );
  }

  return (
    <main className="flex min-h-[60vh] items-center justify-center">
      <p className="num text-sm text-muted-foreground">Opening your projects…</p>
    </main>
  );
}
