// @vitest-environment jsdom
/**
 * One library card: the status badge, the lock a prompt with answers earns,
 * and the controls for on/off, iterations, tag, archive and delete.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptCard, type PromptCardPrompt } from "./PromptCard";
import { DEMO_READONLY_REASON } from "./DemoReadOnlyNote";

afterEach(cleanup);

const prompt = (over: Partial<PromptCardPrompt> = {}): PromptCardPrompt => ({
  id: "p1",
  text: "What is the best analytics tool?",
  is_active: 1,
  iterations: 5,
  category: "visibility",
  ...over,
});

function renderCard(props: Partial<Parameters<typeof PromptCard>[0]> = {}) {
  const callbacks = {
    onPatch: vi.fn(),
    onClone: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <PromptCard
      prompt={prompt()}
      answers={0}
      isDemo={false}
      identical={false}
      tags={["visibility"]}
      maxChars={2000}
      resultsFold={null}
      {...callbacks}
      {...props}
    />,
  );
  return callbacks;
}

describe("the status badge", () => {
  it("says On for a prompt the next run asks", () => {
    renderCard();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
  });

  it("says Off for one it keeps for later", () => {
    renderCard({ prompt: prompt({ is_active: 0 }) });
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByText("On")).toBeNull();
  });

  it("counts the answers beside it, including zero", () => {
    renderCard({ answers: 0 });
    expect(screen.getByText("no answers yet")).toBeTruthy();
    cleanup();
    renderCard({ answers: 12 });
    expect(screen.getByText("12 answers")).toBeTruthy();
  });
});

describe("the lock", () => {
  it("locks the text and offers a clone once the prompt has answers", () => {
    const callbacks = renderCard({ answers: 3 });
    const question = screen.getByLabelText("Prompt text") as HTMLTextAreaElement;
    expect(question.readOnly).toBe(true);
    expect(screen.getByText(/Locked because it has answers/)).toBeTruthy();
    fireEvent.click(screen.getByText("Clone to edit"));
    expect(callbacks.onClone).toHaveBeenCalledWith("p1");
  });

  it("keeps the text editable with no answers", () => {
    renderCard({ answers: 0 });
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("on the demo project locks with the demo reason and disables every control", () => {
    renderCard({ isDemo: true });
    expect(screen.getByText(DEMO_READONLY_REASON)).toBeTruthy();
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(true);
    // One fieldset locks the row's controls, the way the page locks the screen.
    const controls = screen.getByRole("button", { name: /Archive/ }).closest("fieldset");
    expect(controls?.disabled).toBe(true);
  });
});

describe("the controls", () => {
  it("switches the prompt on and off", () => {
    const callbacks = renderCard();
    fireEvent.click(screen.getByLabelText("On"));
    expect(callbacks.onPatch).toHaveBeenCalledWith("p1", { isActive: false });
  });

  it("saves iterations on blur", () => {
    const callbacks = renderCard();
    const iterations = screen.getByLabelText("Iterations");
    fireEvent.change(iterations, { target: { value: "8" } });
    fireEvent.blur(iterations);
    expect(callbacks.onPatch).toHaveBeenCalledWith("p1", { iterations: 8 });
  });

  it("archives and deletes through the callbacks", () => {
    const callbacks = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Archive/ }));
    expect(callbacks.onArchive).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(callbacks.onDelete).toHaveBeenCalledWith("p1");
  });

  it("saves an edited question on blur, and only an edited one", () => {
    const callbacks = renderCard();
    const question = screen.getByLabelText("Prompt text");
    fireEvent.blur(question);
    expect(callbacks.onPatch).not.toHaveBeenCalled();
    fireEvent.change(question, { target: { value: "Which tool is cheapest?" } });
    fireEvent.blur(question);
    expect(callbacks.onPatch).toHaveBeenCalledWith("p1", { text: "Which tool is cheapest?" });
  });

  it("warns on a switch the server would refuse", () => {
    renderCard({ identical: true, prompt: prompt({ is_active: 0 }) });
    expect(
      screen.getByText("Edit before turning on: it is identical to another prompt"),
    ).toBeTruthy();
  });
});

describe("the tag chip", () => {
  it("is the picker on a live project, named for screen readers and slotted by hash", () => {
    renderCard();
    const chip = screen.getByRole("combobox", { name: "Tag: visibility. Change tag" });
    expect(chip.getAttribute("data-tag-color")).toMatch(/^[1-6]$/);
    expect(chip.textContent).toContain("visibility");
  });

  it("on the demo project renders static at full contrast, outside the dimmed fieldset", () => {
    renderCard({ isDemo: true });
    // The tag is still readable text, and it sits outside the locked fieldset.
    expect(screen.getByText("visibility").closest("fieldset")).toBeNull();
    // No picker control survives in the demo.
    expect(screen.queryByRole("combobox", { name: /Tag:/ })).toBeNull();
    // The switch beside the badge is dead on the demo, with the reason on it.
    const sw = screen.getByLabelText("On") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.title).toBe(DEMO_READONLY_REASON);
  });

  it("paints the same tag the same way on every card", () => {
    renderCard();
    const first = screen.getByRole("combobox", { name: /Tag:/ }).getAttribute("data-tag-color");
    cleanup();
    renderCard({ prompt: prompt({ id: "p2" }) });
    const second = screen.getByRole("combobox", { name: /Tag:/ }).getAttribute("data-tag-color");
    expect(second).toBe(first);
  });
});
