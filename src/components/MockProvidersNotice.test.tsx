// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MockProvidersNotice } from "./MockProvidersNotice";

afterEach(cleanup);

describe("MockProvidersNotice", () => {
  it("names the variable and says nothing on screen was measured", () => {
    render(<MockProvidersNotice />);
    expect(screen.getByText("Mock providers are on")).toBeDefined();
    expect(screen.getByText(/OVERHEARD_MOCK_PROVIDERS/)).toBeDefined();
    expect(screen.getByText(/canned test data/)).toBeDefined();
  });
});
