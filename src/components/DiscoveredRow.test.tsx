// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DiscoveredRow } from "./DiscoveredRow";

afterEach(cleanup);

const noop = () => {};

describe("DiscoveredRow", () => {
  it("shows the name and the mention rate", () => {
    render(
      <DiscoveredRow
        name="Northwind Metrics"
        mentionRate={0.42}
        mentions={21}
        onTrack={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("Northwind Metrics")).toBeDefined();
    expect(screen.getByText("42%")).toBeDefined();
  });

  it("shows the times mentioned beside the rate", () => {
    render(
      <DiscoveredRow
        name="Northwind Metrics"
        mentionRate={0.42}
        mentions={21}
        onTrack={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("21")).toBeDefined();
    expect(screen.getByText(/times/)).toBeDefined();
  });

  it("reads as one mention, not nothing, when a small rate rounds to 0%", () => {
    const { container } = render(
      <DiscoveredRow
        name="Barely There"
        mentionRate={0.004}
        mentions={1}
        onTrack={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("0%")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText(/time\b/)).toBeDefined();
    expect(container.textContent).toContain("Mentioned");
  });

  it("shows n/a for a brand nothing has measured yet", () => {
    render(
      <DiscoveredRow name="Stray" mentionRate={null} mentions={0} onTrack={noop} onDelete={noop} />,
    );
    expect(screen.getByText("n/a")).toBeDefined();
    expect(screen.getByText("0")).toBeDefined();
  });

  it("calls through on Track", () => {
    const onTrack = vi.fn();
    render(
      <DiscoveredRow
        name="Stray"
        mentionRate={0.1}
        mentions={2}
        onTrack={onTrack}
        onDelete={noop}
      />,
    );
    fireEvent.click(screen.getByText("Track"));
    expect(onTrack).toHaveBeenCalledTimes(1);
  });

  it("deletes only after the confirm dialog", () => {
    const onDelete = vi.fn();
    render(
      <DiscoveredRow
        name="Stray"
        mentionRate={0.1}
        mentions={2}
        onTrack={noop}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByLabelText("Delete Stray"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete permanently"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("disables Track while the role change is in flight", () => {
    render(
      <DiscoveredRow
        name="Stray"
        mentionRate={0.1}
        mentions={2}
        busy
        onTrack={noop}
        onDelete={noop}
      />,
    );
    expect((screen.getByRole("button", { name: /Track/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("locks Track and delete for the demo project, and says why", () => {
    render(
      <DiscoveredRow
        name="Stray"
        mentionRate={0.1}
        mentions={2}
        locked="The demo project is read-only"
        onTrack={noop}
        onDelete={noop}
      />,
    );
    const track = screen.getByRole("button", { name: /Track/i }) as HTMLButtonElement;
    expect(track.disabled).toBe(true);
    expect(track.title).toBe("The demo project is read-only");
  });
});
