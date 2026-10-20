// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AppMenu } from "./AppMenu";
import { TOUR_SELECTORS } from "./TutorialTour";
import { installDomStubs } from "./test-helpers";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

vi.mock("@/components/AppLink", async () => {
  const helpers = await import("./test-helpers");
  return { AppLink: helpers.StubLink };
});

beforeAll(installDomStubs);

const projects = [
  { id: "p1", name: "Acme Analytics" },
  { id: "p2", name: "Northwind Metrics" },
];

const noQuit = () => Promise.resolve();

function openMenu() {
  fireEvent.click(screen.getByLabelText("Open menu"));
}

describe("AppMenu", () => {
  it("lists every project and marks the active one", () => {
    render(<AppMenu projects={projects} activeProjectId="p2" onQuit={noQuit} />);
    openMenu();
    expect(screen.getByText("Acme Analytics")).toBeDefined();
    expect(screen.getByText("Northwind Metrics")).toBeDefined();
  });

  it("always offers New project, because there is no plan cap locally", () => {
    render(<AppMenu projects={projects} activeProjectId="p1" onQuit={noQuit} />);
    openMenu();
    expect(screen.getByText("New project")).toBeDefined();
  });

  it("carries the tour's hook on the New project entry itself", () => {
    // The tour's last popup opens the drawer and rings the entry inside it,
    // so the hook lives on the link, not on the button that opens the drawer.
    render(<AppMenu projects={projects} activeProjectId="p1" onQuit={noQuit} />);
    expect(screen.getByLabelText("Open menu").getAttribute("data-tour")).toBeNull();
    openMenu();
    expect(screen.getByText("New project").getAttribute("data-tour")).toBe(
      TOUR_SELECTORS.newProject,
    );
  });

  it("keeps account settings and does not repeat the project's own tabs", () => {
    render(<AppMenu projects={projects} activeProjectId="p1" onQuit={noQuit} />);
    openMenu();
    expect(screen.getByText("Account settings")).toBeDefined();
    for (const label of ["Dashboard", "Prompts", "Competitors", "Project settings"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("carries no account, billing or team entry", () => {
    render(<AppMenu projects={projects} activeProjectId="p1" onQuit={noQuit} />);
    openMenu();
    expect(screen.queryByText(/Billing/)).toBeNull();
    expect(screen.queryByText(/Sign out/)).toBeNull();
    expect(screen.queryByText(/Delete account/)).toBeNull();
  });

  it("quits only after a confirmation, then says the app has stopped", async () => {
    const onQuit = vi.fn(() => Promise.resolve({ ok: true }));
    render(<AppMenu projects={projects} activeProjectId="p1" onQuit={onQuit} />);
    openMenu();
    fireEvent.click(screen.getByText("Quit Overheard AI"));

    expect(screen.getByText("Quit Overheard AI?")).toBeDefined();
    expect(onQuit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Quit" }));
    expect(await screen.findByText("Overheard AI has stopped")).toBeDefined();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("keeps running when the confirmation is declined", () => {
    const onQuit = vi.fn(() => Promise.resolve({ ok: true }));
    render(<AppMenu projects={projects} activeProjectId="p1" onQuit={onQuit} />);
    openMenu();
    fireEvent.click(screen.getByText("Quit Overheard AI"));
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));

    expect(screen.queryByText("Quit Overheard AI?")).toBeNull();
    expect(screen.queryByText("Overheard AI has stopped")).toBeNull();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("credits the maintainer in the footer, linking to its site in a new tab", () => {
    render(<AppMenu projects={[]} loading={false} onQuit={noQuit} />);
    openMenu();
    const link = screen.getByRole("link", { name: "Trellace" });
    expect(link.parentElement?.textContent).toBe("Built by Trellace");
    expect(link.getAttribute("href")).toBe(
      "https://www.trellace.com/?utm_source=overheard-ai&utm_medium=app",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("No projects yet.")).toBeDefined();
  });
});
