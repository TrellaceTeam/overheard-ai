import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Activity } from "lucide-react";

import appCss from "@/styles.css?url";
import faviconBlack from "@/assets/favicon-black.webp?url";
import faviconWhite from "@/assets/favicon-white.webp?url";
import { Toaster } from "@/components/ui/sonner";
import { AppMenu } from "@/components/AppMenu";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { ScheduledRunNotices } from "@/components/ScheduledRunNotices";
import { TourProvider } from "@/components/TutorialTour";
import { listProjects } from "@/server/api/projects";
import { quitApp } from "@/server/api/settings";

/**
 * Owns the document: the head, the stylesheet, the query client every screen
 * reads through, the toaster and the scheduled-run notices it shows, and the
 * two whole-page fallbacks.
 *
 * The sticky header sits here because /start and /settings need the project
 * switcher as much as a project route does, and the root is the ancestor all
 * of them share.
 */
function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="num text-6xl font-semibold tracking-tight text-muted-foreground">404</p>
        <h1 className="type-title mt-4">Page not found</h1>
        <p className="type-meta mt-2">This page does not exist, or it moved.</p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  // Console only: a local-first tool does not report its crashes anywhere.
  console.error(error);
  const router = useRouter();
  const message = error instanceof Error ? error.message : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="type-title">This page did not load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {message || "The browser console has the details. Try again, or go home."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              void router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Overheard AI" },
      {
        name: "description",
        content:
          "Track whether AI assistants recommend your brand, where you rank, and who they cite instead. Local-first, on your own provider keys.",
      },
      { property: "og:title", content: "Overheard AI" },
      {
        property: "og:description",
        content:
          "Track whether AI assistants recommend your brand, where you rank, and who they cite instead. Local-first, on your own provider keys.",
      },
      { property: "og:type", content: "website" },
    ],
    // No font CDN and no analytics: Inter is vendored and imported by
    // styles.css, so the app starts with no network.
    links: [
      { rel: "stylesheet", href: appCss },
      // Chromium picks the icon by media. Firefox ignores media on icons and
      // takes the last one, so the black mark goes last: it stays legible on a
      // light tab strip, and Safari backs a dark icon in dark mode.
      {
        rel: "icon",
        type: "image/webp",
        href: faviconWhite,
        media: "(prefers-color-scheme: dark)",
      },
      {
        rel: "icon",
        type: "image/webp",
        href: faviconBlack,
        media: "(prefers-color-scheme: light)",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  // The tour walks from the setup screen into the demo's pages as one tour, so
  // it mounts above every route and the router hooks tell it where the reader is.
  const navigate = useNavigate();
  const location = useLocation();
  // Loose params: this renders above every route, including ones with no
  // projectId.
  const params = useParams({ strict: false }) as Record<string, string | undefined>;

  return (
    <QueryClientProvider client={queryClient}>
      <TourProvider
        // Cast: the tour navigates by route ids checked against its own step
        // list. The router's template-literal types cannot see that through a
        // plain string.
        navigate={(opts) => void navigate(opts as unknown as Parameters<typeof navigate>[0])}
        pathname={location.pathname}
        {...(params["projectId"] === undefined ? {} : { activeProjectId: params["projectId"] })}
      >
        <AppShell>
          <Outlet />
        </AppShell>
      </TourProvider>
      <Toaster position="top-right" />
      <ScheduledRunNotices />
    </QueryClientProvider>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const activeProjectId = params["projectId"];

  const { data: projects, isPending } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
  });

  return (
    <div className="flex min-h-screen flex-col">
      <ConnectionBanner />
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-6">
          <AppMenu
            projects={(projects ?? []).map((project) => ({ id: project.id, name: project.name }))}
            {...(activeProjectId === undefined ? {} : { activeProjectId })}
            loading={isPending}
            onQuit={() => quitApp()}
          />
          <Link
            to="/"
            className="flex items-center gap-2 rounded py-0.5 text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Activity className="size-4 text-primary" />
            Overheard AI
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
