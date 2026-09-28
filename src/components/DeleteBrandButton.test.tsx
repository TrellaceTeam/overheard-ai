// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DeleteBrandButton } from "./DeleteBrandButton";

afterEach(cleanup);

describe("DeleteBrandButton", () => {
  it("does not delete on the first click", () => {
    // The trash icon sits beside Track in a list of a dozen discovered names,
    // and the delete removes every metric row the brand ever had.
    const onDelete = vi.fn();
    render(<DeleteBrandButton brandName="Globex Search" onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Globex Search" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete Globex Search permanently?")).toBeDefined();
  });

  it("names what goes with the brand", () => {
    render(<DeleteBrandButton brandName="Globex Search" onDelete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Globex Search" }));
    expect(screen.getByText(/every measurement of Globex Search in every run/)).toBeDefined();
  });

  it("deletes once confirmed", () => {
    const onDelete = vi.fn();
    render(<DeleteBrandButton brandName="Globex Search" onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Globex Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("offers untrack for a tracked competitor, which keeps the history", () => {
    const onUntrack = vi.fn();
    const onDelete = vi.fn();
    render(
      <DeleteBrandButton
        brandName="Northwind Metrics"
        tracked
        onDelete={onDelete}
        onUntrack={onUntrack}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Northwind Metrics" }));
    fireEvent.click(screen.getByRole("button", { name: "Untrack instead" }));
    expect(onUntrack).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does not offer untrack for a brand that is only discovered", () => {
    render(<DeleteBrandButton brandName="Fabrikam Labs" onDelete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Fabrikam Labs" }));
    expect(screen.queryByRole("button", { name: "Untrack instead" })).toBeNull();
  });
});

describe("DeleteBrandButton locked (demo project)", () => {
  it("disables the trigger and says why", () => {
    render(
      <DeleteBrandButton
        brandName="Globex Search"
        onDelete={() => {}}
        locked="The demo project is browse-only."
      />,
    );
    const trigger = screen.getByRole("button", { name: /Delete Globex Search/ });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("title")).toBe("The demo project is browse-only.");
  });
});
