// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DemoProjectSection } from "./DemoProjectSection";

afterEach(cleanup);

describe("DemoProjectSection", () => {
  it("enables Restore only when the demo is definitely missing", () => {
    const onRestore = vi.fn();
    const { rerender } = render(
      <DemoProjectSection
        exists={null}
        busy={false}
        onRestore={onRestore}
        onRunTutorial={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: /Restore demo project/ });
    expect(button.hasAttribute("disabled")).toBe(true);

    rerender(
      <DemoProjectSection
        exists={true}
        busy={false}
        onRestore={onRestore}
        onRunTutorial={() => {}}
      />,
    );
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/already in your project list/)).toBeDefined();

    rerender(
      <DemoProjectSection
        exists={false}
        busy={false}
        onRestore={onRestore}
        onRunTutorial={() => {}}
      />,
    );
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("stays shut and says Restoring while a restore is in flight", () => {
    render(
      <DemoProjectSection
        exists={false}
        busy={true}
        onRestore={() => {}}
        onRunTutorial={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: /Restoring/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("says what Restore does while the demo is missing", () => {
    render(
      <DemoProjectSection
        exists={false}
        busy={false}
        onRestore={() => {}}
        onRunTutorial={() => {}}
      />,
    );
    expect(screen.getByText("Six months of invented results to browse")).toBeDefined();
    expect(
      screen.getByText("Recreates the demo project and its six months of invented history."),
    ).toBeDefined();
  });
});

describe("DemoProjectSection tutorial button", () => {
  it("offers Run tutorial again whatever the demo state, because it reuses or recreates", () => {
    const onRunTutorial = vi.fn();
    const { rerender } = render(
      <DemoProjectSection
        exists={true}
        busy={false}
        onRestore={() => {}}
        onRunTutorial={onRunTutorial}
      />,
    );
    const button = screen.getByRole("button", { name: /Run tutorial again/ });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onRunTutorial).toHaveBeenCalledTimes(1);

    rerender(
      <DemoProjectSection
        exists={false}
        busy={false}
        onRestore={() => {}}
        onRunTutorial={onRunTutorial}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Run tutorial again/ }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
