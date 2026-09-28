// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DemoNotice } from "./DemoNotice";

afterEach(cleanup);

describe("DemoNotice", () => {
  it("says the data is invented and not about the companies named", () => {
    render(<DemoNotice />);
    expect(screen.getByText("Demo project: invented data")).toBeDefined();
    expect(screen.getByText(/None of it was measured/)).toBeDefined();
  });

  it("is a note landmark the tour can point at", () => {
    const { container } = render(<DemoNotice />);
    expect(container.querySelector('[data-tour="demo-notice"]')).not.toBeNull();
    expect(screen.getByRole("note")).toBeDefined();
  });
});
