/**
 * The small amount of setup the component smoke tests need.
 *
 * jsdom has no ResizeObserver, which Radix's popper layer and recharts'
 * ResponsiveContainer both construct on mount, and no layout, so every measured
 * box is zero. Neither is worth a full browser runner for what these tests
 * check: that a component mounts and puts its words on the screen.
 *
 * Not a test file. The vitest include pattern only picks up *.test.ts(x).
 */
import type { ReactNode } from "react";

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function installDomStubs(): void {
  const scope = globalThis as unknown as { ResizeObserver?: unknown };
  scope.ResizeObserver ??= StubResizeObserver;
  if (typeof Element !== "undefined") {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto["scrollIntoView"] ??= function scrollIntoView(): void {};
    proto["hasPointerCapture"] ??= function hasPointerCapture(): boolean {
      return false;
    };
    proto["releasePointerCapture"] ??= function releasePointerCapture(): void {};
    proto["setPointerCapture"] ??= function setPointerCapture(): void {};
  }
}

/** The shape the AppLink mock in a test file renders. */
export type StubLinkProps = {
  to: string;
  className?: string | undefined;
  children: ReactNode;
  "data-tour"?: string | undefined;
};

/** A router-free stand-in for AppLink, so a test needs no RouterProvider. */
export function StubLink({ to, className, children, ...rest }: StubLinkProps) {
  return (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  );
}
