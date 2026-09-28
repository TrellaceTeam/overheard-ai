// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AvailabilityNotice, NO_KEY_CONFIGURED } from "./AvailabilityNotice";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

describe("AvailabilityNotice", () => {
  it("renders nothing once the feature is on", () => {
    const { container } = render(<AvailabilityNotice availability={{ state: "on" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps loading separate from a denial", () => {
    render(<AvailabilityNotice availability={{ state: "loading" }} />);
    expect(screen.getByText("Checking…")).toBeDefined();
  });

  it("offers a retry when the check itself failed", () => {
    const onRetry = vi.fn();
    render(
      <AvailabilityNotice
        availability={{ state: "unknown", reason: "We could not check this just now." }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("states the no-key case by naming the environment variables", () => {
    render(<AvailabilityNotice availability={{ state: "off", reason: NO_KEY_CONFIGURED }} />);
    expect(screen.getByText(/OPENAI_API_KEY/)).toBeDefined();
    expect(screen.getByText(/no need to restart/)).toBeDefined();
  });
});
