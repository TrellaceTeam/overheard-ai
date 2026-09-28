// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DeletePromptDialog } from "./DeletePromptDialog";
import { installDomStubs } from "./test-helpers";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

beforeAll(installDomStubs);

const prompt = { id: "q1", text: "best analytics tools", archived: false, answers: 4 };

describe("DeletePromptDialog", () => {
  it("warns that the answers go too, and offers all three ways out", () => {
    const onCancel = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(
      <DeletePromptDialog
        prompt={prompt}
        onCancel={onCancel}
        onArchive={onArchive}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText("Delete this prompt?")).toBeDefined();
    expect(screen.getByText(/also deletes its answers/)).toBeDefined();
    expect(screen.getByText(/best analytics tools/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Archive instead/ }));
    expect(onArchive).toHaveBeenCalledWith("q1");
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("q1");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("offers no archive for a prompt that is already archived", () => {
    render(
      <DeletePromptDialog
        prompt={{ ...prompt, archived: true }}
        onCancel={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Archive instead/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("stays closed with no prompt", () => {
    render(
      <DeletePromptDialog
        prompt={null}
        onCancel={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.queryByText("Delete this prompt?")).toBeNull();
  });
});
