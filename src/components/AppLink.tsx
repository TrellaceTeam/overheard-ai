import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/**
 * A router link whose target is a plain string.
 *
 * TanStack Router types `Link`'s `to` against the generated route tree, and a
 * component that takes its target as a prop cannot carry that type without
 * pulling the route tree into its signature. The cast happens once here and
 * every component links through it. A path that is not a route gets the
 * router's not-found page at runtime.
 */
export type AppLinkProps = {
  to: string;
  params?: Record<string, string> | undefined;
  className?: string | undefined;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  "aria-label"?: string | undefined;
  "data-tour"?: string | undefined;
  children: ReactNode;
};

const RouterLink = Link as unknown as (props: AppLinkProps) => ReactNode;

export function AppLink(props: AppLinkProps) {
  return <RouterLink {...props} />;
}
