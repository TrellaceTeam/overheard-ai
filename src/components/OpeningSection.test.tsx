// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OpeningSection } from "./OpeningSection";

afterEach(cleanup);

describe("OpeningSection", () => {
  it("tells you how to add the icon", () => {
    render(<OpeningSection on={true} readFailed={false} saving={false} onChange={() => {}} />);
    expect(screen.getByText("npm run shortcut")).toBeDefined();
  });

  it("says a rebuild uses only the code in the folder while the switch is on", () => {
    render(<OpeningSection on={true} readFailed={false} saving={false} onChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "Rebuild after the code changes" })).toBeDefined();
    expect(
      screen.getByText(
        "Rebuilds only the code already in this folder, for example after you run git pull. It never checks for or downloads updates.",
      ),
    ).toBeDefined();
  });

  it("turns the rebuild off from the switch, and says what that leaves to you", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OpeningSection on={true} readFailed={false} saving={false} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Rebuild after the code changes" }));
    expect(onChange).toHaveBeenCalledWith(false);

    rerender(<OpeningSection on={false} readFailed={false} saving={false} onChange={onChange} />);
    expect(
      screen.getByText(
        "The icon starts the last build as it is. After you change or update the code, run npm run build yourself.",
      ),
    ).toBeDefined();
  });

  it("says so when the setting cannot be read, instead of showing a switch", () => {
    render(<OpeningSection on={null} readFailed={true} saving={false} onChange={() => {}} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.getByText("We could not read the rebuild setting just now. Reload to try again."),
    ).toBeDefined();
  });
});
