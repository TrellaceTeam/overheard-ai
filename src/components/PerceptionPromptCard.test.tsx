// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PerceptionPromptCard } from "./PerceptionPromptCard";
import { defaultPerceptionPrompt } from "@/lib/onboarding";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

const prefilled = defaultPerceptionPrompt("Acme Analytics");
const edit = "What do assistants say about Acme Analytics?";

type CardProps = Parameters<typeof PerceptionPromptCard>[0];

function card(props: Partial<CardProps> = {}) {
  return render(
    <PerceptionPromptCard
      value={prefilled}
      edited={false}
      onChange={() => {}}
      onReset={() => {}}
      {...props}
    />,
  );
}

describe("PerceptionPromptCard", () => {
  it("shows the pre-filled prompt, ready to edit", () => {
    card();
    expect(screen.getByLabelText("Perception prompt")).toHaveProperty("value", prefilled);
  });

  it("hands every edit to its owner", () => {
    const onChange = vi.fn();
    card({ onChange });
    fireEvent.change(screen.getByLabelText("Perception prompt"), { target: { value: edit } });
    expect(onChange).toHaveBeenCalledWith(edit);
  });

  it("offers no reset while the prompt is untouched", () => {
    card();
    expect(screen.queryByRole("button", { name: "Reset to template" })).toBeNull();
  });

  it("offers Reset to template once the prompt is edited", () => {
    const onReset = vi.fn();
    card({ value: edit, edited: true, onReset });
    fireEvent.click(screen.getByRole("button", { name: "Reset to template" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("warns when the prompt is only whitespace", () => {
    card({ value: "  \n\t ", edited: true });
    expect(screen.getByText(/The perception prompt cannot be blank/)).toBeDefined();
  });

  it("says nothing about blanks while there is a prompt", () => {
    card({ value: edit, edited: true });
    expect(screen.queryByText(/cannot be blank/)).toBeNull();
  });
});
