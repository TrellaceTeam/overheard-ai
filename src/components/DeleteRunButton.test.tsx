// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { DeleteRunButton } from "./DeleteRunButton";
import { installDomStubs } from "./test-helpers";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

beforeAll(installDomStubs);
afterEach(() => vi.useRealTimers());

describe("DeleteRunButton", () => {
  it("needs two confirmations before the delete runs", () => {
    const onDelete = vi.fn();
    render(<DeleteRunButton label="20 Sep" onDelete={onDelete} onDeleted={() => {}} />);

    fireEvent.click(screen.getByLabelText("Delete run from 20 Sep"));
    expect(screen.getByText("Delete this run permanently?")).toBeDefined();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Delete it for good?")).toBeDefined();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("keeps the run when the first dialog is dismissed", () => {
    const onDelete = vi.fn();
    render(<DeleteRunButton label="20 Sep" onDelete={onDelete} onDeleted={() => {}} />);
    fireEvent.click(screen.getByLabelText("Delete run from 20 Sep"));
    fireEvent.click(screen.getByRole("button", { name: "Keep run" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  /**
   * Radix keeps the dialog portal mounted through its close animation, so the
   * parent is told only after the dialogs have closed and had time to finish.
   */
  it("waits for the dialogs to close before telling the parent", () => {
    vi.useFakeTimers();
    const onDeleted = vi.fn();
    const { rerender } = render(
      <DeleteRunButton label="20 Sep" onDelete={() => {}} onDeleted={onDeleted} />,
    );
    rerender(<DeleteRunButton label="20 Sep" onDelete={() => {}} deleted onDeleted={onDeleted} />);
    expect(onDeleted).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});

describe("DeleteRunButton locked (demo project)", () => {
  it("disables the trigger and says why", () => {
    render(
      <DeleteRunButton
        label="20 Sep"
        onDelete={() => {}}
        onDeleted={() => {}}
        locked="The demo project is browse-only."
      />,
    );
    const trigger = screen.getByRole("button", { name: /Delete run from 20 Sep/ });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("title")).toBe("The demo project is browse-only.");
  });
});
