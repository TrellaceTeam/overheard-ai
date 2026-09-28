// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BadgeInput } from "./BadgeInput";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

describe("BadgeInput", () => {
  it("renders one badge per entry with a remove control", () => {
    render(<BadgeInput value={["Acme Analytics", "Globex Search"]} onChange={() => {}} />);
    expect(screen.getByText("Acme Analytics")).toBeDefined();
    expect(screen.getByLabelText("Remove Globex Search")).toBeDefined();
  });

  it("commits the draft on Enter", () => {
    const onChange = vi.fn();
    render(<BadgeInput id="brands" value={[]} onChange={onChange} placeholder="Add a brand" />);
    const input = screen.getByPlaceholderText("Add a brand");
    fireEvent.change(input, { target: { value: "Fabrikam Labs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["Fabrikam Labs"]);
  });

  it("removes the last entry on Backspace in an empty field", () => {
    const onChange = vi.fn();
    render(
      <BadgeInput id="brands" value={["Acme Analytics", "Globex Search"]} onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith(["Acme Analytics"]);
  });

  it("reports the uncommitted draft, so a parent is not blind to it", () => {
    // Without this the wizard would treat a typed but uncommitted domain as an
    // empty field, keeping Continue disabled while the user can see the value.
    const onDraftChange = vi.fn();
    render(
      <BadgeInput
        id="domains"
        value={[]}
        onChange={() => {}}
        onDraftChange={onDraftChange}
        placeholder="acme.example.com"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("acme.example.com"), {
      target: { value: "acme.example.com" },
    });
    expect(onDraftChange).toHaveBeenCalledWith("acme.example.com");
  });

  it("says how to commit, but only while there is something to commit", () => {
    // The line stays in the layout and only its text appears, because
    // collapsing it would move the button underneath while it is being clicked.
    render(
      <BadgeInput id="domains" value={[]} onChange={() => {}} placeholder="acme.example.com" />,
    );
    const hint = screen.getByText("Press Enter or comma to add it.");
    expect(hint.className).toContain("invisible");
    fireEvent.change(screen.getByPlaceholderText("acme.example.com"), {
      target: { value: "acme.example.com" },
    });
    expect(screen.getByText("Press Enter or comma to add it.").className).not.toContain(
      "invisible",
    );
  });

  it("clears the draft it reports once the entry is committed", () => {
    const onDraftChange = vi.fn();
    render(
      <BadgeInput id="domains" value={[]} onChange={() => {}} onDraftChange={onDraftChange} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "acme.example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("disables the field once the cap is reached", () => {
    render(<BadgeInput value={["a", "b", "c"]} onChange={() => {}} maxItems={3} />);
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
  });
});
