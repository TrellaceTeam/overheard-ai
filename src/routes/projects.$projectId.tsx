/**
 * Owns the project shell: the project name and the four tab links. The header
 * with the project switcher and the tutorial tour both mount at the app root,
 * where the tour survives the walk from the setup screen into these pages.
 */
import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DemoNotice } from "@/components/DemoNotice";
import { TOUR_SELECTORS } from "@/components/TutorialTour";
import { getProject } from "@/server/api/projects";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

export const TABS = [
  {
    to: "/projects/$projectId",
    label: "Dashboard",
    exact: true,
    tour: TOUR_SELECTORS.tabDashboard,
  },
  {
    to: "/projects/$projectId/prompts",
    label: "Prompts",
    exact: false,
    tour: TOUR_SELECTORS.tabPrompts,
  },
  {
    to: "/projects/$projectId/competitors",
    label: "Competitors",
    exact: false,
    tour: TOUR_SELECTORS.tabCompetitors,
  },
  {
    to: "/projects/$projectId/settings",
    label: "Project settings",
    exact: false,
    tour: TOUR_SELECTORS.tabSettings,
  },
] as const;

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const location = useLocation();

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: { projectId } }),
  });

  return (
    <div>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="type-title">{project?.name ?? "Project"}</h1>
        </div>

        {project?.isDemo && (
          <div className="mt-5">
            <DemoNotice />
          </div>
        )}

        <nav className="mt-5 flex flex-wrap gap-1 border-b border-border">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ projectId }}
              data-tour={tab.tour}
              activeOptions={{ exact: tab.exact }}
              className="-mb-px rounded-t border-b-2 border-transparent px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:border-primary data-[status=active]:font-medium data-[status=active]:text-foreground"
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="pb-4 pt-8">
          {/* One fade for every move inside the project, tab to tab or run to
              dashboard, keyed on the path so each navigation replays it.
              Without it the tour's page changes read as jump cuts. */}
          <div key={location.pathname} className="animate-in fade-in duration-200">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
