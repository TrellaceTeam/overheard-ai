// @vitest-environment jsdom
/**
 * The tag picker's chip dressing: the chip is the trigger, named for screen
 * readers as the control it is, and slotted by the same hash the static chips
 * use. The select dressing is the plain trigger the wizard rows use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TagChip, TagPicker } from "./TagPicker";
import { tagColorSlot } from "@/lib/tag-colors";

afterEach(cleanup);

describe("TagPicker, chip variant", () => {
  it("is a combobox named after its tag, in the tag's palette slot", () => {
    render(
      <TagPicker variant="chip" value="visibility" tags={["visibility"]} onChange={vi.fn()} />,
    );
    const trigger = screen.getByRole("combobox", { name: "Tag: visibility. Change tag" });
    expect(trigger.getAttribute("data-tag-color")).toBe(String(tagColorSlot("visibility")));
    expect(trigger.textContent).toContain("visibility");
  });

  it("falls back to the plain label with no tag to name", () => {
    render(<TagPicker variant="chip" value={null} tags={[]} onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "Tag" });
    expect(trigger.getAttribute("data-tag-color")).toBe("0");
  });
});

describe("TagPicker, select variant", () => {
  it("keeps the plain trigger the wizard uses", () => {
    render(<TagPicker value="visibility" tags={["visibility"]} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Tag" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /Change tag/ })).toBeNull();
  });
});

describe("TagChip", () => {
  it("shows the tag in full, in its slot", () => {
    render(<TagChip tag="a very long tag name nobody would truncate in a heading" />);
    expect(
      screen.getByText("a very long tag name nobody would truncate in a heading"),
    ).toBeTruthy();
  });

  it("reads Untagged in the neutral slot for a row with no tag", () => {
    render(<TagChip tag={null} />);
    expect(screen.getByText("Untagged")).toBeTruthy();
  });
});
